#!/usr/bin/env python3
"""
Демо-сервер виджета: отдаёт настройки источников, принимает клики и заявки.

Только стандартная библиотека, запуск одной командой:

    python3 server.py

Данные выдуманные и лежат в data/sources.json. События и заявки пишутся
в data/events.jsonl и data/leads.jsonl.
"""

import argparse
import json
import mimetypes
import os
import re
import socket
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, 'data')
SOURCES = os.path.join(DATA, 'sources.json')
LEADS = os.path.join(DATA, 'leads.jsonl')
EVENTS = os.path.join(DATA, 'events.jsonl')

MAX_BODY = 64 * 1024
PHONE_DIGITS = re.compile(r'\D+')

# Приём заявок: не больше LEAD_LIMIT штук с одного адреса за LEAD_WINDOW секунд.
# Отвечаем 429 — виджет считает такой отказ временным и повторит попытку позже,
# поэтому живой человек за общим NAT заявку не потеряет.
LEAD_LIMIT = 30
LEAD_WINDOW = 600

lock = threading.Lock()

# Время последних заявок по адресам — для ограничения частоты.
lead_hits = {}

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


def rate_limited(address):
    now = time.time()
    with lock:
        hits = [t for t in lead_hits.get(address, []) if now - t < LEAD_WINDOW]
        if len(hits) >= LEAD_LIMIT:
            lead_hits[address] = hits
            return True
        hits.append(now)
        lead_hits[address] = hits
    return False


def load_seen_leads():
    for row in tail(LEADS, 100000):
        if row.get('id'):
            seen_leads.add(row['id'])


def is_local(address):
    """Служебные ручки демо открыты только своей машине и локальной сети."""
    if address in ('127.0.0.1', '::1'):
        return True
    parts = address.split('.')
    if len(parts) != 4 or not all(part.isdigit() for part in parts):
        return False
    a, b = int(parts[0]), int(parts[1])
    return a == 10 or a == 127 or (a == 192 and b == 168) or (a == 172 and 16 <= b <= 31)


def local_ip():
    """Адрес машины в локальной сети — чтобы открыть демо с телефона."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(('192.168.0.1', 1))
        return sock.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        sock.close()


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
        """Тело читаем всегда и целиком, даже если ответим отказом: на keep-alive
        соединении непрочитанный остаток разберётся как следующий запрос."""
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0:
            return None
        raw = b''
        left = length
        while left > 0:
            chunk = self.rfile.read(min(left, 16 * 1024))
            if not chunk:
                break
            left -= len(chunk)
            if len(raw) < MAX_BODY:
                raw += chunk
        if length > MAX_BODY:
            return None
        try:
            return json.loads(raw.decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            return None

    def demo_only(self):
        if is_local(self.client_address[0]):
            return True
        self.send_json({'error': 'demo endpoint, local network only'}, 403)
        return False

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
            if not self.demo_only():
                return
            return self.send_json({
                'mode': demo_mode,
                'events': tail(EVENTS, 25),
                'leads': tail(LEADS, 20),
            })
        if path == '/api/_mode':
            if not self.demo_only():
                return
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
        data = self.read_body()
        if path == '/api/lead':
            return self.api_lead(data)
        if path == '/api/event':
            return self.api_event(data)
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

    def api_event(self, data):
        data = data or {}
        kind = data.get('kind')
        if kind not in ('view', 'click'):
            return self.send_json({'error': 'unknown kind'}, 400)
        log_line(EVENTS, {
            'at': time.strftime('%Y-%m-%d %H:%M:%S'),
            'kind': kind,
            'cid': data.get('cid'),
            'source': data.get('source'),
            'button': data.get('button'),
            'goal': data.get('goal'),
            'how': data.get('how'),
            'tags': data.get('tags') or {},
            'page': data.get('page'),
        })
        self.send_json({'ok': True})

    def api_lead(self, data):
        if demo_mode['lead'] == 'fail':
            return self.send_json({'error': 'server is down'}, 503)
        if demo_mode['lead'] == 'slow':
            time.sleep(6)

        if not data or not data.get('id'):
            return self.send_json({'error': 'bad request'}, 400)

        if rate_limited(self.client_address[0]):
            # Временный отказ: виджет подержит заявку в очереди и попробует ещё раз.
            return self.send_json({'error': 'too many leads', 'retry_after': LEAD_WINDOW}, 429)

        lead_id = str(data['id'])[:64]
        with lock:
            duplicate = lead_id in seen_leads
            if not duplicate:
                seen_leads.add(lead_id)
        if duplicate:
            # Повтор той же заявки — отвечаем успехом, второй записи не создаём.
            return self.send_json({'ok': True, 'duplicate': True})

        phone = normalize_phone(data.get('phone'))
        queued_ms = int(data.get('queued_ms') or 0)
        elapsed_ms = int(data.get('elapsed_ms') or 0)
        # Ни одну заявку не выбрасываем: помечаем подозрительные и разбираем руками.
        # Скрытое поле заполняют только боты, а заполнение быстрее трёх секунд
        # для формы из нескольких шагов физически маловероятно.
        suspicious = []
        if (data.get('trap') or '').strip():
            suspicious.append('trap')
        if 0 < elapsed_ms < 3000:
            suspicious.append('too_fast')
        log_line(LEADS, {
            'at': time.strftime('%Y-%m-%d %H:%M:%S'),
            'id': lead_id,
            'source': data.get('source'),
            'phone': phone,
            'phone_raw': data.get('phone'),
            'answers': data.get('answers') or {},
            'tags': data.get('tags') or {},
            'page': data.get('page'),
            'queued_ms': queued_ms,          # сколько заявка пролежала в очереди у человека
            'elapsed_ms': elapsed_ms,        # сколько он заполнял форму
            'suspicious': suspicious,
        })
        self.send_json({'ok': True, 'duplicate': False, 'phone': phone,
                        'suspicious': bool(suspicious)})

    def api_mode(self, query):
        target = (query.get('target') or ['config'])[0]
        mode = (query.get('mode') or ['ok'])[0]
        if target in demo_mode and mode in ('ok', 'fail', 'slow', 'empty'):
            demo_mode[target] = mode
            return self.send_json({'ok': True, 'mode': demo_mode})
        return self.send_json({'error': 'bad mode'}, 400)


def run(port, open_browser=True, verbose=True, host='127.0.0.1'):
    os.makedirs(DATA, exist_ok=True)
    load_seen_leads()

    httpd = None
    for candidate in range(port, port + 10):
        try:
            httpd = ThreadingHTTPServer((host, candidate), Handler)
            port = candidate
            break
        except OSError:
            continue
    if httpd is None:
        raise SystemExit('не нашёл свободный порт в диапазоне %d-%d' % (port, port + 9))

    httpd.verbose = verbose
    httpd.daemon_threads = True
    url = 'http://%s:%d/' % ('127.0.0.1' if host in ('0.0.0.0', '') else host, port)
    print('Демо: %s' % url)
    if host == '0.0.0.0':
        print('С телефона в той же сети: http://%s:%d/' % (local_ip(), port))
    print('Заявки: data/leads.jsonl, события: data/events.jsonl. Остановить — Ctrl+C.')
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
    parser.add_argument('--host', default='127.0.0.1', help='0.0.0.0 — чтобы открыть демо с телефона')
    parser.add_argument('--no-open', action='store_true', help='не открывать браузер')
    parser.add_argument('--quiet', action='store_true', help='не писать лог запросов')
    args = parser.parse_args()
    run(args.port, open_browser=not args.no_open, verbose=not args.quiet, host=args.host)
