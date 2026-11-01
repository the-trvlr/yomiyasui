/**
 * Структурные проверки сайта.
 *
 * Вынесено из CLI, чтобы те же правила можно было прогонять из `node --test`
 * на испорченных копиях сайта (см. tests/checks.test.mjs).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REQUIRED_IDS = [
  'reader',
  'readingCopy',
  'track',
  'playPause',
  'speed',
  'lineWidth',
  'leading',
  'fontSize',
  'furiganaMode',
  'textOrientation',
  'dictSearch',
  'dictSearchResults',
  'dictDetail',
  'chapterSelect',
  'bookPosition',
  'bootSplash',
];

/** Синтаксис JavaScript через `node --check` (ESM определяется по package.json). */
function syntaxErrors(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status === 0) return null;
  return (result.stderr || result.stdout || 'неизвестная ошибка').trim();
}

/**
 * @param {string} htmlPath путь к index.html
 * @returns {{failures: string[], stats: Record<string, unknown>}}
 */
export function checkSite(htmlPath) {
  const failures = [];
  const stats = { ids: 0, scripts: [], stylesheets: [] };

  if (!fs.existsSync(htmlPath)) {
    return { failures: [`${htmlPath} does not exist.`], stats };
  }

  const html = fs.readFileSync(htmlPath, 'utf8');
  const siteDir = path.dirname(htmlPath);

  // --- Разметка -------------------------------------------------------------
  if (!/^\s*<!doctype html>/i.test(html)) failures.push('Missing HTML5 doctype.');
  if (!/<html\b[^>]*\blang=["']ru["']/i.test(html)) failures.push('Expected <html lang="ru">.');
  if (!/<meta\b[^>]*name=["']viewport["']/i.test(html)) failures.push('Missing viewport meta tag.');
  if (!/<title>[^<]+<\/title>/.test(html)) failures.push('Missing document title.');
  if (!/読みやすい/.test(html)) failures.push('Expected app name 読みやすい is missing.');

  for (const id of REQUIRED_IDS) {
    if (!new RegExp(`\\bid=["']${id}["']`).test(html))
      failures.push(`Missing required element #${id}.`);
  }
  if (!/\bid=["']readingCopy["'][^>]*\blang=["']ja["']/.test(html)) {
    failures.push('Reading area #readingCopy must declare lang="ja".');
  }

  // Идентификаторы должны быть уникальны; из разметки вырезаем script/style.
  const markup = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, '');
  const ids = [...markup.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]);
  stats.ids = ids.length;
  const seen = new Set();
  const duplicates = new Set();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  if (duplicates.size) failures.push(`Duplicate HTML id(s): ${[...duplicates].join(', ')}`);

  if (/\son[a-z]+\s*=\s*["']/i.test(markup))
    failures.push('Inline event handlers are not allowed.');

  // --- Внешние ресурсы ------------------------------------------------------
  const inlineStyles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].filter(
    (m) => m[1].trim().length > 0,
  );
  if (inlineStyles.length)
    failures.push('Inline <style> blocks are not allowed; use site/app.css.');

  const stylesheets = [...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi)].map(
    (m) => /href=["']([^"']+)["']/.exec(m[0])?.[1] ?? '',
  );
  stats.stylesheets = stylesheets;
  if (!stylesheets.length) failures.push('No external stylesheet found.');

  const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].filter(
    (m) => !/\bsrc\s*=/.test(m[1]) && m[2].trim().length > 0,
  );
  if (inlineScripts.length) {
    failures.push('Inline JavaScript is not allowed; use site/app.js (type="module").');
  }

  const moduleScripts = [
    ...html.matchAll(/<script\b([^>]*\bsrc\s*=\s*["'][^"']+["'][^>]*)>/gi),
  ].map((m) => m[1]);
  stats.scripts = moduleScripts;
  if (!moduleScripts.some((attrs) => /\btype=["']module["']/.test(attrs))) {
    failures.push('Expected <script type="module" src="./app.js">.');
  }

  for (const href of stylesheets) {
    const file = path.join(siteDir, href.replace(/^\.\//, ''));
    if (!fs.existsSync(file)) {
      failures.push(`Stylesheet ${href} does not exist.`);
      continue;
    }
    const css = fs.readFileSync(file, 'utf8');
    if (css.trim().length < 1000) failures.push(`Stylesheet ${href} looks empty.`);
    if (!/:root\s*\{/.test(css)) failures.push(`Stylesheet ${href} is missing the :root block.`);
    if (css.includes('</style>'))
      failures.push(`Stylesheet ${href} contains a stray </style> tag.`);
  }

  const appPath = path.join(siteDir, 'app.js');
  if (!fs.existsSync(appPath)) failures.push('site/app.js is missing.');
  else {
    const app = fs.readFileSync(appPath, 'utf8');
    if (!/from\s+['"]\.\/config\.js['"]/.test(app)) {
      failures.push('site/app.js must import "./config.js".');
    }
    if (/<\/script\s*>/i.test(app)) {
      failures.push('site/app.js contains a literal </script> tag.');
    }
    const error = syntaxErrors(appPath);
    if (error) failures.push(`site/app.js failed syntax check:\n${error}`);
  }

  const configPath = path.join(siteDir, 'config.js');
  if (!fs.existsSync(configPath)) failures.push('site/config.js is missing.');
  else {
    const config = fs.readFileSync(configPath, 'utf8');
    for (const name of ['APP_VERSION', 'JM_VERSION', 'JM_DB_NAME']) {
      if (!new RegExp(`export const ${name}\\b`).test(config)) {
        failures.push(`site/config.js must export ${name}.`);
      }
    }
    const error = syntaxErrors(configPath);
    if (error) failures.push(`site/config.js failed syntax check:\n${error}`);
  }

  // Версия в статичной разметке должна совпадать с site/config.js.
  if (fs.existsSync(configPath)) {
    const config = fs.readFileSync(configPath, 'utf8');
    const appVersion = /export const APP_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(config)?.[1];
    if (appVersion) {
      for (const id of ['brandVersionBadge', 'bootVersionBadge']) {
        const match = new RegExp(`id=["']${id}["'][^>]*>v([^<]+)<`).exec(html);
        if (!match) failures.push(`Missing #${id}.`);
        else if (match[1] !== appVersion) {
          failures.push(`#${id} shows v${match[1]} but site/config.js says v${appVersion}.`);
        }
      }
    }
  }

  const workerPath = path.join(siteDir, 'analyzer-worker.js');
  if (!fs.existsSync(workerPath)) failures.push('site/analyzer-worker.js is missing.');
  else {
    const error = syntaxErrors(workerPath);
    if (error) failures.push(`site/analyzer-worker.js failed syntax check:\n${error}`);
  }

  // --- Единый источник версии JMdict ---------------------------------------
  const versionLiteral = /\d+\.\d+\.\d+\+\d{8,}/;
  for (const [name, text] of [
    ['site/index.html', html],
    ['site/app.js', fs.existsSync(appPath) ? fs.readFileSync(appPath, 'utf8') : ''],
  ]) {
    const match = versionLiteral.exec(text);
    if (match) {
      failures.push(
        `${name} hardcodes the JMdict version (${match[0]}); read it from site/config.js.`,
      );
    }
    if (/jmdict-(eng|rus)-\d/.test(text)) {
      failures.push(`${name} hardcodes a JMdict archive name; build it from JM_VERSION.`);
    }
  }

  // --- Иконка и манифест ----------------------------------------------------
  const iconPath = path.join(siteDir, 'app-icon.svg');
  if (!fs.existsSync(iconPath)) failures.push('Missing app-icon.svg.');
  else if (!fs.readFileSync(iconPath, 'utf8').includes('viewBox="0 0 512 512"')) {
    failures.push('App icon SVG is missing the expected 512x512 viewBox.');
  }

  const manifestPath = path.join(siteDir, 'manifest.webmanifest');
  if (!fs.existsSync(manifestPath)) failures.push('Missing manifest.webmanifest.');
  else {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (
        !Array.isArray(manifest.icons) ||
        !manifest.icons.some((icon) => icon.src === './app-icon.svg')
      ) {
        failures.push('Manifest must reference ./app-icon.svg.');
      }
      if (!manifest.start_url) failures.push('Manifest is missing start_url.');
      if (manifest.display !== 'standalone')
        failures.push('Manifest display should be standalone.');
    } catch (error) {
      failures.push(`Invalid manifest.webmanifest: ${error.message}`);
    }
  }

  return { failures, stats };
}
