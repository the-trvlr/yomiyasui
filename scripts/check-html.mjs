import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const target = process.argv[2] ?? 'site/index.html';
if (!fs.existsSync(target)) {
  console.error(`ERROR: ${target} does not exist.`);
  process.exit(1);
}
const html = fs.readFileSync(target, 'utf8');
const failures = [];

if (!/^\s*<!doctype html>/i.test(html)) failures.push('Missing HTML5 doctype.');
if (!/<html\b[^>]*\blang=["']ru["']/i.test(html)) failures.push('Expected <html lang="ru">.');
if (!/<title>[^<]+<\/title>/i.test(html)) failures.push('Missing document title.');
if (!/読みやすい/.test(html)) failures.push('Expected app name 読みやすい is missing.');
if (!/id=["']reader["']/.test(html)) failures.push('Reader area element not found.');

const staticMarkup = html.split(/<script\b/i, 1)[0];
const ids = [...staticMarkup.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]);
const seen = new Set();
const duplicates = new Set();
for (const id of ids) {
  if (seen.has(id)) duplicates.add(id);
  seen.add(id);
}
if (duplicates.size) failures.push(`Duplicate HTML id(s): ${[...duplicates].join(', ')}`);

const scriptBlocks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
  .filter((m) => !/\bsrc\s*=/.test(m[1]));

const siteDir = path.dirname(target);
const iconPath = path.join(siteDir, 'app-icon.svg');
const manifestPath = path.join(siteDir, 'manifest.webmanifest');
if (!fs.existsSync(iconPath)) failures.push('Missing app-icon.svg.');
else if (!fs.readFileSync(iconPath, 'utf8').includes('viewBox="0 0 512 512"')) failures.push('App icon SVG is missing the expected 512x512 viewBox.');
if (!fs.existsSync(manifestPath)) failures.push('Missing manifest.webmanifest.');
else {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(manifest.icons) || !manifest.icons.some((icon) => icon.src === './app-icon.svg')) failures.push('Manifest must reference ./app-icon.svg.');
  } catch (error) { failures.push(`Invalid manifest.webmanifest: ${error.message}`); }
}
if (!scriptBlocks.length) failures.push('No inline JavaScript found.');

if (failures.length) {
  console.error(failures.map((f) => `ERROR: ${f}`).join('\n'));
  process.exit(1);
}

let checked = 0;
for (const [, , source] of scriptBlocks) {
  const tempFile = path.join(os.tmpdir(), `yomiyasui-inline-${checked}.js`);
  fs.writeFileSync(tempFile, source, 'utf8');
  const result = spawnSync(process.execPath, ['--check', tempFile], { encoding: 'utf8' });
  fs.rmSync(tempFile, { force: true });
  if (result.status !== 0) {
    console.error(`ERROR: Inline JavaScript block ${checked + 1} failed syntax check.\n${result.stderr || result.stdout}`);
    process.exit(result.status ?? 1);
  }
  checked += 1;
}

const workerPath = path.join(path.dirname(target), 'analyzer-worker.js');
if (fs.existsSync(workerPath)) {
  const workerCheck = spawnSync(process.execPath, ['--check', workerPath], { encoding: 'utf8' });
  if (workerCheck.status !== 0) {
    console.error(`ERROR: Analyzer worker failed syntax check.\n${workerCheck.stderr || workerCheck.stdout}`);
    process.exit(workerCheck.status ?? 1);
  }
  console.log(`OK: ${workerPath} passed Node syntax check.`);
}
console.log(`OK: ${target} passed structural checks; ${ids.length} unique ids; ${checked} inline JavaScript block(s) passed Node syntax check.`);
