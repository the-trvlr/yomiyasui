'use strict';

let tokenizer = null;
const lemmaReadingCache = new Map();

function toHiragana(value) {
  return String(value || '').replace(/[\u30a1-\u30f6]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

function initialize(message) {
  try {
    importScripts(message.scriptUrl);
    if (!self.kuromoji || typeof self.kuromoji.builder !== 'function') {
      throw new Error('Kuromoji API не найден в worker.');
    }

    // Kuromoji internally calls path.join(dicPath, filename). Absolute URLs
    // are corrupted by that call (https:// -> https:/), so pass only the URL pathname.
    const dictionaryUrl = new URL(message.dictPath, self.location.href);
    let dicPath = dictionaryUrl.pathname;
    if (!dicPath.endsWith('/')) dicPath += '/';

    self.postMessage({ type: 'init-progress', message: 'Загружаю словарные таблицы Kuromoji…' });
    self.kuromoji.builder({ dicPath }).build((err, instance) => {
      if (err) {
        self.postMessage({ type: 'init-error', error: err.message || String(err) });
        return;
      }
      tokenizer = instance;
      self.postMessage({ type: 'ready' });
    });
  } catch (err) {
    self.postMessage({ type: 'init-error', error: err && err.message ? err.message : String(err) });
  }
}

function addCanonicalReadings(tokens) {
  for (const token of tokens) {
    const base = token && token.basic_form;
    const surface = token && token.surface_form;
    if (!base || base === '*' || base === surface) continue;

    if (lemmaReadingCache.has(base)) {
      token.canonical_reading = lemmaReadingCache.get(base);
      continue;
    }

    try {
      const pieces = tokenizer.tokenize(base);
      const reading = toHiragana(pieces
        .map(part => part.reading && part.reading !== '*' ? part.reading : '')
        .join(''));
      lemmaReadingCache.set(base, reading);
      if (reading) token.canonical_reading = reading;
    } catch (_) {
      lemmaReadingCache.set(base, '');
    }
  }
  return tokens;
}

self.onmessage = function (event) {
  const message = event.data || {};
  if (message.type === 'init') {
    initialize(message);
    return;
  }

  if (message.type === 'tokenize') {
    try {
      if (!tokenizer) throw new Error('Анализатор ещё не готов.');
      const tokens = tokenizer.tokenize(String(message.text || ''));
      addCanonicalReadings(tokens);
      self.postMessage({ type: 'tokenized', id: message.id, tokens });
    } catch (err) {
      self.postMessage({
        type: 'tokenize-error',
        id: message.id,
        error: err && err.message ? err.message : String(err)
      });
    }
  }
};
