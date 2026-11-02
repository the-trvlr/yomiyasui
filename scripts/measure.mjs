#!/usr/bin/env node
/**
 * Замер загрузки словаря и поиска для одного адреса.
 *
 *   node scripts/measure.mjs --url http://127.0.0.1:8000/site/ --label compiled
 *
 * Печатает JSON: время до демо-текста, до готового словаря, число записей,
 * результаты поиска по-японски и по-русски.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const url = arg('--url');
const label = arg('--label', 'run');
const timeout = Number(arg('--timeout', '300000'));
const cpuRate = Number(arg('--cpu', '4'));
const network = arg('--network', null);

if (!url) {
  console.error('Укажите --url');
  process.exit(1);
}

const chrome = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!chrome) {
  console.error('Chrome/Chromium не найден. Укажите CHROME_PATH.');
  process.exit(1);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yomiyasui-measure-'));
const child = spawn(
  chrome,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--no-crashpad',
    `--crash-dumps-dir=${profile}`,
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDevToolsPort(dir, timeoutMs = 20000) {
  const file = path.join(dir, 'DevToolsActivePort');
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

const devtools = await waitForDevToolsPort(profile);
const target = await (
  await fetch(`http://127.0.0.1:${devtools}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
).json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 0;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text ?? 'evaluate error');
  return result.value;
};

async function waitFor(expression, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(expression).catch(() => false)) return Date.now() - started;
    await delay(200);
  }
  return null;
}

await send('Page.enable');
await send('Runtime.enable');
// Телефонное окружение: без замедления CPU разница в парсинге почти не видна.
await send('Emulation.setCPUThrottlingRate', { rate: cpuRate });

// Сеть: на быстром локальном стенде порядок загрузок не виден, поэтому можно
// включить профиль 4G/3G и сравнить версии в одинаковых условиях.
const NETWORKS = {
  '4g': { latency: 70, downloadThroughput: 1.5 * 1024 * 1024 },
  '3g': { latency: 150, downloadThroughput: 400 * 1024 },
};
if (network && NETWORKS[network]) {
  await send('Network.enable');
  await send('Network.emulateNetworkConditions', {
    offline: false,
    latency: NETWORKS[network].latency,
    downloadThroughput: NETWORKS[network].downloadThroughput,
    uploadThroughput: 512 * 1024,
  });
}
// Пропускаем экран первого запуска.
const { JM_VERSION } = await import('../site/config.js');
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { localStorage.setItem(${JSON.stringify(
    `yomiyasui-first-setup-${JM_VERSION}`,
  )}, 'done'); } catch (_) {}`,
});

const startedAt = Date.now();
await send('Page.navigate', { url });

const tDemo = await waitFor("document.querySelectorAll('#readingCopy p').length > 0", 30000);

// Ждём полной готовности словаря. Точные промежуточные метки берём из
// performance.mark() в приложении — статус «ядро готово» живёт слишком мало.
const readyAt = await waitFor(
  "/Полный JMdict/.test(document.getElementById('dictLoadStatus').textContent)",
  timeout,
);

const status = await evaluate(
  "document.getElementById('dictLoadStatus').textContent || document.getElementById('systemStatus').textContent",
);

async function search(query) {
  await evaluate(
    `(() => { const input = document.getElementById('dictSearch'); input.value = ${JSON.stringify(
      query,
    )}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  await delay(500);
  const found = await waitFor("document.querySelectorAll('.dict-result').length > 0", 15000);
  await delay(400);
  const count = await evaluate("document.querySelectorAll('.dict-result').length");
  const first = await evaluate(
    "document.querySelector('.dict-result .dict-result-word')?.textContent ?? null",
  );
  return { query, found: found !== null, count, first };
}

const japanese = await search('静か');
const russian = await search('ночь');

const marks = await evaluate(`(() => {
  const rows = performance.getEntriesByType('mark')
    .filter((entry) => entry.name.startsWith('dict:'))
    .map((entry) => ({ name: entry.name, at: Math.round(entry.startTime) }));
  const out = {};
  let previous = null;
  for (const row of rows) {
    out[row.name] = row.at;
    if (previous && /:parsed$/.test(row.name)) out['parse:' + row.name] = row.at - previous.at;
    previous = row;
  }
  return out;
})()`).catch(() => null);

const markAt = (name) => (marks && typeof marks[name] === 'number' ? marks[name] : null);
const coreReadyMs = markAt('dict:core:indexed');
const fullReadyMs = markAt('dict:full:indexed');
const indexMs =
  markAt('dict:full:ingested') !== null && fullReadyMs !== null
    ? fullReadyMs - markAt('dict:full:ingested')
    : null;

const heap = await send('Runtime.getHeapUsage').catch(() => null);

console.log(
  JSON.stringify(
    {
      label,
      url,
      cpuRate,
      network: network ?? 'local',
      totalMs: Date.now() - startedAt,
      demoMs: tDemo,
      dictionaryMs: readyAt ?? fullReadyMs,
      searchReadyMs: coreReadyMs,
      indexBuildMs: indexMs,
      status,
      searches: [japanese, russian],
      heapMb: heap ? Math.round(heap.usedSize / 1048576) : null,
      marks,
    },
    null,
    2,
  ),
);

socket.close();
child.kill('SIGKILL');
fs.rmSync(profile, { recursive: true, force: true });
process.exit(0);
