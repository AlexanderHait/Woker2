/*
 * contact-widget — кнопки в мессенджеры и короткая форма заявки.
 * Один файл, чистый JS, без сборки и зависимостей.
 *
 * Подключение на чужом сайте:
 *   <script async src="https://cdn.example.com/widget.js"></script>
 *   <div data-cw data-cw-source="landing-tg" data-cw-counter="12345678"></div>
 *
 * Атрибуты блока:
 *   data-cw-source   — идентификатор источника, по нему сервер отдаёт настройки (обязательный);
 *   data-cw-counter  — номер счётчика Яндекс.Метрики для этой страницы;
 *   data-cw-api      — адрес API, по умолчанию origin, с которого загружен сам скрипт;
 *   data-cw-debug    — писать ошибки в консоль (без него виджет молчит).
 */
(function () {
  'use strict';

  var VERSION = '1.0.0';

  // Скрипт подключили дважды (например, и в шапку, и в подвал) — вторая копия молча выходит.
  if (window.contactWidget && window.contactWidget.version) return;

  var self = document.currentScript;
  var DEFAULT_API = (function () {
    try {
      var origin = new URL(self && self.src ? self.src : location.href, location.href).origin;
      return origin === 'null' ? '' : origin;
    } catch (e) {
      return '';
    }
  })();

  var CONFIG_TIMEOUT = 8000;   // сколько ждём настройки, потом виджет просто не появляется
  var GOAL_TIMEOUT = 400;      // сколько ждём подтверждения от Метрики перед уходом на мессенджер
  var CLICK_GAP = 1500;        // окно, внутри которого повторный клик по той же кнопке не считается
  var PROGRESS_TTL = 14 * 24 * 3600 * 1000;
  var SEND_RETRIES = [2000, 5000, 15000, 60000];

  var debug = false;
  function warn() {
    if (debug && window.console) console.warn.apply(console, ['[contact-widget]'].concat([].slice.call(arguments)));
  }
  function noop() {}

  /* ---------------------------------------------------------------- утилиты */

  function uid() {
    try {
      if (crypto.randomUUID) return crypto.randomUUID();
      var a = new Uint8Array(16);
      crypto.getRandomValues(a);
      return [].map.call(a, function (b) { return (b + 256).toString(16).slice(1); }).join('');
    } catch (e) {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }
  }

  function shortId() {
    return uid().replace(/-/g, '').slice(0, 12);
  }

  // localStorage может бросать исключение (приватный режим, отключённые куки) —
  // тогда живём в памяти: прогресс и очередь теряются с вкладкой, но виджет работает.
  var store = (function () {
    var ok = false;
    try {
      localStorage.setItem('cw:probe', '1');
      localStorage.removeItem('cw:probe');
      ok = true;
    } catch (e) { /* остаёмся на памяти */ }
    var mem = {};
    return {
      persistent: ok,
      get: function (key) {
        try { return ok ? localStorage.getItem(key) : (key in mem ? mem[key] : null); } catch (e) { return null; }
      },
      set: function (key, value) {
        try { ok ? localStorage.setItem(key, value) : (mem[key] = value); } catch (e) { mem[key] = value; }
      },
      remove: function (key) {
        try { ok ? localStorage.removeItem(key) : delete mem[key]; } catch (e) { delete mem[key]; }
      }
    };
  })();

  function readJSON(key, fallback) {
    var raw = store.get(key);
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch (e) { store.remove(key); return fallback; }
  }

  function writeJSON(key, value) {
    try { store.set(key, JSON.stringify(value)); } catch (e) { warn(e); }
  }

  function getJSON(url, timeout) {
    return new Promise(function (resolve, reject) {
      var ctrl = window.AbortController ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
        reject(new Error('timeout'));
      }, timeout);
      fetch(url, { credentials: 'omit', signal: ctrl ? ctrl.signal : undefined })
        .then(function (res) {
          if (!res.ok) throw new Error('http ' + res.status);
          return res.json();
        })
        .then(function (data) { clearTimeout(timer); resolve(data); },
              function (err) { clearTimeout(timer); reject(err); });
    });
  }

  // text/plain — чтобы запрос остался «простым» и не требовал preflight на чужом домене.
  function post(url, data, keepalive) {
    return fetch(url, {
      method: 'POST',
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      credentials: 'omit',
      keepalive: !!keepalive
    });
  }

  // Переживает уход со страницы: браузер обязуется дослать запрос уже после выгрузки.
  function beacon(url, data) {
    var body = JSON.stringify(data);
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'text/plain;charset=UTF-8' });
        if (navigator.sendBeacon(url, blob)) return true;
      }
    } catch (e) { warn(e); }
    try {
      post(url, data, true).catch(noop);
      return true;
    } catch (e) {
      warn(e);
      return false;
    }
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /* ------------------------------------------------- рекламные метки и ссылки */

  var CLICK_IDS = ['yclid', 'ysclid', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid', 'msclkid', 'rb_clickid', '_openstat', 'erid'];
  var TAGS_KEY = 'cw:tags';

  function tagsFromUrl() {
    var found = {};
    try {
      new URLSearchParams(location.search).forEach(function (value, key) {
        var lower = key.toLowerCase();
        if (lower.indexOf('utm_') === 0 || CLICK_IDS.indexOf(lower) >= 0) found[lower] = value;
      });
    } catch (e) { warn(e); }
    return found;
  }

  // Метки могут быть только на первой странице визита, а кнопку нажмут на третьей —
  // поэтому запоминаем их на сессию. Свежие метки в адресе всегда важнее сохранённых.
  var campaignTags = (function () {
    var fresh = tagsFromUrl();
    if (Object.keys(fresh).length) {
      writeJSON(TAGS_KEY, { at: Date.now(), tags: fresh, landing: location.href });
      return fresh;
    }
    var saved = readJSON(TAGS_KEY, null);
    return saved && saved.tags ? saved.tags : {};
  })();

  function tagSummary(tags) {
    return ['utm_source', 'utm_campaign', 'utm_content', 'utm_term']
      .filter(function (key) { return tags[key]; })
      .map(function (key) { return tags[key]; })
      .join(' / ')
      .slice(0, 80);
  }

  /**
   * Дописывает метки в ссылку мессенджера.
   *  query — обычные utm-параметры (то, что уже есть в ссылке, не трогаем);
   *  text  — короткая пометка в предзаполненный текст сообщения (wa.me, t.me/user);
   *  start — deep-link бота: в start влезает 64 символа, поэтому кладём короткий код клика,
   *          а расшифровку метки отправляем на свой сервер отдельным запросом.
   */
  function decorate(rawUrl, tags, transport, clickId) {
    var url;
    try { url = new URL(rawUrl, location.href); } catch (e) { return rawUrl; }
    var keys = Object.keys(tags);

    if (transport !== 'start' && keys.length) {
      keys.forEach(function (key) {
        if (!url.searchParams.has(key)) url.searchParams.set(key, tags[key]);
      });
    }

    if (transport === 'text') {
      var summary = tagSummary(tags);
      if (summary) {
        var current = url.searchParams.get('text') || '';
        url.searchParams.set('text', current ? current + '\n\n(' + summary + ')' : '(' + summary + ')');
      }
    }

    if (transport === 'start') {
      var payload = url.searchParams.get('start');
      payload = payload ? payload + '_' + clickId : clickId;
      if (payload.length <= 64) url.searchParams.set('start', payload);
      // Веб-версия Telegram метки в адресе не потеряет, а приложение возьмёт код из start.
      keys.forEach(function (key) {
        if (!url.searchParams.has(key)) url.searchParams.set(key, tags[key]);
      });
    }

    return url.toString();
  }

  /* --------------------------------------------------------------- Метрика */

  var counters = {};

  function counterKnown(id) {
    try {
      if (window['yaCounter' + id]) return true;
      var queue = window.ym && window.ym.a;
      if (!queue) return false;
      for (var i = 0; i < queue.length; i++) {
        if (String(queue[i][0]) === String(id) && queue[i][1] === 'init') return true;
      }
    } catch (e) { warn(e); }
    return false;
  }

  // Счётчика на чужой странице может не быть — ставим свой. Если счётчик уже стоит,
  // повторно его не инициализируем и настройки владельца сайта не трогаем.
  function ensureCounter(id) {
    if (!id || counters[id]) return;
    counters[id] = true;
    try {
      if (typeof window.ym !== 'function') {
        window.ym = function () { (window.ym.a = window.ym.a || []).push(arguments); };
        window.ym.l = Number(new Date());
        var tag = document.createElement('script');
        tag.async = true;
        tag.src = 'https://mc.yandex.ru/metrika/tag.js';
        tag.onerror = function () { warn('metrika blocked'); };
        (document.head || document.documentElement).appendChild(tag);
      }
      if (!counterKnown(id)) {
        window.ym(id, 'init', { clickmap: false, trackLinks: false, accurateTrackBounce: true });
      }
    } catch (e) {
      warn(e);
    }
  }

  /**
   * Отправляет цель и зовёт done(), когда цель подтверждена или истёк таймаут.
   * Блокировщик, отсутствие сети, молчащий счётчик — всё сводится к таймауту,
   * после которого переход всё равно состоится.
   */
  function reachGoal(counterId, goal, params, done) {
    var finished = false;
    var timer = null;
    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (done) done();
    }
    if (!goal || !counterId || typeof window.ym !== 'function') {
      finish();
      return;
    }
    timer = setTimeout(finish, GOAL_TIMEOUT);
    try {
      window.ym(counterId, 'reachGoal', goal, params || {}, finish);
    } catch (e) {
      warn(e);
      finish();
    }
  }

  /* ----------------------------------------------- очередь отправки заявок */

  /*
   * Заявка сначала ложится в очередь в localStorage и только потом уходит в сеть.
   * Пока сервер не подтвердил приём, заявка лежит в очереди: её дошлют повторные
   * попытки, событие online, уход со страницы (sendBeacon) или следующий визит.
   * У каждой заявки есть собственный id — сервер по нему отсекает дубли.
   */
  var outbox = (function () {
    var KEY = 'cw:outbox';
    var waiting = {};   // id -> callback, только в памяти текущей страницы
    var running = false;
    var timer = null;

    function all() { return readJSON(KEY, []); }
    function save(items) { writeJSON(KEY, items); }

    function drop(id) {
      save(all().filter(function (item) { return item.id !== id; }));
    }

    function settle(id, status) {
      var cb = waiting[id];
      delete waiting[id];
      if (cb) cb(status);
    }

    function schedule(delay) {
      clearTimeout(timer);
      timer = setTimeout(function () { flush(); }, delay);
    }

    function flush() {
      if (running) return Promise.resolve();
      var items = all();
      if (!items.length) return Promise.resolve();
      running = true;

      var chain = Promise.resolve();
      items.forEach(function (item) {
        chain = chain.then(function () {
          return post(item.url, item.body).then(function (res) {
            if (res.ok || res.status === 409) {
              drop(item.id);
              settle(item.id, 'sent');
              return;
            }
            // 4xx кроме таймаутов и троттлинга — сервер такую заявку не примет никогда.
            if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
              drop(item.id);
              settle(item.id, 'rejected');
              return;
            }
            throw new Error('http ' + res.status);
          });
        }).catch(function (err) {
          warn('send failed', err);
          var tries = 1;
          var list = all().map(function (row) {
            if (row.id !== item.id) return row;
            tries = (row.tries || 0) + 1;
            row.tries = tries;
            return row;
          });
          save(list);
          settle(item.id, 'queued');
          schedule(SEND_RETRIES[Math.min(tries - 1, SEND_RETRIES.length - 1)]);
        });
      });

      return chain.then(function () { running = false; }, function () { running = false; });
    }

    function add(url, body, onResult) {
      var items = all();
      if (items.some(function (item) { return item.id === body.id; })) {
        // Повторное нажатие «Отправить» по той же заявке — в очередь второй раз не кладём.
        waiting[body.id] = onResult;
        flush();
        return;
      }
      items.push({ id: body.id, url: url, body: body, tries: 0, created: Date.now() });
      save(items);
      waiting[body.id] = onResult;
      flush();
    }

    function pending() { return all(); }

    window.addEventListener('online', function () { flush(); });
    // Вкладку закрывают с неотправленной заявкой — отдаём её маячком.
    // Дубль не страшен: сервер отсекает его по id заявки.
    window.addEventListener('pagehide', function () {
      all().forEach(function (item) { beacon(item.url, item.body); });
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        all().forEach(function (item) { beacon(item.url, item.body); });
      } else {
        flush();
      }
    });

    flush();   // на загрузке страницы дошлём то, что осталось с прошлого раза

    return { add: add, flush: flush, pending: pending };
  })();

  /* --------------------------------------------------------------- телефон */

  /*
   * Проверяем мягко: чистим всё, кроме цифр, и приводим к международному виду.
   * 8 вместо 7, пробелы, скобки, дефисы, номер без кода страны — всё принимаем.
   * Отсекаем только то, что номером быть не может.
   */
  function normalizePhone(raw) {
    var digits = String(raw || '').replace(/\D+/g, '');
    if (!digits) return null;
    if (digits.length === 11 && digits.charAt(0) === '8') digits = '7' + digits.slice(1);
    if (digits.length === 10 && /^[3-9]/.test(digits)) digits = '7' + digits;   // без кода страны
    if (digits.length < 8 || digits.length > 15) return null;                   // E.164
    if (/^(\d)\1+$/.test(digits)) return null;                                  // 0000000000
    return '+' + digits;
  }

  function prettyPhone(value) {
    var m = /^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(value);
    return m ? '+7 ' + m[1] + ' ' + m[2] + '-' + m[3] + '-' + m[4] : value;
  }

  /* ----------------------------------------------------------------- стили */

  var CSS = [
    ':host{display:block}',
    '*,*::before,*::after{box-sizing:border-box}',
    '.cw{font:400 15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
    'color:#15181c;width:100%;max-width:420px;text-align:left}',
    '.cw__head{margin:0 0 10px}',
    '.cw__title{margin:0;font-size:16px;font-weight:600}',
    '.cw__sub{margin:2px 0 0;font-size:13px;color:#5c6670}',
    '.cw__btns{display:flex;flex-direction:column;gap:8px}',
    '.cw__btn{display:flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:12px 16px;',
    'border-radius:10px;background:#3f74d8;color:#fff;font-size:15px;font-weight:600;text-decoration:none;',
    '-webkit-tap-highlight-color:transparent}',
    '.cw__btn:hover{filter:brightness(.93)}',
    '.cw__btn:active{transform:translateY(1px)}',
    '.cw__form{margin-top:14px}',
    '.cw__toggle{display:block;width:100%;min-height:48px;padding:12px 16px;border:1px solid #c9d1d9;',
    'border-radius:10px;background:#fff;color:#15181c;font:inherit;font-weight:600;cursor:pointer}',
    '.cw__toggle:hover{background:#f4f6f8}',
    '.cw__card{border:1px solid #dfe4ea;border-radius:12px;padding:16px;background:#fff}',
    '.cw__bar{height:3px;border-radius:2px;background:#e8ecf1;margin-bottom:14px;overflow:hidden}',
    '.cw__bar i{display:block;height:100%;background:#3f74d8;transition:width .2s ease}',
    '.cw__fs{border:0;margin:0;padding:0;min-width:0}',
    '.cw__q{padding:0;font-size:16px;font-weight:600;line-height:1.3}',
    '.cw__hint{margin:4px 0 0;font-size:13px;color:#5c6670}',
    '.cw__opts{display:flex;flex-direction:column;gap:6px;margin-top:12px}',
    '.cw__opt{display:flex;align-items:center;gap:10px;min-height:44px;padding:8px 12px;border:1px solid #dfe4ea;',
    'border-radius:9px;cursor:pointer}',
    '.cw__opt:hover{background:#f7f9fb}',
    '.cw__opt input{width:18px;height:18px;margin:0;accent-color:#3f74d8;flex:none}',
    '.cw__field{width:100%;margin-top:12px;padding:12px;border:1px solid #c9d1d9;border-radius:9px;',
    'font:inherit;font-size:16px;color:#15181c;background:#fff}',
    '.cw__field:focus{border-color:#3f74d8}',
    'textarea.cw__field{min-height:84px;resize:vertical}',
    '.cw__consent{margin:10px 0 0;font-size:12px;color:#7b848e}',
    '.cw__err{margin:10px 0 0;font-size:13px;color:#c02626;min-height:0}',
    '.cw__nav{display:flex;gap:8px;margin-top:14px}',
    '.cw__nav button{min-height:44px;padding:11px 18px;border-radius:9px;font:inherit;font-weight:600;cursor:pointer}',
    '.cw__next{flex:1;border:0;background:#3f74d8;color:#fff}',
    '.cw__next:hover{filter:brightness(.93)}',
    '.cw__next[disabled]{opacity:.6;cursor:default}',
    '.cw__back{border:1px solid #c9d1d9;background:#fff;color:#15181c}',
    '.cw__back:hover{background:#f4f6f8}',
    '.cw__step-n{margin:12px 0 0;font-size:12px;color:#7b848e}',
    '.cw__done{font-size:15px}',
    '.cw__done b{display:block;margin-bottom:4px;font-size:16px}',
    '.cw__retry{margin-top:12px;min-height:44px;padding:11px 18px;border:1px solid #c9d1d9;border-radius:9px;',
    'background:#fff;font:inherit;font-weight:600;cursor:pointer}',
    '.cw__sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);',
    'white-space:nowrap;border:0}',
    '.cw a:focus-visible,.cw button:focus-visible,.cw input:focus-visible,.cw textarea:focus-visible,',
    '.cw [tabindex]:focus-visible{outline:2px solid #1a73e8;outline-offset:2px}',
    '@media (max-width:480px){.cw{max-width:none}.cw__nav{flex-wrap:wrap}}',
    '@media (prefers-reduced-motion:reduce){.cw__bar i{transition:none}}'
  ].join('');

  // Наследуемые свойства протекают в теневое дерево через сам блок, поэтому гасим их
  // на хосте инлайном с !important — инлайн выигрывает у любых стилей чужого сайта.
  // Внешние отступы и ширину не трогаем: это законный способ разместить блок на странице.
  var HOST_RESET = {
    'display': 'block',
    'padding': '0',
    'border': '0',
    'border-radius': '0',
    'background': 'none',
    'box-shadow': 'none',
    'outline': 'none',
    'font': '400 15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
    'color': '#15181c',
    'letter-spacing': 'normal',
    'word-spacing': 'normal',
    'text-align': 'left',
    'text-transform': 'none',
    'text-indent': '0',
    'white-space': 'normal',
    'direction': 'ltr',
    'visibility': 'visible',
    'opacity': '1'
  };

  /* ---------------------------------------------------------------- виджет */

  function createWidget(host) {
    var source = (host.getAttribute('data-cw-source') || '').trim();
    if (!source) return;

    var api = (host.getAttribute('data-cw-api') || DEFAULT_API).replace(/\/+$/, '');
    var counterId = (host.getAttribute('data-cw-counter') || '').trim();
    var lastClick = {};
    var cfg = null;
    var root = null;
    var form = null;

    getJSON(api + '/api/config?source=' + encodeURIComponent(source), CONFIG_TIMEOUT)
      .then(function (data) {
        cfg = data || {};
        var hasButtons = Array.isArray(cfg.buttons) && cfg.buttons.length;
        var hasForm = cfg.form && Array.isArray(cfg.form.steps) && cfg.form.steps.length;
        // Пустой ответ — ведём себя так же, как при недоступном сервере: ничего не показываем.
        if (!hasButtons && !hasForm) return;
        ensureCounter(counterId);
        render(hasButtons, hasForm);
      })
      .catch(function (err) {
        warn('config unavailable', err);   // страница остаётся целой, виджет молчит
      });

    function render(hasButtons, hasForm) {
      root = host.attachShadow({ mode: 'open' });
      Object.keys(HOST_RESET).forEach(function (prop) {
        host.style.setProperty(prop, HOST_RESET[prop], 'important');
      });

      var style = document.createElement('style');
      style.textContent = CSS;
      root.appendChild(style);

      var wrap = el('div', 'cw');
      if (cfg.title || cfg.subtitle) {
        var head = el('div', 'cw__head');
        if (cfg.title) head.appendChild(el('p', 'cw__title', cfg.title));
        if (cfg.subtitle) head.appendChild(el('p', 'cw__sub', cfg.subtitle));
        wrap.appendChild(head);
      }
      if (hasButtons) wrap.appendChild(buildButtons());
      if (hasForm) wrap.appendChild(buildForm());
      root.appendChild(wrap);
    }

    /* --------------------------------------------------- кнопки в мессенджеры */

    function buildButtons() {
      var list = el('div', 'cw__btns');
      cfg.buttons.forEach(function (btn) {
        var clickId = shortId();
        var href = decorate(btn.url, campaignTags, btn.tags || 'query', clickId);
        var link = el('a', 'cw__btn', btn.label || 'Написать');
        link.href = href;
        link.rel = 'noopener noreferrer';
        if (btn.color) link.style.background = btn.color;

        // Обычные http-ссылки открываем в новой вкладке: страница остаётся живой,
        // и запросу аналитики никто не мешает доехать. Для схем вида tg:// вкладка
        // осталась бы пустой, поэтому там переходим в текущей.
        var newTab = btn.newTab != null ? !!btn.newTab : /^https?:/i.test(href);
        if (newTab) link.target = '_blank';

        link.addEventListener('click', function (event) {
          if (event.defaultPrevented) return;
          var opensElsewhere = newTab || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
          if (opensElsewhere) {
            count(btn, clickId, 'new-tab');   // страница не выгружается — ждать нечего
            return;
          }
          // Уходим в текущей вкладке: задерживаем переход до подтверждения цели,
          // но не дольше GOAL_TIMEOUT — человек в мессенджере важнее отчёта.
          event.preventDefault();
          var target = link.href;
          var moved = false;
          var go = function () {
            if (moved) return;
            moved = true;
            location.href = target;
          };
          setTimeout(go, GOAL_TIMEOUT);
          count(btn, clickId, 'same-tab', go);
        });

        // Средняя кнопка мыши: браузер откроет вкладку сам, нам остаётся посчитать.
        link.addEventListener('auxclick', function (event) {
          if (event.button === 1) count(btn, clickId, 'middle');
        });

        list.appendChild(link);
      });
      return list;
    }

    function count(btn, clickId, how, done) {
      var now = Date.now();
      // Дребезг и двойной клик по той же кнопке — одно нажатие.
      if (lastClick[btn.id] && now - lastClick[btn.id] < CLICK_GAP) {
        if (done) done();
        return;
      }
      lastClick[btn.id] = now;

      // Свой счёт уходит маячком: он не зависит ни от блокировщика, ни от того,
      // успела ли загрузиться Метрика, и переживает выгрузку страницы.
      beacon(api + '/api/click', {
        cid: clickId,
        source: source,
        button: btn.id,
        goal: btn.goal || null,
        how: how,
        tags: campaignTags,
        page: location.href,
        ts: now
      });

      reachGoal(counterId, btn.goal, { source: source, button: btn.id }, done);
    }

    /* --------------------------------------------------------------- форма */

    function buildForm() {
      var conf = cfg.form;
      var steps = conf.steps;
      var goals = conf.goals || {};
      // Если на странице два блока с одним и тем же источником, прогресс у них
      // должен быть свой, поэтому в ключ идёт ещё и номер блока.
      var twins = [].filter.call(document.querySelectorAll('[data-cw-source]'), function (node) {
        return node.getAttribute('data-cw-source') === source;
      });
      var slot = twins.indexOf(host);
      var stateKey = 'cw:form:' + source + (slot > 0 ? '#' + slot : '') + ':' + (conf.version || 1);
      var reported = {};

      var state = restore();
      var status = 'filling';        // filling | sending | sent | queued | failed
      var touched = false;
      var announced = null;

      var box = el('div', 'cw__form');
      var live = el('p', 'cw__sr');
      live.setAttribute('role', 'status');
      live.setAttribute('aria-live', 'polite');
      box.appendChild(live);

      var card = el('div', 'cw__card');
      var toggle = null;

      if (conf.collapsed) {
        toggle = el('button', 'cw__toggle', conf.openLabel || 'Оставить заявку');
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', 'false');
        card.hidden = true;
        toggle.addEventListener('click', function () {
          var open = card.hidden;
          card.hidden = !open;
          toggle.setAttribute('aria-expanded', String(open));
          if (open) {
            touched = true;
            goal(goals.open || 'form_open');
            draw();
          }
        });
        box.appendChild(toggle);
      }

      box.appendChild(card);
      if (!conf.collapsed) {
        goal(goals.open || 'form_open');
        draw();
      }
      return box;

      function restore() {
        var saved = readJSON(stateKey, null);
        var fresh = { leadId: uid(), step: 0, answers: {}, started: Date.now() };
        if (!saved || !saved.leadId) return fresh;
        if (saved.version !== (conf.version || 1)) return fresh;      // анкету поменяли — старые ответы не наши
        if (Date.now() - (saved.started || 0) > PROGRESS_TTL) return fresh;
        saved.step = Math.min(saved.step || 0, steps.length - 1);
        return saved;
      }

      function persist() {
        writeJSON(stateKey, {
          leadId: state.leadId,
          step: state.step,
          answers: state.answers,
          started: state.started,
          version: conf.version || 1
        });
      }

      function goal(name, params) {
        if (name) reachGoal(counterId, name, params || { source: source });
      }

      function announce(text) {
        if (announced === text) return;
        announced = text;
        live.textContent = text;
      }

      function draw() {
        card.textContent = '';
        if (status === 'sending' || status === 'sent' || status === 'queued' || status === 'failed') {
          drawResult();
          return;
        }
        drawStep();
      }

      function drawStep() {
        var step = steps[state.step];
        var bar = el('div', 'cw__bar');
        var fill = el('i');
        fill.style.width = Math.round((state.step / steps.length) * 100) + '%';
        bar.appendChild(fill);
        card.appendChild(bar);

        var fieldset = el('fieldset', 'cw__fs');
        fieldset.tabIndex = -1;
        var legend = el('legend', 'cw__q', step.question || '');
        fieldset.appendChild(legend);
        if (step.hint) fieldset.appendChild(el('p', 'cw__hint', step.hint));

        var control = null;
        if (step.type === 'single' || step.type === 'multi') {
          control = drawOptions(step, fieldset);
        } else if (step.type === 'text') {
          control = drawText(step, fieldset);
        } else if (step.type === 'phone') {
          control = drawPhone(step, fieldset);
        }

        var error = el('p', 'cw__err');
        error.setAttribute('role', 'alert');
        fieldset.appendChild(error);

        var nav = el('div', 'cw__nav');
        var last = state.step === steps.length - 1;
        if (state.step > 0) {
          var back = el('button', 'cw__back', 'Назад');
          back.type = 'button';
          back.addEventListener('click', function () {
            touched = true;
            // Ответ текущего шага не проверяем, но и не теряем: человек вернётся сюда.
            if (control) {
              var current = control.read();
              if (current != null && String(current).length) state.answers[step.id] = current;
            }
            state.step--;
            persist();
            draw();
          });
          nav.appendChild(back);
        }
        var next = el('button', 'cw__next', last ? (conf.submitLabel || 'Отправить') : 'Далее');
        next.type = 'submit';
        nav.appendChild(next);

        if (step.type === 'phone' && step.consent) {
          fieldset.appendChild(el('p', 'cw__consent', step.consent));
        }
        fieldset.appendChild(nav);
        fieldset.appendChild(el('p', 'cw__step-n', 'Шаг ' + (state.step + 1) + ' из ' + steps.length));

        var formEl = el('form');
        formEl.noValidate = true;
        formEl.appendChild(fieldset);
        formEl.addEventListener('submit', function (event) {
          event.preventDefault();
          var value = control ? control.read() : null;
          var problem = validate(step, value);
          if (problem) {
            error.textContent = problem;
            if (control && control.focus) control.focus();
            return;
          }
          error.textContent = '';
          if (value != null) state.answers[step.id] = value;
          touched = true;
          if (last) {
            send();
          } else {
            state.step++;
            persist();
            draw();
          }
        });
        card.appendChild(formEl);

        if (!reported[state.step]) {
          reported[state.step] = true;
          goal(goals.step || 'form_step', { source: source, step: state.step + 1, id: step.id });
        }
        announce('Шаг ' + (state.step + 1) + ' из ' + steps.length + '. ' + (step.question || ''));
        if (touched) fieldset.focus();
      }

      function drawOptions(step, parent) {
        var multi = step.type === 'multi';
        var saved = state.answers[step.id];
        var chosen = multi ? (Array.isArray(saved) ? saved.slice() : []) : (saved != null ? [saved] : []);
        var list = el('div', 'cw__opts');
        var inputs = [];
        var group = 'cw-' + step.id + '-' + Math.random().toString(36).slice(2, 7);

        (step.options || []).forEach(function (option) {
          var label = el('label', 'cw__opt');
          var input = document.createElement('input');
          input.type = multi ? 'checkbox' : 'radio';
          input.name = group;
          input.value = option.value;
          input.checked = chosen.indexOf(option.value) >= 0;
          label.appendChild(input);
          label.appendChild(el('span', null, option.label || option.value));
          list.appendChild(label);
          inputs.push(input);
        });
        parent.appendChild(list);

        return {
          read: function () {
            var picked = inputs.filter(function (i) { return i.checked; }).map(function (i) { return i.value; });
            return multi ? picked : (picked[0] != null ? picked[0] : '');
          },
          focus: function () { if (inputs[0]) inputs[0].focus(); }
        };
      }

      function drawText(step, parent) {
        var area = el('textarea', 'cw__field');
        area.value = state.answers[step.id] || '';
        area.placeholder = step.placeholder || '';
        area.maxLength = step.maxLength || 600;
        area.setAttribute('aria-label', step.question || '');
        parent.appendChild(area);
        return {
          read: function () { return area.value.trim(); },
          focus: function () { area.focus(); }
        };
      }

      function drawPhone(step, parent) {
        var input = document.createElement('input');
        input.className = 'cw__field';
        input.type = 'tel';
        input.inputMode = 'tel';
        input.autocomplete = 'tel';
        input.value = state.answers[step.id] || '';
        input.placeholder = step.placeholder || '+7 900 000-00-00';
        input.setAttribute('aria-label', step.question || 'Телефон');
        parent.appendChild(input);
        return {
          read: function () { return input.value.trim(); },
          focus: function () { input.focus(); }
        };
      }

      function validate(step, value) {
        if (step.type === 'phone') {
          if (!value) return step.required === false ? null : 'Оставьте номер, чтобы мы могли перезвонить';
          return normalizePhone(value) ? null : 'Проверьте номер: похоже, в нём не хватает цифр';
        }
        if (step.required === false) return null;
        if (step.type === 'multi') return (value && value.length) ? null : 'Выберите хотя бы один вариант';
        return (value && String(value).length) ? null : 'Выберите вариант, чтобы продолжить';
      }

      function send() {
        if (status === 'sending') return;    // двойное нажатие «Отправить»
        status = 'sending';
        draw();

        var phoneStep = steps.filter(function (s) { return s.type === 'phone'; })[0];
        var phone = phoneStep ? normalizePhone(state.answers[phoneStep.id]) : null;

        goal(goals.submit || 'form_submit', { source: source });

        outbox.add(api + (conf.submitUrl || '/api/lead'), {
          id: state.leadId,                 // один id на одно заполнение — сервер отсечёт дубль
          source: source,
          answers: state.answers,
          phone: phone,
          tags: campaignTags,
          page: location.href,
          ts: Date.now()
        }, function (result) {
          if (result === 'sent') {
            status = 'sent';
            goal(goals.sent || 'form_sent', { source: source });
          } else if (result === 'rejected') {
            status = 'failed';
          } else {
            status = 'queued';
          }
          // Ответы стираем только после подтверждённой отправки: если сервер заявку
          // не принял, человек перезагрузит страницу и продолжит с теми же ответами.
          if (result === 'sent') store.remove(stateKey);
          draw();
        });
      }

      function drawResult() {
        var done = el('div', 'cw__done');
        done.tabIndex = -1;

        if (status === 'sending') {
          done.appendChild(el('b', null, 'Отправляем…'));
          announce('Отправляем заявку');
        } else if (status === 'sent') {
          done.appendChild(el('b', null, 'Заявка принята'));
          done.appendChild(el('span', null, conf.success || 'Перезвоним в рабочее время.'));
          announce(conf.success || 'Заявка принята');
        } else if (status === 'queued') {
          done.appendChild(el('b', null, 'Заявка сохранена'));
          done.appendChild(el('span', null, store.persistent
            ? 'Сети сейчас нет. Мы отправим заявку автоматически, как только связь появится — страницу можно закрыть.'
            : 'Сети сейчас нет. Не закрывайте вкладку: отправим, как только связь появится.'));
          var retry = el('button', 'cw__retry', 'Попробовать сейчас');
          retry.type = 'button';
          retry.addEventListener('click', function () { outbox.flush(); });
          done.appendChild(retry);
          announce('Сеть недоступна, заявка сохранена и будет отправлена позже');
        } else {
          done.appendChild(el('b', null, 'Не получилось отправить'));
          done.appendChild(el('span', null, 'Напишите нам в мессенджер — так быстрее.'));
          announce('Заявку отправить не удалось');
        }

        card.appendChild(done);
        if (touched) done.focus();
      }
    }
  }

  /* ------------------------------------------------------------------ запуск */

  function scan() {
    var blocks = document.querySelectorAll('[data-cw-source]');
    for (var i = 0; i < blocks.length; i++) {
      var node = blocks[i];
      if (node.dataset.cwReady) continue;      // два блока на странице работают независимо,
      node.dataset.cwReady = '1';              // но один блок инициализируем ровно один раз
      if (node.hasAttribute('data-cw-debug')) debug = true;
      if (!node.attachShadow) continue;        // браузеры без Shadow DOM не поддерживаем
      try {
        createWidget(node);
      } catch (e) {
        warn(e);
      }
    }
  }

  window.contactWidget = { version: VERSION, scan: scan, normalizePhone: normalizePhone, decorate: decorate };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scan);
  } else {
    scan();
  }
  window.addEventListener('load', scan);       // блок мог появиться после парсинга
})();
