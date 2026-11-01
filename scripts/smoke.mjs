#!/usr/bin/env node
/**
 * A/B-проверка в headless Chrome: текущая версия (baseline = main) против новой.
 *
 * Поднимает локальный стенд, открывает обе версии в одном браузере и сравнивает
 * отпечаток DOM. Любое расхождение, кроме перечисленного в INTENDED_DIFFS,
 * считается регрессией.
 *
 * Использование:
 *   npm run baseline   # один раз
 *   npm run smoke
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from './serve.mjs';
import { JM_VERSION } from '../site/config.js';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

/** Поля, которые сознательно отличаются между main и phase-0. */
const INTENDED_DIFFS = new Map([['readerLang', 'добавлен lang="ja" для области чтения']]);

/** Поля, зависящие от скорости сети: печатаются, но не сравниваются. */
const VOLATILE = new Set(['words', 'ruby']);

/** Включает 縦書き в текущей версии (в main такого элемента управления нет). */
const VERTICAL_SETUP = `(() => {
  const select = document.getElementById('textOrientation');
  if (!select) return 'missing';
  select.value = 'vertical';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()`;

/** Измерения вертикального режима: ось прокрутки, сторона фуриганы, число столбцов. */
const VERTICAL_PROBE = `(() => {
  const copy = document.querySelector('#readingCopy');
  const reader = document.querySelector('#reader');
  const track = document.querySelector('#track');
  const style = getComputedStyle(copy);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize);

  // В начало книги: проверяем, что видно только первые столбцы и что перед
  // текстом остаётся пустое место.
  document.getElementById('restart').click();
  const readerRect = reader.getBoundingClientRect();
  const firstRect = copy.firstElementChild.getBoundingClientRect();
  const startColumns = Math.round(Math.max(0, firstRect.right - readerRect.left) / lineHeight);
  const startInset = Math.round(((readerRect.right - firstRect.right) / reader.clientWidth) * 100) / 100;

  // Жест двумя пальцами по горизонтали приходит как deltaX.
  const beforeWheel = track.style.transform;
  reader.dispatchEvent(
    new WheelEvent('wheel', { deltaX: 240, deltaY: 0, bubbles: true, cancelable: true }),
  );
  const afterWheel = track.style.transform;

  let rubyOnRight = null;
  const ruby = copy.querySelector('ruby');
  if (ruby && ruby.firstChild) {
    const range = document.createRange();
    range.selectNodeContents(ruby.firstChild);
    const base = range.getBoundingClientRect();
    const rt = ruby.querySelector('rt');
    rubyOnRight = rt ? rt.getBoundingClientRect().left >= base.right - 1 : null;
  }

  const slider = document.getElementById('bookPosition');
  if (slider) { slider.value = '400'; slider.dispatchEvent(new Event('input', { bubbles: true })); }
  return {
    writingMode: style.writingMode,
    rubyOnRight,
    trackTransform: track.style.transform,
    wheelMoved: beforeWheel !== afterWheel,
    startColumns,
    startInset,
    columns: Math.round(copy.getBoundingClientRect().width / lineHeight),
    readerWidth: reader.clientWidth,
    progress: document.getElementById('positionLabel').textContent
  };
})()`;

/** Загружает книгу из трёх глав, чтобы проверить навигацию по главам. */
const CHAPTER_BOOK = [1, 2, 3]
  .map(
    (chapter) =>
      `# 第${chapter}章\n\n` +
      Array.from(
        { length: 8 },
        (_, i) =>
          `第${chapter}章の段落${i + 1}。静かな夜だった。窓の外では細い雨が降り続いていた。`,
      ).join('\n\n'),
  )
  .join('\n\n');

const CHAPTER_SETUP = `(() => {
  const input = document.getElementById('textInput');
  input.value = ${JSON.stringify(CHAPTER_BOOK)};
  document.getElementById('applyText').click();
  return 'ok';
})()`;

/** Переходы по главам: вперёд, назад и рестарт. */
const CHAPTER_PROBE = `(() => {
  const select = () => document.getElementById('chapterSelect').value;
  const offset = () => {
    const match = document.getElementById('track').style.transform.match(/-?[\\d.]+px/);
    return Math.round(Number(match ? match[0].replace('px', '') : 0));
  };
  const click = (id) => document.getElementById(id).click();
  const out = {};
  click('restart');
  out.start = { select: select(), offset: offset() };
  click('nextChapter');
  out.next1 = { select: select(), offset: offset() };
  click('nextChapter');
  out.next2 = { select: select(), offset: offset() };
  click('prevChapter');
  out.prev = { select: select(), offset: offset() };
  click('restart');
  out.restart = { select: select(), offset: offset() };
  return out;
})()`;

