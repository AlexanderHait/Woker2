#!/usr/bin/env python3
"""
Демо-сервер виджета: отдаёт настройки источников, принимает клики и заявки.

Только стандартная библиотека, запуск одной командой:

    python3 server.py

Данные выдуманные и лежат в data/sources.json. Клики и заявки пишутся
в data/clicks.jsonl и data/leads.jsonl.
"""

import argparse
import json
import mimetypes
import os
import re
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, 'data')
SOURCES = os.path.join(DATA, 'sources.json')
LEADS = os.path.join(DATA, 'leads.jsonl')
CLICKS = os.path.join(DATA, 'clicks.jsonl')

MAX_BODY = 64 * 1024
PHONE_DIGITS = re.compile(r'\D+')

lock = threading.Lock()

# Состояние «сломанного сервера» для демо-страницы: ok | fail | slow | empty.
demo_mode = {'config': 'ok', 'lead': 'ok'}

# Идентификаторы уже принятых заявок — по ним отсекаем повторную отправку.
seen_leads = set()


def log_line(path, record):
    with lock:
        with open(path, 'a', encoding='utf-8') as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + '\n')


def tail(path, limit):
    if not os.path.exists(path):
        return []
    with open(path, encoding='utf-8') as fh:
        rows = fh.readlines()[-limit:]
    out = []
    for row in rows:
        try:
            out.append(json.loads(row))
        except ValueError:
            pass
    return out


def load_seen_leads():
    for row in tail(LEADS, 100000):
        if row.get('id'):
            seen_leads.add(row['id'])


def load_sources():
    with open(SOURCES, encoding='utf-8') as fh:
        return json.load(fh)


def normalize_phone(raw):
    """То же правило, что и в виджете: сервер не доверяет клиенту."""
    digits = PHONE_DIGITS.sub('', str(raw or ''))
    if len(digits) == 11 and digits.startswith('8'):
        digits = '7' + digits[1:]
    if len(digits) == 10 and digits[0] in '3456789':
        digits = '7' + digits
    if len(digits) < 8 or len(digits) > 15:
        return None
    if len(set(digits)) == 1:
        return None
    return '+' + digits


