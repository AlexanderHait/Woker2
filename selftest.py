#!/usr/bin/env python3
"""
Проверка серверной части: настройки, режимы отказа, дедупликация заявок,
нормализация телефона. Только стандартная библиотека.

    python3 selftest.py
"""

import http.client
import json
import threading
import time
import unittest
import urllib.error
import urllib.request

import server

PORT = 8099
BASE = 'http://127.0.0.1:%d' % PORT


def get(path):
    try:
        with urllib.request.urlopen(BASE + path, timeout=15) as res:
            return res.status, json.loads(res.read().decode('utf-8'))
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read().decode('utf-8'))


def post(path, payload):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'text/plain;charset=UTF-8'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return res.status, json.loads(res.read().decode('utf-8'))
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read().decode('utf-8'))


class ServerTest(unittest.TestCase):

    def tearDown(self):
        get('/api/_mode?target=config&mode=ok')
        get('/api/_mode?target=lead&mode=ok')
        server.lead_hits.clear()

    def test_config(self):
        status, body = get('/api/config?source=landing-tg')
        self.assertEqual(200, status)
        self.assertEqual(3, len(body['buttons']))
        self.assertEqual(4, len(body['form']['steps']))
        self.assertEqual('phone', body['form']['steps'][-1]['type'])
        self.assertEqual('light', body['theme'])
        self.assertEqual('widget_view', body['goals']['view'])

    def test_unknown_source(self):
        status, body = get('/api/config?source=nope')
        self.assertEqual(404, status)
        self.assertEqual([], body['buttons'])

    def test_broken_config(self):
        get('/api/_mode?target=config&mode=fail')
        self.assertEqual(500, get('/api/config?source=landing-tg')[0])
        get('/api/_mode?target=config&mode=empty')
        self.assertEqual([], get('/api/config?source=landing-tg')[1]['buttons'])

    def test_lead_is_stored_once(self):
        lead = {'id': 'selftest-%d' % time.time(), 'source': 'landing-tg',
                'phone': '8 (912) 345-67-89', 'answers': {'task': 'ads'}}
        status, first = post('/api/lead', lead)
        self.assertEqual(200, status)
        self.assertFalse(first['duplicate'])
        self.assertEqual('+79123456789', first['phone'])

        _, second = post('/api/lead', lead)
        self.assertTrue(second['duplicate'])

        leads = get('/api/_state')[1]['leads']
        self.assertEqual(1, len([row for row in leads if row['id'] == lead['id']]))

    def test_rejected_lead_keeps_connection_usable(self):
        """Отказ не должен оставлять тело запроса в сокете: иначе следующий запрос
        на том же соединении разберётся как мусор и виджет останется без настроек."""
        get('/api/_mode?target=lead&mode=fail')
        conn = http.client.HTTPConnection('127.0.0.1', PORT, timeout=10)
        conn.request('POST', '/api/lead',
                     body=json.dumps({'id': 'keepalive', 'phone': '+79990000000'}),
                     headers={'Content-Type': 'text/plain;charset=UTF-8'})
        first = conn.getresponse()
        first.read()
        self.assertEqual(503, first.status)

        conn.request('GET', '/api/config?source=landing-tg')
        second = conn.getresponse()
        payload = json.loads(second.read().decode('utf-8'))
        conn.close()
        self.assertEqual(200, second.status)
        self.assertEqual(3, len(payload['buttons']))

    def test_lead_without_id_rejected(self):
        self.assertEqual(400, post('/api/lead', {'phone': '+79990000000'})[0])

    def test_phone_normalization(self):
        cases = {
            '89123456789': '+79123456789',
            '+7 (912) 345-67-89': '+79123456789',
            '9123456789': '+79123456789',
            '+380 67 123 45 67': '+380671234567',
            '123': None,
            '0000000000': None,
            'позвоните мне': None,
        }
        for raw, expected in cases.items():
            self.assertEqual(expected, server.normalize_phone(raw), raw)

    def test_events_are_logged(self):
        cid = 'click-%d' % time.time()
        post('/api/event', {'kind': 'view', 'source': 'landing-tg', 'goal': 'widget_view'})
        post('/api/event', {'kind': 'click', 'cid': cid, 'source': 'landing-tg', 'button': 'tg',
                            'goal': 'click_telegram', 'tags': {'utm_source': 'yandex'}})
        events = get('/api/_state')[1]['events']
        self.assertTrue(any(row.get('cid') == cid and row['kind'] == 'click' for row in events))
        self.assertTrue(any(row['kind'] == 'view' for row in events))
        self.assertEqual(400, post('/api/event', {'kind': 'что-то своё'})[0])

    def test_suspicious_lead_is_kept_but_marked(self):
        """Заявку с признаками бота всё равно принимаем — решать должен человек."""
        lead = {'id': 'trap-%d' % time.time(), 'source': 'landing-tg',
                'phone': '+79990001122', 'trap': 'ООО Ромашка', 'elapsed_ms': 800}
        status, body = post('/api/lead', lead)
        self.assertEqual(200, status)
        self.assertTrue(body['suspicious'])
        row = [r for r in get('/api/_state')[1]['leads'] if r['id'] == lead['id']][0]
        self.assertEqual(['trap', 'too_fast'], row['suspicious'])

    def test_queued_lead_keeps_its_age(self):
        lead = {'id': 'aged-%d' % time.time(), 'source': 'landing-tg',
                'phone': '+79990003344', 'queued_ms': 7200000}
        post('/api/lead', lead)
        row = [r for r in get('/api/_state')[1]['leads'] if r['id'] == lead['id']][0]
        self.assertEqual(7200000, row['queued_ms'])

    def test_rate_limit(self):
        for i in range(server.LEAD_LIMIT + 2):
            status, _ = post('/api/lead', {'id': 'flood-%d-%d' % (time.time(), i),
                                           'phone': '+7999000%04d' % i})
            if status == 429:
                break
        self.assertEqual(429, status)
        server.lead_hits.clear()

    def test_widget_is_served_with_cors(self):
        with urllib.request.urlopen(BASE + '/widget.js', timeout=10) as res:
            body = res.read().decode('utf-8')
            self.assertEqual('*', res.headers['Access-Control-Allow-Origin'])
        self.assertIn('contactWidget', body)


def start_server():
    thread = threading.Thread(target=server.run, args=(PORT,), kwargs={'open_browser': False, 'verbose': False})
    thread.daemon = True
    thread.start()
    for _ in range(50):
        try:
            get('/api/_state')
            return
        except Exception:
            time.sleep(0.1)
    raise SystemExit('сервер не поднялся')


if __name__ == '__main__':
    start_server()
    unittest.main(verbosity=2)