/** Вводит запрос в словарь; результаты появятся после загрузки словаря. */
const DICTIONARY_SETUP = `(() => {
  const input = document.getElementById('dictSearch');
  input.value = '静か';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()`;

/** Что показал словарь: число результатов и первое слово. */
const DICTIONARY_PROBE = `(() => {
  const results = [...document.querySelectorAll('.dict-result')];
  return {
    count: results.length,
    first: results[0] ? results[0].querySelector('.dict-result-word').textContent : null,
    status: document.getElementById('dictLoadStatus').textContent
  };
})()`;

const FINGERPRINT = `(() => {
  const copy = document.querySelector('#readingCopy');
  const clone = copy ? copy.cloneNode(true) : null;
  if (clone) clone.querySelectorAll('rt, rp').forEach((node) => node.remove());
  const style = copy ? getComputedStyle(copy) : null;
  const ids = ['playPause','speed','lineWidth','leading','fontSize','furiganaMode','dictSearch','chapterSelect','bookPosition','bookmarkSelect','addBookmark','loadDictionary','dictStateDot'];
  return {
    lang: document.documentElement.lang,
    readerLang: copy ? copy.getAttribute('lang') : null,
    title: document.title,
    paragraphs: copy ? copy.querySelectorAll('p').length : 0,
    words: copy ? copy.querySelectorAll('.word').length : 0,
    ruby: copy ? copy.querySelectorAll('ruby').length : 0,
    cleanText: clone ? clone.textContent.replace(/\\s+/g, ' ').trim() : '',
    fontSize: style ? style.fontSize : null,
    lineHeight: style ? style.lineHeight : null,
    mincho: style ? style.fontFamily.includes('Mincho') : false,
    controls: ids.every((id) => document.getElementById(id)),
    bootHidden: document.getElementById('bootSplash') ? document.getElementById('bootSplash').hidden : null,
    shelfCards: document.querySelectorAll('.book-card').length,
    chapterCount: document.getElementById('chapterSelect') ? document.getElementById('chapterSelect').options.length : 0,
    dictZipLinks: [...document.querySelectorAll('.dict-fallback-actions a')].map((a) => (a.getAttribute('href') || '').split('/').pop())
  };
})()`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  return CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? null;
}