class Handler(BaseHTTPRequestHandler):
    server_version = 'contact-widget-demo'
    protocol_version = 'HTTP/1.1'

    # -------------------------------------------------------------- ответы

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.cors()
        self.end_headers()
        self.wfile.write(body)

    def cors(self):
        # Виджет живёт на чужих доменах, поэтому API открыт для любого origin.
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')

    def send_file(self, path):
        if not os.path.isfile(path):
            self.send_json({'error': 'not found'}, 404)
            return
        ctype = mimetypes.guess_type(path)[0] or 'application/octet-stream'
        if ctype.startswith('text/') or ctype in ('application/javascript', 'application/json'):
            ctype += '; charset=utf-8'
        with open(path, 'rb') as fh:
            body = fh.read()
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        if path.endswith('widget.js'):
            self.cors()
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0 or length > MAX_BODY:
            return None
        try:
            return json.loads(self.rfile.read(length).decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            return None

    def log_message(self, fmt, *args):
        if self.server.verbose:
            BaseHTTPRequestHandler.log_message(self, fmt, *args)

    # --------------------------------------------------------------- роуты

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        url = urlparse(self.path)
        path = url.path
        query = parse_qs(url.query)

        if path == '/api/config':
            return self.api_config(query)
        if path == '/api/_state':
            return self.send_json({
                'mode': demo_mode,
                'clicks': tail(CLICKS, 20),
                'leads': tail(LEADS, 20),
            })
        if path == '/api/_mode':
            return self.api_mode(query)

        if path == '/':
            return self.send_file(os.path.join(ROOT, 'demo', 'index.html'))
        if path == '/widget.js':
            return self.send_file(os.path.join(ROOT, 'widget.js'))

        local = os.path.normpath(os.path.join(ROOT, path.lstrip('/')))
        if local.startswith(ROOT) and os.path.isfile(local):
            return self.send_file(local)
        self.send_json({'error': 'not found'}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == '/api/lead':
            return self.api_lead()
        if path == '/api/click':
            return self.api_click()
        self.send_json({'error': 'not found'}, 404)

    # ------------------------------------------------------------ обработка

    def api_config(self, query):
        mode = demo_mode['config']
        if mode == 'fail':
            return self.send_json({'error': 'server is down'}, 500)
        if mode == 'slow':
            time.sleep(6)
        if mode == 'empty':
            return self.send_json({'buttons': [], 'form': None})

        source = (query.get('source') or [''])[0]
        try:
            sources = load_sources()
        except (OSError, ValueError):
            return self.send_json({'error': 'bad config'}, 500)
        config = sources.get(source)
        if not config:
            return self.send_json({'buttons': [], 'form': None}, 404)
        return self.send_json(config)

    def api_click(self):
        data = self.read_body() or {}
        log_line(CLICKS, {
            'at': time.strftime('%Y-%m-%d %H:%M:%S'),
            'cid': data.get('cid'),
            'source': data.get('source'),
            'button': data.get('button'),
            'goal': data.get('goal'),
            'how': data.get('how'),
            'tags': data.get('tags') or {},
            'page': data.get('page'),
        })
        self.send_json({'ok': True})

    def api_lead(self):
        if demo_mode['lead'] == 'fail':
            return self.send_json({'error': 'server is down'}, 503)
        if demo_mode['lead'] == 'slow':
            time.sleep(6)

        data = self.read_body()
        if not data or not data.get('id'):
            return self.send_json({'error': 'bad request'}, 400)

        lead_id = str(data['id'])[:64]
        with lock:
            duplicate = lead_id in seen_leads
            if not duplicate:
                seen_leads.add(lead_id)
        if duplicate:
            # Повтор той же заявки — отвечаем успехом, второй записи не создаём.
            return self.send_json({'ok': True, 'duplicate': True})

        phone = normalize_phone(data.get('phone'))
        log_line(LEADS, {
            'at': time.strftime('%Y-%m-%d %H:%M:%S'),
            'id': lead_id,
            'source': data.get('source'),
            'phone': phone,
            'phone_raw': data.get('phone'),
            'answers': data.get('answers') or {},
            'tags': data.get('tags') or {},
            'page': data.get('page'),
        })
        self.send_json({'ok': True, 'duplicate': False, 'phone': phone})

    def api_mode(self, query):
        target = (query.get('target') or ['config'])[0]
        mode = (query.get('mode') or ['ok'])[0]
        if target in demo_mode and mode in ('ok', 'fail', 'slow', 'empty'):
            demo_mode[target] = mode
            return self.send_json({'ok': True, 'mode': demo_mode})
        return self.send_json({'error': 'bad mode'}, 400)


def run(port, open_browser=True, verbose=True):
    os.makedirs(DATA, exist_ok=True)
    load_seen_leads()

    httpd = None
    for candidate in range(port, port + 10):
        try:
            httpd = ThreadingHTTPServer(('127.0.0.1', candidate), Handler)
            port = candidate
            break
        except OSError:
            continue
    if httpd is None:
        raise SystemExit('не нашёл свободный порт в диапазоне %d-%d' % (port, port + 9))

    httpd.verbose = verbose
    httpd.daemon_threads = True
    url = 'http://127.0.0.1:%d/' % port
    print('Демо: %s' % url)
    print('Заявки: data/leads.jsonl, клики: data/clicks.jsonl. Остановить — Ctrl+C.')
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('')
    finally:
        httpd.server_close()
    return port


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Демо-сервер виджета')
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--no-open', action='store_true', help='не открывать браузер')
    parser.add_argument('--quiet', action='store_true', help='не писать лог запросов')
    args = parser.parse_args()
    run(args.port, open_browser=not args.no_open, verbose=not args.quiet)
