'use strict';

/**
 * Service Worker 読みやすい.
 *
 * Задачи:
 * - оболочка приложения кэшируется при установке, поэтому приложение
 *   открывается и без сети;
 * - анализатор (`vendor/`) и словари (`data/`) кэшируются по мере
 *   использования — они слишком большие, чтобы тянуть их на install;
 * - при обновлении версии старые кэши удаляются, поэтому файлы разных
 *   версий не смешиваются.
 *
 * APP_VERSION и JM_VERSION должны совпадать с site/config.js — это проверяет
 * scripts/check-html.mjs, иначе кэш переживёт обновление словаря.
 */

const APP_VERSION = '1.5';
const JM_VERSION = '3.6.2+20261012204142';

const SHELL_CACHE = `yomiyasui-shell-${APP_VERSION}`;
const ASSET_CACHE = `yomiyasui-assets-${APP_VERSION}-${JM_VERSION.replace(/[^0-9a-zA-Z.-]/g, '_')}`;

const SHELL_FILES = [
  './',
  './index.html',
  './offline.html',
  './app.css',
  './app.js',
  './config.js',
  './analyzer-worker.js',
  './manifest.webmanifest',
  './app-icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // cache: 'reload' — не собираем оболочку из устаревшего HTTP-кэша.
      await cache.addAll(SHELL_FILES.map((file) => new Request(file, { cache: 'reload' })));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key.startsWith('yomiyasui-') && !keep.has(key)).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(navigateResponse(request));
    return;
  }
  event.respondWith(assetResponse(request));
});

async function navigateResponse(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put('./index.html', response.clone()).catch(() => {});
    }
    return response;
  } catch (_) {
    const cache = await caches.open(SHELL_CACHE);
    const cached = (await cache.match('./index.html')) || (await cache.match('./offline.html'));
    return cached || new Response('Офлайн. Откройте приложение снова, когда появится сеть.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

async function assetResponse(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.ok && isAppAsset(request.url)) {
      const cache = await caches.open(ASSET_CACHE);
      // Квота может закончиться — тогда просто не кэшируем этот файл.
      await cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (_) {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

function isAppAsset(href) {
  const { pathname } = new URL(href);
  return pathname.includes('/vendor/') || pathname.includes('/data/');
}
