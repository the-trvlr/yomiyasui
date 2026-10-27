'use strict';

let tokenizer = null;
const lemmaReadingCache = new Map();

function toHiragana(value) {
  return String(value || '').replace(/[\u30a1-\u30f6]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

async function initialize(message) {
  try {
    self.postMessage({type:'init-progress',stage:'script',progress:0,total:12,message:'Загружаю библиотеку японского анализатора…'});
    importScripts(message.scriptUrl);
    if (!self.kuromoji || typeof self.kuromoji.builder !== 'function') throw new Error('Kuromoji API не найден в worker.');
    // Kuromoji uses path.join internally. Pass a pathname, not a complete https URL.
    const dictionaryUrl = new URL(message.dictPath, self.location.href);
    let dicPath = dictionaryUrl.pathname; if (!dicPath.endsWith('/')) dicPath += '/';
    // Warm HTTP cache and report actual progress for the required dictionary files.
    const files=['base.dat.gz','cc.dat.gz','check.dat.gz','tid.dat.gz','tid_map.dat.gz','tid_pos.dat.gz','unk.dat.gz','unk_char.dat.gz','unk_compat.dat.gz','unk_invoke.dat.gz','unk_map.dat.gz','unk_pos.dat.gz'];
    for(let i=0;i<files.length;i++) {
      const url=new URL(files[i],new URL(dicPath,self.location.origin)).href; let response;
      try { response=await fetch(url,{cache:'force-cache'}); } catch(err) { throw new Error(`Не удалось загрузить ${files[i]}: ${err?.message||'ошибка сети'}`); }
      if(!response.ok) throw new Error(`Файл ${files[i]} недоступен (HTTP ${response.status})`);
      const bytes=await response.arrayBuffer(); if(bytes.byteLength<16) throw new Error(`Файл ${files[i]} пустой или повреждён`);
      self.postMessage({type:'init-progress',stage:'dictionary',progress:i+1,total:files.length,message:`Словари анализатора: файл ${i+1} из ${files.length} — ${files[i]}`});
    }
    self.postMessage({type:'init-progress',stage:'build',progress:12,total:12,message:'Файлы анализатора загружены; собираю модель…'});
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
