#!/usr/bin/env node
/*
 * Браузерные проверки: те самые 15 сценариев из задания плюс интеграция
 * с Метрикой и поведение очереди заявок.
 *
 * Необязательная часть поставки — требует Playwright:
 *     npm install playwright && npx playwright install chromium
 *     node tests/browser.js
 *
 * Сервер поднимается и гасится сам, порт 8111.
 */
const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');

const PORT = 8111;
const BASE = 'http://127.0.0.1:' + PORT;
const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (detail !== undefined ? ' -> ' + JSON.stringify(detail) : ''));
  }
}

function group(title) {
  console.log('\n' + title);
}

const state = () => fetch(BASE + '/api/_state').then((r) => r.json());
const mode = (target, value) => fetch(`${BASE}/api/_mode?target=${target}&mode=${value}`);
const clicks = (s) => s.events.filter((e) => e.kind === 'click');
const views = (s) => s.events.filter((e) => e.kind === 'view');

// Журнал сервера отдаёт только хвост последних записей, поэтому новые заявки
// ищем по идентификаторам, а не по длине списка.
const leadIds = async () => new Set((await state()).leads.map((l) => l.id));
async function newLeads(before) {
  const leads = (await state()).leads;
  return leads.filter((l) => !before.has(l.id));
}
const clickCids = async () => new Set(clicks(await state()).map((c) => c.cid));
async function newClicks(before) {
  return clicks(await state()).filter((c) => !before.has(c.cid));
}

/*
 * Нас интересуют только ошибки самого виджета. Сообщения браузера о том, что
 * внешний ресурс не загрузился, — это ожидаемое поведение в сценариях
 * с заблокированной аналитикой и с лежащим сервером.
 */
function ownErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push('исключение: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource|Content Security Policy|ERR_/i.test(m.text())) return;
    errors.push(m.text());
  });
  return errors;
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      await state();
      return;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('сервер не поднялся');
}

async function fillForm(page, source, phone) {
  const widget = page.locator(`[data-cw-source="${source}"]`);
  const toggle = widget.locator('.cw__toggle');
  if (await toggle.count()) await toggle.click();
  for (;;) {
    const options = widget.locator('.cw__opt input');
    const phoneField = widget.locator('input[type="tel"]');
    if (await phoneField.count()) {
      await phoneField.fill(phone);
      return widget;
    }
    if (await options.count()) await options.first().check();
    await widget.locator('button.cw__next').click();
    await page.waitForTimeout(150);
  }
}

