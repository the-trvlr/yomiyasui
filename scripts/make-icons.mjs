#!/usr/bin/env node
/**
 * Генерация PNG-иконок приложения из site/app-icon.svg.
 *
 * Иконки коммитятся в репозиторий, но их источник — SVG. Если иконка меняется,
 * пересоберите PNG этим скриптом (нужен установленный Chrome/Chromium).
 *
 *   node scripts/make-icons.mjs
 *
 * Chrome используется как растеризатор: он точно повторяет то, что увидит
 * пользователь, и не требует дополнительных зависимостей.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const chrome = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!chrome) {
  console.error('Chrome/Chromium не найден. Укажите CHROME_PATH.');
  process.exit(1);
}

const svg = fs.readFileSync(path.join(ROOT, 'site/app-icon.svg'), 'utf8');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yomiyasui-icons-'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function waitForDevToolsPort(timeoutMs = 20000) {
  const file = path.join(profile, 'DevToolsActivePort');
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

const devtools = await waitForDevToolsPort();
const target = await (
  await fetch(`http://127.0.0.1:${devtools}/json/new?about:blank`, { method: 'PUT' })
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

async function render(relativePath, size, { background = 'transparent', padding = 0 } = {}) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: size,
    height: size,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${size}px;height:${size}px;overflow:hidden;
      background:${background === 'transparent' ? 'transparent' : background}}
    .wrap{width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;
      box-sizing:border-box;padding:${Math.round(size * padding)}px}
    .wrap>div{width:100%;height:100%}
    svg{width:100%;height:100%;display:block}
  </style></head><body><div class="wrap"><div>${svg}</div></div></body></html>`;

  const { frameTree } = await send('Page.getFrameTree');
  await send('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
  await delay(250);

  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    omitBackground: background === 'transparent',
  });
  const file = path.join(ROOT, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log(`${relativePath} — ${size}x${size}, ${fs.statSync(file).size} байт`);
}

await send('Page.enable');

// «any»: прозрачный фон, логотип почти на всю площадь.
await render('site/icons/icon-192.png', 192, { padding: 0.02 });
await render('site/icons/icon-512.png', 512, { padding: 0.02 });

// «maskable»: фон темы на всю площадь, логотип в безопасной зоне 80%.
await render('site/icons/icon-maskable-512.png', 512, { background: '#f4eedf', padding: 0.12 });

// iOS добавляет скругления сам и не любит прозрачность — фон обязателен.
await render('site/icons/apple-touch-icon.png', 180, { background: '#f4eedf', padding: 0.06 });

socket.close();
child.kill('SIGKILL');
fs.rmSync(profile, { recursive: true, force: true });
console.log('Готово.');
