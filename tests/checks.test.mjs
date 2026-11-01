import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSite } from '../scripts/lib/checks.mjs';

/** Копия site/ без генерируемых ассетов, чтобы портить её в тестах. */
function copySite(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yomiyasui-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync('site', dir, {
    recursive: true,
    filter: (source) => !['vendor', 'data'].includes(path.basename(source)),
  });
  return { dir, html: path.join(dir, 'index.html') };
}

function failuresOf(htmlPath) {
  return checkSite(htmlPath).failures;
}

test('реальный site/ проходит все проверки', () => {
  const { failures, stats } = checkSite('site/index.html');
  assert.deepEqual(failures, []);
  assert.ok(stats.ids > 40, `ожидалось больше id, получено ${stats.ids}`);
  assert.deepEqual(stats.stylesheets, ['./app.css']);
});

test('дублирующийся id обнаруживается', (t) => {
  const { html } = copySite(t);
  fs.writeFileSync(
    html,
    fs.readFileSync(html, 'utf8').replace('<div class="app">', '<div class="app" id="reader">'),
  );
  assert.ok(failuresOf(html).some((failure) => failure.includes('Duplicate HTML id')));
});

test('отсутствующий stylesheet обнаруживается', (t) => {
  const { dir, html } = copySite(t);
  fs.rmSync(path.join(dir, 'app.css'));
  assert.ok(failuresOf(html).some((failure) => failure.includes('app.css does not exist')));
});

test('захардкоженная версия JMdict обнаруживается', (t) => {
  const { html } = copySite(t);
  fs.writeFileSync(
    html,
    fs
      .readFileSync(html, 'utf8')
      .replace('<div class="app">', '<div class="app" data-version="3.6.2+20261012204142">'),
  );
  assert.ok(failuresOf(html).some((failure) => failure.includes('hardcodes the JMdict version')));
});

test('встроенный inline-скрипт обнаруживается', (t) => {
  const { html } = copySite(t);
  fs.writeFileSync(
    html,
    fs.readFileSync(html, 'utf8').replace('</body>', '<script>console.log(1);</script></body>'),
  );
  assert.ok(
    failuresOf(html).some((failure) => failure.includes('Inline JavaScript is not allowed')),
  );
});

test('область чтения без lang="ja" обнаруживается', (t) => {
  const { html } = copySite(t);
  fs.writeFileSync(
    html,
    fs.readFileSync(html, 'utf8').replace(' id="readingCopy" lang="ja"', ' id="readingCopy"'),
  );
  assert.ok(failuresOf(html).some((failure) => failure.includes('lang="ja"')));
});

test('битый JavaScript в app.js обнаруживается', (t) => {
  const { dir, html } = copySite(t);
  fs.writeFileSync(path.join(dir, 'app.js'), '(() => { const = ; })();\n');
  assert.ok(failuresOf(html).some((failure) => failure.includes('app.js failed syntax check')));
});