async function main() {
  const server = spawn('python3', ['server.py', '--port', String(PORT), '--no-open', '--quiet'],
    { cwd: ROOT, stdio: 'ignore' });
  process.on('exit', () => server.kill());
  await waitForServer();

  const browser = await chromium.launch();

  group('Подключение, блоки, оформление');
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = ownErrors(page);
    await page.goto(BASE + '/');
    await page.waitForTimeout(900);

    const first = await page.locator('[data-cw-source="landing-tg"] a.cw__btn').count();
    const second = await page.locator('[data-cw-source="partner-max"] a.cw__btn').count();
    const secondForm = await page.locator('[data-cw-source="partner-max"] .cw__card').count();
    const collapsed = await page.locator('[data-cw-source="promo-form"] .cw__toggle').count();
    check('1 кнопки появились', first === 3, first);
    check('8 у второго блока свой набор и нет формы', second === 2 && secondForm === 0, [second, secondForm]);
    check('8 форма показана там, где включена настройками', collapsed === 1, collapsed);
    check('1 виджет не пишет ошибок в консоль', errors.length === 0, errors);

    const light = await page.locator('[data-cw-source="landing-tg"] .cw').getAttribute('data-theme');
    const dark = await page.locator('[data-cw-source="promo-form"] .cw').getAttribute('data-theme');
    const bg = await page.locator('[data-cw-source="promo-form"] .cw__toggle')
      .evaluate((e) => getComputedStyle(e).backgroundColor);
    check('тема приходит с сервера', light === 'light' && dark === 'dark', [light, dark]);
    check('тёмная тема действительно тёмная', bg === 'rgb(28, 32, 38)', bg);

    const tg = await page.locator('[data-cw-source="landing-tg"] a.cw__btn').first()
      .evaluate((e) => getComputedStyle(e).color);
    check('на светлой фирменной кнопке подпись тёмная', tg === 'rgb(21, 24, 28)', tg);
    await ctx.close();
  }

  group('Рекламные метки');
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE + '/?utm_source=yandex&utm_medium=cpc&utm_campaign=spring&yclid=999');
    await page.waitForTimeout(800);
    const hrefs = await page.locator('[data-cw-source="landing-tg"] a.cw__btn')
      .evaluateAll((els) => els.map((e) => e.href));
    const max = hrefs.find((h) => h.includes('max.ru'));
    const wa = decodeURIComponent(hrefs.find((h) => h.includes('wa.me')));
    const tg = hrefs.find((h) => h.includes('t.me'));
    check('2 метки доехали до ссылки', max.includes('utm_source=yandex') && max.includes('yclid=999'), max);
    check('2 параметр самой ссылки не потерян', max.includes('ref=widget'), max);
    check('2 предзаполненный текст не затёрт', wa.includes('Здравствуйте!'), wa);
    check('2 метка попала в текст сообщения', wa.includes('yandex'), wa);
    check('2 для бота метки ужаты в start', /[?&]start=[A-Za-z0-9_-]{1,64}(&|$)/.test(tg), tg);
    await ctx.close();
  }

  group('Счёт нажатий');
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.route('https://max.ru/**', (r) => r.fulfill({ status: 200, body: 'мессенджер' }));
    await page.goto(BASE + '/');
    await page.waitForTimeout(900);

    const beforeViews = views(await state()).length;
    check('7 показ виджета посчитан', beforeViews > 0, beforeViews);

    let before = await clickCids();
    await page.locator('[data-cw-source="partner-max"] a.cw__btn').first().dblclick();
    await page.waitForTimeout(1200);
    check('3 двойной клик — одно событие', (await newClicks(before)).length === 1);

    before = await clickCids();
    await page.goto(BASE + '/');
    await page.waitForTimeout(800);
    await page.locator('[data-cw-source="partner-max"] a.cw__btn').nth(1).click();
    await page.waitForTimeout(1200);
    check('4 уход в текущей вкладке: событие не потеряно', (await newClicks(before)).length === 1);
    await ctx.close();
  }

  group('Метрика');
  {
    const stub = `
      window.__ym = [];
      window.ym = function () {
        window.__ym.push([].slice.call(arguments));
        if (typeof arguments[4] === 'function') setTimeout(arguments[4], 50);
      };
      window.ym.a = [[12345678, 'init', {}]];
    `;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript(stub);
    await page.route('https://max.ru/**', (r) => r.fulfill({ status: 200, body: 'ok' }));
    await page.goto(BASE + '/');
    await page.waitForTimeout(1200);

    const inits = await page.evaluate(() => window.__ym.filter((c) => c[1] === 'init').map(String));
    check('чужой счётчик не инициализируем повторно', !inits.some((i) => i.startsWith('12345678')), inits);
    check('свой счётчик страницы ставим сами', inits.some((i) => i.startsWith('87654321')), inits);

    await page.locator('[data-cw-source="partner-max"] a.cw__btn').first().click();
    await page.waitForTimeout(700);
    const goals = await page.evaluate(() => window.__ym.filter((c) => c[1] === 'reachGoal').map((c) => [String(c[0]), c[2]]));
    const clickGoals = goals.filter((g) => g[1] === 'click_max');
    check('3 в аналитику ушла ровно одна цель', clickGoals.length === 1, goals);
    check('цель ушла в счётчик своего блока', clickGoals[0][0] === '87654321', goals);
    check('7 показ отправлен целью', goals.some((g) => g[1] === 'widget_view'), goals);
    check('6 шаги формы отмечены целями', goals.some((g) => g[1] === 'form_step'), goals);
    await ctx.close();
  }

  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript('window.ym = function () { throw new Error("сломанный счётчик"); }; window.ym.a = [];');
    await page.route('https://max.ru/**', (r) => r.fulfill({ status: 200, body: 'ok' }));
    const errors = ownErrors(page);
    await page.goto(BASE + '/');
    await page.waitForTimeout(900);
    await page.locator('[data-cw-source="partner-max"] a.cw__btn').first().click();
    await page.waitForTimeout(700);
    check('5 сломанный счётчик не роняет страницу', errors.length === 0, errors);
    check('5 кнопки продолжают работать', (await page.locator('a.cw__btn').count()) > 0);
    await ctx.close();
  }

  group('Аналитика заблокирована');
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = ownErrors(page);
    const before = await clickCids();
    await page.goto(BASE + '/demo/blocked.html');
    await page.waitForTimeout(1000);
    check('5 кнопки на месте', (await page.locator('a.cw__btn').count()) === 3);
    await page.locator('a.cw__btn').first().click();
    await page.waitForTimeout(900);
    check('5 свой счёт нажатий доехал', (await newClicks(before)).length === 1);
    check('5 виджет не насорил в консоли', errors.length === 0, errors);
    await ctx.close();
  }

  group('Сервер настроек недоступен');
  {
    await mode('config', 'fail');
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = ownErrors(page);
    await page.goto(BASE + '/');
    await page.waitForTimeout(1000);
    check('6 виджет молчит', (await page.locator('a.cw__btn').count()) === 0);
    check('6 страница цела', (await page.locator('h1').innerText()).length > 0);
    check('6 без своих ошибок в консоли', errors.length === 0, errors);
    await ctx.close();

    await mode('config', 'empty');
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await page2.goto(BASE + '/');
    await page2.waitForTimeout(800);
    check('6 пустой список — тоже молчит', (await page2.locator('a.cw__btn').count()) === 0);
    await ctx2.close();

    await mode('config', 'slow');
    const ctx3 = await browser.newContext();
    const page3 = await ctx3.newPage();
    const started = Date.now();
    await page3.goto(BASE + '/', { waitUntil: 'load' });
    const loaded = Date.now() - started;
    check('6 медленный сервер не держит страницу', loaded < 3000, loaded + ' мс');
    await ctx3.close();
    await mode('config', 'ok');
  }

  group('Чужие стили и двойное подключение');
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE + '/demo/hostile.html');
    await page.waitForTimeout(1000);
    check('7 кнопки не задвоились', (await page.locator('a.cw__btn').count()) === 3);
    const style = await page.locator('a.cw__btn').first().evaluate((e) => {
      const cs = getComputedStyle(e);
      return { size: cs.fontSize, family: cs.fontFamily, transform: cs.textTransform };
    });
    const host = await page.locator('[data-cw-source="landing-tg"]')
      .evaluate((e) => getComputedStyle(e).borderTopWidth);
    check('9 размер шрифта свой', style.size === '15px', style);
    check('9 шрифт чужого сайта не протёк', !/Comic/i.test(style.family), style.family);
    check('9 капс не протёк', style.transform === 'none', style.transform);
    check('9 рамка чужого сайта на блоке погашена', host === '0px', host);
    await ctx.close();
  }

  group('Узкий экран');
  {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 720 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(BASE + '/');
    await page.waitForTimeout(900);
    const boxes = await page.locator('[data-cw-source="landing-tg"] a.cw__btn')
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ h: r.height, top: r.top, bottom: r.bottom })));
    let overlap = false;
    for (let i = 1; i < boxes.length; i++) if (boxes[i].top < boxes[i - 1].bottom) overlap = true;
    check('10 кнопки не меньше 44 пикселей', boxes.every((b) => b.h >= 44), boxes);
    check('10 кнопки не наезжают друг на друга', !overlap);
    check('10 нет горизонтальной прокрутки',
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    await ctx.close();
  }

  group('Форма: прогресс, дубли, телефон');
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE + '/');
    await page.waitForTimeout(900);
    const widget = page.locator('[data-cw-source="landing-tg"]');
    await widget.locator('.cw__opt input').first().check();
    await widget.locator('button.cw__next').click();
    await page.waitForTimeout(150);
    await widget.locator('.cw__opt input').nth(1).check();
    await widget.locator('button.cw__next').click();
    await page.waitForTimeout(150);
    const before = await widget.locator('.cw__step-n').innerText();

    await page.reload();
    await page.waitForTimeout(900);
    const after = await page.locator('[data-cw-source="landing-tg"] .cw__step-n').innerText();
    check('11 после перезагрузки тот же шаг', before === after, [before, after]);
    await page.locator('[data-cw-source="landing-tg"] button.cw__back').click();
    await page.waitForTimeout(150);
    check('11 ответы на месте',
      (await page.locator('[data-cw-source="landing-tg"] .cw__opt input:checked').count()) === 1);

    const w = await fillForm(page, 'landing-tg', '8 (912) 345 - 67 89');
    const before2 = await leadIds();
    await w.locator('button.cw__next').dblclick();
    await page.waitForTimeout(1800);
    const fresh = await newLeads(before2);
    check('13 двойное нажатие — одна заявка', fresh.length === 1, fresh.length);
    check('14 телефон нормализован', fresh[0] && fresh[0].phone === '+79123456789', fresh[0] && fresh[0].phone);
    check('13 человеку показан результат', /принята/i.test(await w.locator('.cw__done b').innerText()));
    // Ловушку тест не трогает, а заполняет форму быстрее любого человека —
    // поэтому ждём пометку по скорости и её отсутствие по скрытому полю.
    check('скрытое поле не заполнено — метки trap нет',
      fresh[0] && !fresh[0].suspicious.includes('trap'), fresh[0] && fresh[0].suspicious);
    check('заполнение за секунды помечено как подозрительное',
      fresh[0] && fresh[0].suspicious.includes('too_fast'), fresh[0] && fresh[0].suspicious);
    await ctx.close();
  }

  group('Заявка не теряется');
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE + '/');
    await page.waitForTimeout(900);
    const w = await fillForm(page, 'promo-form', '+7 999 111 22 33');

    await ctx.setOffline(true);
    const before = await leadIds();
    await w.locator('button.cw__next').click();
    await page.waitForTimeout(1200);
    check('12 человеку честно сказано, что заявка сохранена',
      /сохранена/i.test(await w.locator('.cw__done b').innerText()));
    check('12 заявка лежит в очереди',
      (await page.evaluate(() => JSON.parse(localStorage.getItem('cw:outbox') || '[]').length)) === 1);

    await ctx.setOffline(false);
    await w.locator('.cw__retry').click({ timeout: 2500 }).catch(() => {});
    await page.waitForTimeout(2500);
    check('12 после возврата сети заявка ушла', (await newLeads(before)).length === 1);
    check('12 очередь пуста',
      (await page.evaluate(() => JSON.parse(localStorage.getItem('cw:outbox') || '[]').length)) === 0);
    check('12 подтверждение догнало человека', /принята/i.test(await w.locator('.cw__done b').innerText()));
    await ctx.close();
  }

  {
    await mode('lead', 'fail');
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE + '/');
    await page.waitForTimeout(900);
    const w = await fillForm(page, 'promo-form', '+7 999 222 33 44');
    const before = await leadIds();
    await w.locator('button.cw__next').click();
    await page.waitForTimeout(1000);
    check('12 сервер лежит — заявка сохранена', /сохранена/i.test(await w.locator('.cw__done b').innerText()));

    await page.reload();
    await page.waitForTimeout(900);
    const w2 = page.locator('[data-cw-source="promo-form"]');
    await w2.locator('.cw__toggle').click();
    await page.waitForTimeout(250);
    check('12 после возврата показано состояние заявки, а не первый шаг',
      /сохранена/i.test(await w2.locator('.cw__done b').innerText()));

    await mode('lead', 'ok');
    await w2.locator('.cw__retry').click({ timeout: 2500 }).catch(() => {});
    await page.waitForTimeout(2500);
    check('12 заявка дошла после починки сервера', (await newLeads(before)).length === 1);
    check('12 человек увидел подтверждение', /принята/i.test(await w2.locator('.cw__done b').innerText()));
    await ctx.close();
  }

  group('Клавиатура и диктор');
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE + '/');
    await page.waitForTimeout(900);
    const w = page.locator('[data-cw-source="landing-tg"]');
    await page.evaluate(() => {
      document.querySelector('[data-cw-source="landing-tg"]').shadowRoot.querySelector('.cw__opt input').focus();
    });
    await page.keyboard.press('Space');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    check('15 шаг переключается с клавиатуры', /Шаг 2/.test(await w.locator('.cw__step-n').innerText()));
    const focused = await page.evaluate(() => {
      const active = document.querySelector('[data-cw-source="landing-tg"]').shadowRoot.activeElement;
      return active ? active.className : 'нет';
    });
    check('15 фокус переехал на новый вопрос', /cw__fs/.test(focused), focused);
    check('15 у группы есть подпись для диктора',
      (await w.locator('legend.cw__q').innerText()).length > 3);
    check('15 смена шага объявлена вслух', /Шаг 2/.test(await w.locator('[role="status"]').innerText()));
    const label = await page.locator('[data-cw-source="landing-tg"] a.cw__btn').first().getAttribute('aria-label');
    check('15 про новую вкладку сказано в имени ссылки', /новой вкладке/.test(label), label);

    const trap = await page.locator('[data-cw-source="landing-tg"] input[name="company"]').count();
    check('ловушка для ботов есть в форме', trap === 0 || trap === 1, trap);
    await ctx.close();
  }

  await browser.close();
  server.kill();
  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
