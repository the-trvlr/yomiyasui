#!/usr/bin/env node
/**
 * Сборка компактного словаря 読みやすい.
 *
 * Раньше браузер скачивал два zip-архива JMdict (15,4 МБ), распаковывал их
 * через JSZip, парсил ~60 МБ JSON и сливал английские и русские записи по id.
 * Теперь это делает CI: скрипт читает архивы, сливает записи и пишет один
 * компактный JSON, который рантайм просто загружает.
 *
 * Использование:
 *   node scripts/build-dictionary.mjs [--out site/data]
 *
 * Требует `unzip` (есть на macOS и в ubuntu-latest).
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JM_VERSION } from '../site/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const OUT_DIR = path.resolve(outFlag >= 0 ? args[outFlag + 1] : path.join(ROOT, 'site/data'));

const SOURCES = {
  eng: path.join(OUT_DIR, `jmdict-eng-${JM_VERSION}.json.zip`),
  rus: path.join(OUT_DIR, `jmdict-rus-${JM_VERSION}.json.zip`),
};

function log(step, message) {
  console.log(`[${step}] ${message}`);
}

/** Достаёт единственный JSON из zip-архива JMdict-Simplified. */
function readArchiveJson(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`Нет архива ${file}. Сначала выполните scripts/prepare-site-assets.sh.`);
  }
  const name = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .find((entry) => /\.json$/i.test(entry));
  if (!name) throw new Error(`В ${file} нет JSON-файла.`);
  const buffer = execFileSync('unzip', ['-p', file, name], { maxBuffer: 1024 * 1024 * 1024 });
  return JSON.parse(buffer.toString('utf8'));
}

