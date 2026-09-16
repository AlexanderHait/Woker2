#!/usr/bin/env python3
"""
Проверка серверной части: настройки, режимы отказа, дедупликация заявок,
нормализация телефона. Только стандартная библиотека.

    python3 selftest.py
"""

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

    def test_config(self):
        status, body = get('/api/config?source=landing-tg')
        self.assertEqual(200, status)
        self.assertEqual(3, len(body['buttons']))
        self.assertEqual(4, len(body['form']['steps']))
        self.assertEqual('phone', body['form']['steps'][-1]['type'])

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

    def test_click_is_logged(self):
        cid = 'click-%d' % time.time()
        post('/api/click', {'cid': cid, 'source': 'landing-tg', 'button': 'tg',
                            'goal': 'click_telegram', 'tags': {'utm_source': 'yandex'}})
        clicks = get('/api/_state')[1]['clicks']
        self.assertTrue(any(row['cid'] == cid for row in clicks))

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
