#!/usr/bin/env node
/**
 * Проверка статического сайта: разметка, внешние ресурсы, единый источник версии.
 * Использование: node scripts/check-html.mjs [site/index.html]
 */

import path from 'node:path';
import { checkSite } from './lib/checks.mjs';

const target = process.argv[2] ?? 'site/index.html';
const { failures, stats } = checkSite(target);

if (failures.length) {
  console.error(failures.map((failure) => `ERROR: ${failure}`).join('\n'));
  process.exit(1);
}

console.log(
  `OK: ${path.normalize(target)} — ${stats.ids} unique ids, ` +
    `${stats.stylesheets.length} stylesheet(s), ${stats.scripts.length} external script(s).`,
);