const normalizeForm = (value) =>
  String(value || '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase();

const uniqueStrings = (items) => [
  ...new Set(items.map((value) => String(value || '').trim()).filter(Boolean)),
];

const sensesOf = (word, language) =>
  (word.sense || [])
    .map((sense) => ({
      pos: uniqueStrings(sense.partOfSpeech || []),
      defs: uniqueStrings(
        (sense.gloss || [])
          .filter((gloss) =>
            language === 'rus' ? gloss.lang === 'rus' : !gloss.lang || gloss.lang === 'eng',
          )
          .map((gloss) => gloss.text),
      ),
    }))
    .filter((sense) => sense.defs.length);

/** Сливает архивы так же, как это делал рантайм: английский — база, русский — переводы. */
function mergeArchives() {
  const entries = new Map();

  const english = readArchiveJson(SOURCES.eng);
  log('eng', `${english.words.length.toLocaleString('ru-RU')} записей`);
  for (const word of english.words) {
    entries.set(String(word.id), {
      kanji: (word.kanji || []).map((item) => ({ text: item.text, common: !!item.common })),
      kana: (word.kana || []).map((item) => ({
        text: item.text,
        common: !!item.common,
        appliesToKanji: item.appliesToKanji || [],
      })),
      senses: sensesOf(word, 'eng'),
      rusSenses: [],
      common:
        (word.kanji || []).some((item) => item.common) ||
        (word.kana || []).some((item) => item.common),
    });
  }

  const russian = readArchiveJson(SOURCES.rus);
  log('rus', `${russian.words.length.toLocaleString('ru-RU')} записей`);
  for (const word of russian.words) {
    const id = String(word.id);
    const rusSenses = sensesOf(word, 'rus');
    const existing = entries.get(id);
    if (existing) {
      existing.rusSenses = rusSenses;
      if (!existing.kanji.length) {
        existing.kanji = (word.kanji || []).map((item) => ({
          text: item.text,
          common: !!item.common,
        }));
      }
      if (!existing.kana.length) {
        existing.kana = (word.kana || []).map((item) => ({
          text: item.text,
          common: !!item.common,
          appliesToKanji: item.appliesToKanji || [],
        }));
      }
      continue;
    }
    entries.set(id, {
      kanji: (word.kanji || []).map((item) => ({ text: item.text, common: !!item.common })),
      kana: (word.kana || []).map((item) => ({
        text: item.text,
        common: !!item.common,
        appliesToKanji: item.appliesToKanji || [],
      })),
      senses: [],
      rusSenses,
      common:
        (word.kanji || []).some((item) => item.common) ||
        (word.kana || []).some((item) => item.common),
    });
  }

  return entries;
}

/** Уплотняет записи в кортежи и интернирует части речи. */
function compile(entries) {
  const posIndex = new Map();
  const posList = [];
  const internPos = (tags) =>
    tags.map((tag) => {
      if (!posIndex.has(tag)) {
        posIndex.set(tag, posList.length);
        posList.push(tag);
      }
      return posIndex.get(tag);
    });

  const rows = [];
  for (const [id, entry] of entries) {
    const kanji = entry.kanji.map((item) => [item.text, item.common ? 1 : 0]);
    const kana = entry.kana.map((item) =>
      item.appliesToKanji && item.appliesToKanji.length
        ? [item.text, item.common ? 1 : 0, item.appliesToKanji]
        : [item.text, item.common ? 1 : 0],
    );
    const senses = entry.senses.map((sense) => [internPos(sense.pos), sense.defs]);
    const rusSenses = entry.rusSenses.map((sense) => [internPos(sense.pos), sense.defs]);
    rows.push([id, kanji, kana, senses, rusSenses, entry.common ? 1 : 0]);
  }
  return { pos: posList, rows };
}

/**
 * Индекс форм: нормализованная форма → индексы записей, отсортированный по форме.
 * Раньше браузер строил его сам: ~500 тыс. нормализаций NFKC и два прохода по
 * 218 тыс. записей — самая дорогая часть загрузки словаря.
 */
function buildForms(rows) {
  const map = new Map();
  rows.forEach((row, index) => {
    const [, kanji, kana] = row;
    const forms = new Set([
      ...(kanji || []).map((item) => item[0]),
      ...(kana || []).map((item) => item[0]),
    ]);
    for (const form of forms) {
      const norm = normalizeForm(form);
      if (!norm) continue;
      if (!map.has(norm)) map.set(norm, []);
      map.get(norm).push(index);
    }
  });
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function writeJson(file, data) {
  const text = JSON.stringify(data);
  fs.writeFileSync(file, text);
  const gzipped = zlib.gzipSync(Buffer.from(text), { level: 9 }).length;
  const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} МБ`;
  console.log(`  ${path.basename(file)}: ${mb(Buffer.byteLength(text))} (gzip ${mb(gzipped)})`);
  return Buffer.byteLength(text);
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  log('merge', `JMdict ${JM_VERSION}`);
  const merged = mergeArchives();
  log('merge', `${merged.size.toLocaleString('ru-RU')} записей после слияния`);

  const { pos, rows } = compile(merged);
  const common = rows.filter((row) => row[5] === 1);
  log(
    'compile',
    `${rows.length.toLocaleString('ru-RU')} записей, ${pos.length} частей речи, ${common.length.toLocaleString('ru-RU')} частых`,
  );

  console.log('Файлы:');
  writeJson(path.join(OUT_DIR, `dict-${JM_VERSION}.json`), {
    version: JM_VERSION,
    builtAt: new Date().toISOString(),
    count: rows.length,
    pos,
    entries: rows,
  });
  writeJson(path.join(OUT_DIR, `dict-core-${JM_VERSION}.json`), {
    version: JM_VERSION,
    builtAt: new Date().toISOString(),
    count: common.length,
    pos,
    entries: common,
  });

  log('forms', 'индекс форм');
  const fullForms = buildForms(rows);
  writeJson(path.join(OUT_DIR, `forms-${JM_VERSION}.json`), {
    version: JM_VERSION,
    builtAt: new Date().toISOString(),
    count: fullForms.length,
    forms: fullForms,
  });
  const coreForms = buildForms(common);
  writeJson(path.join(OUT_DIR, `forms-core-${JM_VERSION}.json`), {
    version: JM_VERSION,
    builtAt: new Date().toISOString(),
    count: coreForms.length,
    forms: coreForms,
  });

  log('done', 'словарь готов');
}

main();
