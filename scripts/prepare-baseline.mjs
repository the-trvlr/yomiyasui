#!/usr/bin/env node
/**
 * Готовит `baseline/` — рабочую копию ветки main для сравнения версий.
 *
 * Ничего не коммитится и не пушится: файлы только извлекаются из объекта Git.
 *
 * Использование:
 *   node scripts/prepare-baseline.mjs            # ветка main
 *   node scripts/prepare-baseline.mjs origin/main
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ref = process.argv[2] ?? 'main';
const outDir = path.join(ROOT, 'baseline');

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, ...options });
}

const files = git(['ls-tree', '-r', '--name-only', ref, 'site'], { encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

if (!files.length) {
  console.error(`ERROR: в ${ref} нет каталога site/.`);
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const file of files) {
  const relative = file.replace(/^site\//, '');
  const destination = path.join(outDir, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, git(['show', `${ref}:${file}`]));
}

console.log(`OK: ${files.length} файл(ов) из ${ref} → baseline/`);