class CDP {
  static async connect(wsUrl) {
    const socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return new CDP(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject, timer } = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
      }
    });
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method}: таймаут`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function waitForDevToolsPort(profileDir, timeoutMs = 20000) {
  const file = path.join(profileDir, 'DevToolsActivePort');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(file)) {
      const [port] = fs.readFileSync(file, 'utf8').split('\n');
      if (port) return Number(port);
    }
    await delay(100);
  }
  throw new Error('Chrome не открыл DevTools-порт');
}

async function evaluate(cdp, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text ?? 'ошибка evaluate');
  return result.value;
}

async function waitFor(cdp, expression, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(cdp, expression).catch(() => false)) return true;
    await delay(150);
  }
  return false;
}

async function capture(
  port,
  url,
  {
    deep = false,
    afterLoad = null,
    extra = null,
    readyExpression = null,
    readyTimeout = 60000,
  } = {},
) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
  });
  const target = await response.json();
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  const errors = [];

  cdp.on('Runtime.exceptionThrown', (params) => {
    const details = params.exceptionDetails ?? {};
    const where = details.url ? ` (${details.url}:${details.lineNumber ?? '?'})` : '';
    errors.push((details.exception?.description ?? details.text ?? 'исключение') + where);
  });
  cdp.on('Runtime.consoleAPICalled', (params) => {
    if (params.type !== 'error') return;
    errors.push(params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
  });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // Пропускаем экран первого запуска: он заблокировал бы интерфейс на 33 МБ загрузки.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem(${JSON.stringify(`yomiyasui-first-setup-${JM_VERSION}`)}, 'done'); } catch (_) {}`,
  });

  await cdp.send('Page.navigate', { url });
  const ready = await waitFor(cdp, "document.querySelectorAll('#readingCopy p').length > 0");
  if (!ready) errors.push('демо-текст не появился за 20 с');

  if (deep) {
    // Ждём, пока анализатор разметит текст: это проверяет Kuromoji + воркер.
    const tokenized = await waitFor(
      cdp,
      "document.querySelectorAll('#readingCopy .word').length > 0",
      180000,
    );
    if (!tokenized) errors.push('анализатор не разметил текст за 180 с');
  } else {
    await delay(1500);
  }

  if (afterLoad) {
    await evaluate(cdp, afterLoad);
    if (readyExpression) {
      const readyAgain = await waitFor(cdp, readyExpression, readyTimeout);
      if (!readyAgain) errors.push('после подготовки страница не достигла нужного состояния');
    }
    await delay(900);
  }

  const fingerprint = await evaluate(cdp, FINGERPRINT);
  const extraData = extra ? await evaluate(cdp, extra) : null;
  cdp.close();
  await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
  return { fingerprint, errors, extra: extraData };
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error('ERROR: Chrome/Chromium не найден. Укажите CHROME_PATH.');
    process.exit(1);
  }
  if (!fs.existsSync(path.join('baseline', 'index.html'))) {
    console.error('ERROR: нет baseline/. Выполните: npm run baseline');
    process.exit(1);
  }

  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'yomiyasui-smoke-'));
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--hide-scrollbars',
      '--mute-audio',
      // Chrome не может поднять собственные песочницы и crashpad не во всех
      // окружениях (macOS-песочница, CI-контейнер) — для локального A/B это не нужно.
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-crash-reporter',
      '--disable-breakpad',
      '--no-crashpad',
      `--crash-dumps-dir=${profileDir}`,
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      `--user-data-dir=${profileDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const cleanup = async () => {
    child.kill('SIGKILL');
    server.close();
    await fsp.rm(profileDir, { recursive: true, force: true });
  };

  try {
    const devtoolsPort = await waitForDevToolsPort(profileDir);
    const deep = process.argv.includes('--full');
    const baseline = await capture(devtoolsPort, `${base}/baseline/`, { deep });
    const current = await capture(devtoolsPort, `${base}/site/`, { deep });
    const vertical = await capture(devtoolsPort, `${base}/site/`, {
      deep: true,
      afterLoad: VERTICAL_SETUP,
      extra: VERTICAL_PROBE,
    });
    const dictionary = await capture(devtoolsPort, `${base}/site/`, {
      afterLoad: DICTIONARY_SETUP,
      readyExpression: "document.querySelectorAll('.dict-result').length > 0",
      readyTimeout: 240000,
      extra: DICTIONARY_PROBE,
    });
    const chapters = await capture(devtoolsPort, `${base}/site/`, {
      afterLoad: CHAPTER_SETUP,
      readyExpression:
        "document.getElementById('chapterSelect').options.length >= 3 && " +
        "document.querySelectorAll('#readingCopy .word').length > 0",
      extra: CHAPTER_PROBE,
    });

    const keys = [
      ...new Set([...Object.keys(baseline.fingerprint), ...Object.keys(current.fingerprint)]),
    ].sort();
    const mismatches = [];
    const rows = [];

    for (const key of keys) {
      const before = baseline.fingerprint[key];
      const after = current.fingerprint[key];
      const same = JSON.stringify(before) === JSON.stringify(after);
      let status = same ? 'ok' : 'DIFF';
      if (!same && INTENDED_DIFFS.has(key)) status = 'intended';
      else if (!same && VOLATILE.has(key) && !deep) status = 'timing';
      else if (!same) mismatches.push(key);
      rows.push({ key, before, after, status });
    }

    console.log(
      'Поле                     main                      phase-0                   статус',
    );
    console.log('-'.repeat(96));
    for (const { key, before, after, status } of rows) {
      const format = (value) => {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        return (text ?? 'null').length > 24 ? `${text.slice(0, 21)}…` : (text ?? 'null');
      };
      console.log(
        `${key.padEnd(24)} ${format(before).padEnd(25)} ${format(after).padEnd(25)} ${status}`,
      );
    }

    console.log();
    for (const [key, reason] of INTENDED_DIFFS) {
      if (rows.some((row) => row.key === key && row.status === 'intended')) {
        console.log(`  intended: ${key} — ${reason}`);
      }
    }

    const v = vertical.extra || {};
    console.log(
      `\n縦書き: writing-mode=${v.writingMode}, столбцов всего ${v.columns}, в начале видно ${v.startColumns}, ` +
        `пустое поле перед текстом ${v.startInset} ширины, фуригана справа: ${v.rubyOnRight}, ` +
        `прокрутка ${v.trackTransform}, жест тачпада: ${v.wheelMoved ? 'да' : 'нет'}`,
    );

    const d = dictionary.extra || {};
    console.log(`\nСловарь: ${d.count} результат(ов), первое слово «${d.first}» · ${d.status}`);

    const c = chapters.extra || {};
    console.log(
      `\nГлавы: старт ${c.start?.select}/${c.start?.offset}px, вперёд ${c.next1?.select}, ` +
        `${c.next2?.select}, назад ${c.prev?.select} (${c.prev?.offset}px), рестарт ${c.restart?.select}/${c.restart?.offset}px`,
    );

    const problems = [];
    if (mismatches.length) problems.push(`расхождения: ${mismatches.join(', ')}`);
    if (current.fingerprint.readerLang !== 'ja')
      problems.push('у новой версии #readingCopy без lang="ja"');
    if (deep && !(current.fingerprint.words > 0))
      problems.push('анализатор не разметил ни одного слова');
    if (deep && current.fingerprint.ruby === 0) problems.push('фуригана не отрисована');
    if (current.errors.length) problems.push(`ошибки в консоли: ${current.errors.join(' | ')}`);
    if (vertical.errors.length)
      problems.push(`ошибки в вертикальном режиме: ${vertical.errors.join(' | ')}`);
    if (v.writingMode !== 'vertical-rl')
      problems.push(`вертикальный режим не включился (writing-mode=${v.writingMode})`);
    if (!String(v.trackTransform || '').startsWith('translateX'))
      problems.push(`прокрутка не по горизонтали: ${v.trackTransform}`);
    if (v.rubyOnRight !== true) problems.push('фуригана не справа от текста');
    if (!(v.columns > 1)) problems.push(`ожидалось несколько столбцов, получено ${v.columns}`);
    if (!(v.startColumns >= 1 && v.startColumns <= 4)) {
      problems.push(`в начале должно быть видно 1-4 столбца, получено ${v.startColumns}`);
    }
    if (!(v.startInset >= 0.5 && v.startInset <= 0.9)) {
      problems.push(`перед текстом должно оставаться 0.5-0.9 ширины, получено ${v.startInset}`);
    }
    if (v.wheelMoved !== true) problems.push('горизонтальный жест тачпада не прокручивает текст');
    if (dictionary.errors.length) problems.push(`ошибки словаря: ${dictionary.errors.join(' | ')}`);
    if (!(d.count > 0)) problems.push('поиск по「静か」ничего не вернул');
    if (d.first !== '静か')
      problems.push(`первым результатом ожидалось «静か», получено «${d.first}»`);
    if (chapters.errors.length)
      problems.push(`ошибки в навигации по главам: ${chapters.errors.join(' | ')}`);
    if (c.start?.select !== '0' || c.start?.offset !== 0)
      problems.push('книга открылась не с первой главы');
    if (c.next1?.select !== '1' || !(c.next1?.offset > 0))
      problems.push('переход вперёд на главу 1 не сработал');
    if (c.next2?.select !== '2' || !(c.next2?.offset > c.next1?.offset))
      problems.push('переход вперёд на главу 2 не сработал');
    if (c.prev?.select !== '1' || !(c.prev?.offset < c.next2?.offset))
      problems.push('переход назад на главу 1 не сработал');
    if (c.restart?.select !== '0' || c.restart?.offset !== 0)
      problems.push('рестарт не вернул к началу книги');
    if (baseline.errors.length) problems.push(`ошибки в main: ${baseline.errors.join(' | ')}`);

    console.log();
    if (problems.length) {
      console.error(problems.map((problem) => `FAIL: ${problem}`).join('\n'));
      process.exitCode = 1;
    } else {
      console.log(
        `PASS: поведение совпадает (${keys.length} полей); текста ${current.fingerprint.cleanText.length} символов, ` +
          `абзацев ${current.fingerprint.paragraphs}, слов размечено ${current.fingerprint.words}.`,
      );
    }
  } finally {
    await cleanup();
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
