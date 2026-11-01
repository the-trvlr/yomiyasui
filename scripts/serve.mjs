#!/usr/bin/env node
/**
 * Локальный стенд 読みやすい.
 *
 * Отдаёт `site/` (и, если он подготовлен, `baseline/` — копию ветки main).
 * Ресурсы, которые не коммитятся (`vendor/`, `data/`), проксируются из
 * опубликованной сборки, поэтому для проверки не нужно скачивать 33 МБ.
 *
 * Использование:
 *   node scripts/serve.mjs            # http://127.0.0.1:8000/site/
 *   node scripts/serve.mjs --port 9000
 *   node scripts/serve.mjs --offline  # без прокси
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROXY_BASE = 'https://the-trvlr.github.io/yomiyasui';
export const PREFIXES = ['site', 'baseline'];
export const CACHE_DIR = path.join(ROOT, '.cache', 'proxy');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.dat': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
  res.end(body);
}

async function serveFile(res, file, method) {
  const stat = await fsp.stat(file);
  if (!stat.isFile()) return false;
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-store',
  });
  if (method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(file).pipe(res);
  return true;
}

async function proxy(res, pathname, proxyBase, method) {
  // Ассеты сборки большие (17,8 МБ Kuromoji + 15,4 МБ JMdict), поэтому кэшируем
  // их на диск: повторные прогоны и обычная разработка не требуют сети.
  const cachePath = path.join(CACHE_DIR, pathname.replace(/^\/+/, ''));
  if (cachePath.startsWith(CACHE_DIR) && fs.existsSync(cachePath)) {
    return serveFile(res, cachePath, method);
  }

  const target = `${proxyBase}${pathname}`;
  const upstream = await fetch(target, { redirect: 'follow' });
  if (!upstream.ok) return false;

  const body = Buffer.from(await upstream.arrayBuffer());
  if (cachePath.startsWith(CACHE_DIR)) {
    try {
      await fsp.mkdir(path.dirname(cachePath), { recursive: true });
      await fsp.writeFile(cachePath, body);
    } catch {
      // Кэш — оптимизация, а не условие работы.
    }
  }

  res.writeHead(200, {
    'content-type':
      upstream.headers.get('content-type') ??
      MIME[path.extname(pathname).toLowerCase()] ??
      'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  if (method === 'HEAD') {
    res.end();
    return true;
  }
  res.end(body);
  return true;
}

/**
 * @param {{root?: string, proxy?: string|null}} options
 * @returns {import('node:http').Server}
 */
export function createServer({ root = ROOT, proxy: proxyBase = PROXY_BASE } = {}) {
  return http.createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      return send(res, 405, 'Method Not Allowed', { allow: 'GET, HEAD' });
    }

    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);

      if (pathname === '/' || pathname === '') {
        return send(res, 302, 'Redirecting to /site/', { location: '/site/' });
      }

      if (!PREFIXES.some((prefix) => pathname.startsWith(`/${prefix}/`))) {
        return send(res, 404, 'Not found. Try /site/ or /baseline/.\n', {
          'content-type': 'text/plain; charset=utf-8',
        });
      }

      const file = path.join(root, path.normalize(pathname));
      if (!file.startsWith(root + path.sep)) {
        return send(res, 403, 'Forbidden');
      }

      const candidate = pathname.endsWith('/') ? path.join(file, 'index.html') : file;
      if (fs.existsSync(candidate)) {
        if (await serveFile(res, candidate, method)) return;
      }

      // Ассеты сборки (vendor/data) не коммитятся — берём их из опубликованной версии.
      if (proxyBase) {
        const upstreamPath = pathname.replace(/^\/(site|baseline)/, '');
        if (await proxy(res, upstreamPath, proxyBase, method)) return;
      }

      return send(res, 404, `Not found: ${pathname}\n`, {
        'content-type': 'text/plain; charset=utf-8',
      });
    } catch (error) {
      if (!res.headersSent) {
        send(res, 500, `Server error: ${error?.message ?? error}\n`, {
          'content-type': 'text/plain; charset=utf-8',
        });
      } else {
        res.end();
      }
    }
  });
}

async function main() {
  const args = process.argv.slice(2);
  const offline = args.includes('--offline');
  const portFlag = args.indexOf('--port');
  const port = Number(portFlag >= 0 ? args[portFlag + 1] : process.env.PORT || 8000);

  const server = createServer({ proxy: offline ? null : PROXY_BASE });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const actualPort = server.address().port;
  const base = `http://127.0.0.1:${actualPort}`;
  const hasBaseline = fs.existsSync(path.join(ROOT, 'baseline', 'index.html'));

  console.log('読みやすい — локальный стенд');
  console.log(`  новая версия : ${base}/site/`);
  if (hasBaseline) console.log(`  текущий main : ${base}/baseline/`);
  else console.log('  текущий main : не подготовлен (npm run baseline)');
  console.log(
    offline
      ? '  режим        : offline (vendor/data только локально)'
      : '  режим        : vendor/data проксируются из опубликованной сборки',
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
