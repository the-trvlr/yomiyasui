import { APP_VERSION, JM_DB_NAME, JM_VERSION } from './config.js';

(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const reader = $('reader'), track = $('track'), copy = $('readingCopy');
  const textInput = $('textInput'), editor = $('editor'), playPause = $('playPause'), restart = $('restart');
  const statePill = $('statePill'), stateText = $('stateText'), filePicker = $('filePicker');
  const systemStatus = $('systemStatus'), systemIndicator = $('systemIndicator'), retryAnalyzer = $('retryAnalyzer');
  const dictPanel = $('dictionaryPanel');
  const mobileDictToggle = $('mobileDictToggle'), mobileSettings = $('mobileSettings');
  const mobileSettingsQuick = $('mobileSettingsQuick'), bookShelf = $('bookShelf'), mobileShelfToggle = $('mobileShelfToggle');
  const mobileDictionaryFab = $('mobileDictionaryFab');
  const mobileLayoutQuery = window.matchMedia('(max-width: 680px)');
  const dictSearch = $('dictSearch'), dictSearchResults = $('dictSearchResults'), dictDetail = $('dictDetail'), dictMainView = $('dictMainView');
  const dictLoadStatus = $('dictLoadStatus'), dictFallback = $('dictFallback'), dictStateDot = $('dictStateDot');
  const dictFilePicker = $('dictFilePicker');
  const bootSplash = $('bootSplash'), bootProgressTrack = $('bootProgressTrack'), bootProgressBar = $('bootProgressBar');
  const bootProgressLabel = $('bootProgressLabel'), bootProgressPct = $('bootProgressPct'), bootContinue = $('bootContinue');
  const BOOT_STORAGE_KEY = `yomiyasui-first-setup-${JM_VERSION}`;
  let firstSetupRequired = true, bootProgress = 0, bootAnalyzerReady = false, bootAnalyzerFailed = false, bootDictionaryReady = false, autoDictionaryStarted = false;
  try { firstSetupRequired = localStorage.getItem(BOOT_STORAGE_KEY) !== 'done'; } catch (_) { firstSetupRequired = true; }
  bootSplash.hidden = !firstSetupRequired;
  $('brandVersionBadge').textContent = `v${APP_VERSION}`;
  $('bootVersionBadge').textContent = `v${APP_VERSION}`;
  // Resolve assets against the application root, not the browser's current URL.
  // This remains correct even if a visitor opens /yomiyasui without its trailing slash.
  const APP_BASE_URL = (() => {
    const pathname = window.location.pathname;
    const projectPath = '/yomiyasui';
    let basePath;
    if (pathname === projectPath || pathname.startsWith(projectPath + '/')) {
      basePath = projectPath + '/';
    } else {
      basePath = pathname.endsWith('/') ? pathname : pathname.slice(0, pathname.lastIndexOf('/') + 1);
      if (!basePath) basePath = '/';
    }
    return new URL(basePath, window.location.origin);
  })();
  const appAssetUrl = (path) => new URL(String(path).replace(/^\/+/, ''), APP_BASE_URL).href;
  const KUROMOJI_URL = appAssetUrl('vendor/kuromoji/build/kuromoji.js');
  const KUROMOJI_DICT = appAssetUrl('vendor/kuromoji/dict/');
  const JSZIP_URL = appAssetUrl('vendor/jszip/dist/jszip.min.js');
  const JM_ASSETS = {
    eng: appAssetUrl(`data/jmdict-eng-${JM_VERSION}.json.zip`),
    rus: appAssetUrl(`data/jmdict-rus-${JM_VERSION}.json.zip`)
  };
  // Словарь, собранный scripts/build-dictionary.mjs: без JSZip и без слияния
  // двух архивов в браузере. core — частые слова, чтобы поиск заработал сразу.
  const COMPILED_DICT = {
    core: appAssetUrl(`data/dict-core-${JM_VERSION}.json`),
    full: appAssetUrl(`data/dict-${JM_VERSION}.json`)
  };
  // The manual-download links live in the HTML; derive them from the single version source
  // so the archive name can never drift from config.js.
  for (const [language, url] of Object.entries(JM_ASSETS)) {
    const link = document.querySelector(`[data-dict-zip="${language}"]`);
    if (link) link.href = url;
  }
  let dictionaryById = new Map(), dictionaryEntries = [], formIndex = new Map(), prefixIndex = new Map();
  let dictionaryLoaded = false, dictionaryLoadingPromise = null, dictionaryLoadFailed = false, dictionarySearchTimer = 0;
  let dictionaryDBPromise = null, activeDictionaryEntryId = null, dictionaryView = 'results';

  const sample = `静かな夜だった。窓の外では、細い雨が降り続いていた。

彼は本を閉じて、しばらく机の上の小さなランプを見つめた。急ぐ必要はない。ひとつの言葉を理解するために、少し立ち止まってもいい。

知らない言葉に出会ったら、前後の文をゆっくり読み返す。意味がすぐにわからなくても、物語の流れを追っていけば、少しずつ見えてくることがある。

彼はもう一度、本を開いた。今度は、さっきよりも少しだけ落ち着いて読める気がした。`;

  let offset = 0, lastTime = 0, rafId = 0, isPlaying = false, isFinished = false;
  const ORIENTATION_KEY = 'kotoba-orientation';
  // Сколько столбцов оставить перед текстом в 縦書き: в начале видно только
  // первые две строки, остальное — запас, в который текст уезжает при прокрутке.
  // Зеркально горизонтальному режиму, где над текстом остаётся 70% высоты.
  const VERTICAL_START_COLUMNS = 2.4;
  let textOrientation = 'horizontal';
  // Пока анализатор готовится (или разбирает книгу), его прогресс важнее:
  // сообщения словаря в этот момент не должны перебивать статус в шапке.
  let analyzerBusy = true;
  try {
    if (localStorage.getItem(ORIENTATION_KEY) === 'vertical') textOrientation = 'vertical';
  } catch (_) { /* приватный режим — остаёмся на горизонтальном */ }
  let tokenizer = null, tokenizerPromise = null, jsZipPromise = null, renderVersion = 0;
  let tokenizerWorker = null, analyzerRequestId = 0;
  const analyzerPendingRequests = new Map();
  const baseReadingCache = new Map();
  let analyzedParagraphs = [], currentWord = null, currentBookName = '';
  let currentBookId = null, currentBookRecord = null, libraryDBPromise = null;
  let bookLibrary = [], currentChapters = [], pendingRestoreRatio = null, lastProgressSaveAt = 0, lastUiUpdateAt = 0, progressSaveTimer = 0;
  // Позиция, к которой пользователь перешёл вручную. Пока offset не сдвинулся,
  // индикатор главы держим на ней: иначе пересчёт по порогу мог отщёлкнуть
  // селектор и заблокировать стрелку «назад» сразу после перехода.
  let pinnedChapter = null;
  // Пользователь уже двигал текст после загрузки книги. Отложенное
  // восстановление сохранённой позиции в этом случае отменяется, иначе оно
  // перезаписывает переход и «рестарт» уезжает в конец прошлой сессии.
  let userMovedSinceApply = false;
  let knownWords = loadKnownWords();

  function setSystemStatus(message, state='loading', retry=false) {
    systemStatus.textContent = message;
    systemIndicator.className = 'status-indicator' + (state === 'ready' ? ' ready' : state === 'error' ? ' error' : '');
    retryAnalyzer.hidden = !retry;
  }
  function setBootProgress(value,label,detail='') {
    if (!firstSetupRequired || bootSplash.hidden) return;
    bootProgress=Math.max(bootProgress,Math.max(0,Math.min(100,Number(value)||0)));
    bootProgressBar.style.width=`${bootProgress}%`;
    bootProgressTrack.setAttribute('aria-valuenow',String(Math.round(bootProgress)));
    bootProgressPct.textContent=`${Math.round(bootProgress)}%`;
    if(label) bootProgressLabel.textContent=label;
    if(detail) $('bootDescription').textContent=detail;
  }
  function setBootStep(step,state,detail='') {
    if(!firstSetupRequired || bootSplash.hidden) return;
    const map={analyzer:['bootAnalyzerStep','bootAnalyzerState','bootAnalyzerDetail'],dictionary:['bootDictionaryStep','bootDictionaryState','bootDictionaryDetail'],ready:['bootReadyStep','bootReadyState','bootReadyDetail']};
    const ids=map[step]; if(!ids) return;
    const parent=$(ids[0]),icon=$(ids[1]),line=$(ids[2]);
    parent.classList.remove('active','done','error'); if(state) parent.classList.add(state);
    icon.textContent=state==='done'?'✓':state==='active'?'··':state==='error'?'!':'○';
    if(detail) line.textContent=detail;
  }
  function completeFirstSetup() {
    if(!firstSetupRequired || !bootAnalyzerReady || !bootDictionaryReady) return;
    const showSplash = !bootSplash.hidden;
    if(showSplash) {
      setBootStep('ready','done','Всё готово — можно читать');
      setBootProgress(100,'Подготовка завершена','Анализатор и словари подключены. Приятного чтения!');
      $('bootTitle').textContent='Всё готово';
      $('bootDescription').textContent='Анализатор и словари подключены. Приятного чтения!';
    }
    try { localStorage.setItem(BOOT_STORAGE_KEY,'done'); } catch (_) {}
    firstSetupRequired=false;
    if(showSplash) {
      bootSplash.classList.add('closing');
      setTimeout(()=>{bootSplash.hidden=true;bootSplash.classList.remove('closing');},450);
    }
  }
  function failFirstSetup(step,message) {
    if(!firstSetupRequired || bootSplash.hidden) return;
    setBootStep(step,'error',message);
    $('bootTitle').textContent='Не всё удалось подключить';
    $('bootDescription').textContent=message || 'Читалка останется доступна, но некоторые функции могут быть отключены.';
    $('bootNote').textContent='Можно продолжить без неподключённой функции. Повторное подключение доступно в строке состояния и настройках словаря.';
    bootProgressLabel.textContent='Нужно внимание'; bootContinue.hidden=false; bootContinue.textContent='Продолжить чтение';
  }
  function updateBootDictionaryProgress(message,state='loading') {
    if(!firstSetupRequired || bootSplash.hidden) return;
    let p=56;
    if(/Скачиваю JMdict|Скачиваю EN|Скачиваю RU/i.test(message)) {
      const ru=/RU|русском/i.test(message),m=message.match(/:\s*([\d.,]+)\s*\/\s*([\d.,]+)\s*МБ/i);
      if(m) {const cur=Number(m[1].replace(',','.')),tot=Number(m[2].replace(',','.'))||(ru?4:11);p=(ru?71:57)+Math.min(1,cur/tot)*(ru?8:12);} else p=ru?71:57;
    } else if(/кэш/i.test(message)) p=68;
    else if(/Готовлю полный английский/i.test(message)) p=55;
    else if(/Распаковываю словарь EN/i.test(message)) p=70;
    else if(/Распаковываю словарь RU/i.test(message)) p=82;
    else if(/Индексирую JMdict EN/i.test(message)) {const m=message.match(/([\d\s.,]+)\s*\/\s*([\d\s.,]+)/);p=m?72+Math.min(1,Number(m[1].replace(/[\s,]/g,''))/Math.max(1,Number(m[2].replace(/[\s,]/g,''))))*8:74;}
    else if(/Подключаю русские переводы:/i.test(message)) {const m=message.match(/([\d\s.,]+)\s*\/\s*([\d\s.,]+)/);p=m?83+Math.min(1,Number(m[1].replace(/[\s,]/g,''))/Math.max(1,Number(m[2].replace(/[\s,]/g,''))))*7:84;}
    else if(/Индексирую объединённый/i.test(message)) p=89;
    else if(/Индексирую словарь:/i.test(message)) {const m=message.match(/([\d\s.,]+)\s*\/\s*([\d\s.,]+)/);p=m?90+Math.min(1,Number(m[1].replace(/[\s,]/g,''))/Math.max(1,Number(m[2].replace(/[\s,]/g,''))))*8:91;}
    else if(state==='ready') p=99;
    setBootStep('dictionary',state==='ready'?'done':'active',message); setBootProgress(p,'Подготовка словарей',message);
  }
  function loadKnownWords() {
    try { return new Set(JSON.parse(localStorage.getItem('kotoba-known-words-v02') || '[]')); }
    catch (_) { return new Set(); }
  }
  function saveKnownWords() {
    try { localStorage.setItem('kotoba-known-words-v02', JSON.stringify([...knownWords])); }
    catch (_) { /* localStorage can be disabled for file URLs; keep the session functional */ }
  }
  function toHiragana(value) {
    return String(value || '').replace(/[\u30a1-\u30f6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  }
  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  }
  function containsKanji(value) { return /[\u3400-\u4dbf\u4e00-\u9fff々〆ヶ]/.test(value || ''); }
  function dictionaryKey(token) {
    const base = token?.basic_form && token.basic_form !== '*' ? token.basic_form : (token?.surface_form || '');
    let reading = token?.reading && token.reading !== '*' ? toHiragana(token.reading) : '';
    // The worker supplies a canonical reading for inflected forms without blocking the UI thread.
    if (base && base !== token?.surface_form) {
      const canonical = token?.canonical_reading || baseReadingCache.get(base);
      if (token?.canonical_reading) baseReadingCache.set(base, toHiragana(token.canonical_reading));
      if (canonical) reading = toHiragana(canonical);
    }
    return `${base}\u241f${reading}`;
  }
  function tokenIsKnown(token) { return knownWords.has(dictionaryKey(token)); }
  function getSpeed() { return Number($('speed').value); }
  function setState(playing) {
    isPlaying = playing;
    statePill.classList.toggle('playing', playing);
    stateText.textContent = isFinished ? 'Конец фрагмента' : (playing ? 'Чтение' : 'Пауза');
    playPause.textContent = playing ? 'Ⅱ' : (isFinished ? '↺' : '▶');
    playPause.setAttribute('aria-label', playing ? 'Пауза' : (isFinished ? 'Начать сначала' : 'Запустить'));
    playPause.title = playing ? 'Пауза' : (isFinished ? 'Начать сначала' : 'Запустить');
  }
  function stopAnimation() { if (rafId) cancelAnimationFrame(rafId); rafId = 0; lastTime = 0; }
  // 縦書き: текст идёт сверху вниз, столбцы — справа налево, поэтому прокрутка
  // работает по горизонтали и тянет содержимое вправо.
  function isVertical() { return textOrientation === 'vertical'; }
  function readingAxisSize() { return isVertical() ? reader.clientWidth : reader.clientHeight; }
  function contentAxisSize() {
    // В вертикальном режиме длина текста — это ширина набора столбцов.
    if (isVertical()) return Math.max(copy.scrollWidth, copy.getBoundingClientRect().width);
    return track.scrollHeight;
  }
  function updateTransform() {
    track.style.transform = isVertical() ? `translateX(${offset}px)` : `translateY(${-offset}px)`;
  }
  // Ширина пустого поля перед текстом в 縦書き — два с небольшим столбца.
  // Ширина столбца равна межстрочному интервалу в пикселях.
  function verticalStartInset() {
    return Number($('fontSize').value) * Number($('leading').value) * VERTICAL_START_COLUMNS;
  }
  function getMaxOffset() {
    // Горизонтально текст входит снизу и уходит вверх; вертикально — входит слева
    // и уходит вправо, освобождая место следующим столбцам.
    if (isVertical()) {
      return Math.max(1, reader.clientWidth - verticalStartInset() + contentAxisSize() + 12);
    }
    return Math.max(1, reader.clientHeight * 0.7 + contentAxisSize() + 12);
  }
  function getProgressRatio() { return Math.max(0, Math.min(1, offset / getMaxOffset())); }
  // Позиция абзаца вдоль оси чтения, в координатах дорожки. Разница между
  // прямоугольниками не зависит от translate-трансформации самой дорожки.
  function axisOffsetOf(node) {
    const trackRect = track.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    return isVertical() ? trackRect.right - rect.right : rect.top - trackRect.top;
  }
  function updateChapterPosition() {
    if (!currentChapters.length) return;
    // Порог «глава уже началась» зависит от направления движения текста.
    // Горизонтально текст уходит вверх: глава считается текущей, когда её начало
    // поднялось на 0.28 экрана выше линии чтения. Вертикально текст уходит вправо,
    // и запасной области «уже прочитанного» на экране нет, поэтому глава
    // становится текущей, когда её начало вошло в область чтения примерно
    // на столбец — иначе сразу после перехода селектор показывал бы прошлую.
    const axis = readingAxisSize();
    const target = isVertical() ? offset + axis * 0.12 : Math.max(0, offset - axis * 0.28);
    let index = 0;
    const nodes = copy.children;
    for (let i = 0; i < currentChapters.length; i++) {
      const start = currentChapters[i].startParagraph || 0;
      const node = nodes[start];
      if (!node || axisOffsetOf(node) <= target) index = i;
      else break;
    }
    if (pinnedChapter && Math.abs(offset - pinnedChapter.offset) < 2 && pinnedChapter.index < currentChapters.length) {
      index = pinnedChapter.index;
    }
    const select = $('chapterSelect');
    if (select && Number(select.value) !== index) select.value = String(index);
    $('prevChapter').disabled = index <= 0;
    $('nextChapter').disabled = index >= currentChapters.length - 1;
    $('positionChapter').textContent = currentChapters[index]?.title || `Глава ${index+1}`;
    return index;
  }
  function updateSeekUI() {
    const ratio = getProgressRatio();
    const slider = $('bookPosition');
    if (slider && document.activeElement !== slider) slider.value = String(Math.round(ratio * 1000));
    $('positionLabel').textContent = `${Math.round(ratio * 100)}%`;
    updateChapterPosition();
    const pct = Math.round(ratio * 100);
    $('currentBookMeta').textContent = currentBookId ? `${currentChapters.length || 1} гл. · ${pct}% прочитано` : 'Добавь текст на полку, чтобы сохранять позицию и закладки';
  }
  function tick(time) {
    if (!isPlaying) return;
    if (!lastTime) lastTime = time;
    const dt = Math.min((time - lastTime) / 1000, 0.06);
    lastTime = time;
    offset += getSpeed() * dt;
    const endAt = getMaxOffset();
    updateTransform();
    if (time - lastUiUpdateAt > 140) { lastUiUpdateAt = time; updateSeekUI(); }
    if (offset >= endAt) {
      offset = endAt; updateTransform(); updateSeekUI(); isFinished = true; stopAnimation(); setState(false); saveCurrentProgress(); return;
    }
    if (currentBookId && time - lastProgressSaveAt > 1200) { lastProgressSaveAt = time; saveCurrentProgress(); }
    rafId = requestAnimationFrame(tick);
  }
  function play() {
    if (!copy.textContent.trim()) return;
    if (isFinished) resetReader();
    if (isPlaying) return;
    userMovedSinceApply = true;
    isFinished = false; setState(true); lastTime = 0; stopAnimation(); rafId = requestAnimationFrame(tick);
  }
  function pause(save=true) { stopAnimation(); setState(false); if(save) saveCurrentProgress(); }
  function togglePlayback() { if (isPlaying) pause(); else play(); }
  function resetReader() {
    pinnedChapter = null; userMovedSinceApply = true;
    pause(); offset = 0; isFinished = false; updateTransform(); setState(false); reader.scrollTop = 0; updateSeekUI(); saveCurrentProgress();
  }
  function seekToRatio(ratio, persist=true) {
    pause(false);
    pinnedChapter = null; userMovedSinceApply = true;
    const clamped = Math.max(0, Math.min(1, Number(ratio) || 0));
    offset = clamped * getMaxOffset(); isFinished = clamped >= 0.9995;
    updateTransform(); updateSeekUI(); setState(false);
    if (persist) scheduleProgressSave();
  }
  function jumpToChapter(index) {
    if (!currentChapters.length) return;
    const i = Math.max(0, Math.min(currentChapters.length - 1, Number(index) || 0));
    const start = currentChapters[i].startParagraph || 0;
    const node = copy.children[start];
    if (!node) return;
    pause(false);
    if (i === 0) offset = 0;
    else if (isVertical()) {
      // Столбцы идут справа налево: ставим начало главы на линию чтения,
      // чтобы чтение начиналось с заголовка и первых столбцов.
      const readerRect = reader.getBoundingClientRect();
      const rect = node.getBoundingClientRect();
      const desiredRight = readerRect.left + verticalStartInset() - 6;
      offset = Math.max(0, Math.min(getMaxOffset(), offset + desiredRight - rect.right));
    } else {
      const rect = node.getBoundingClientRect();
      const desiredY = reader.getBoundingClientRect().top + reader.clientHeight * 0.37;
      offset = Math.max(0, Math.min(getMaxOffset(), offset + rect.top - desiredY));
    }
    // Фиксируем выбранную главу и не даём отложенному восстановлению позиции
    // переписать переход пользователя.
    pinnedChapter = { index: i, offset };
    userMovedSinceApply = true;
    isFinished = false; updateTransform(); updateSeekUI(); $('chapterSelect').value = String(i); saveCurrentProgress();
  }
  function applyOrientationStyles() {
    reader.classList.toggle('vertical', isVertical());
    const select = $('textOrientation');
    if (select && select.value !== textOrientation) select.value = textOrientation;
  }
  function setTextOrientation(mode, { persist = true } = {}) {
    const next = mode === 'vertical' ? 'vertical' : 'horizontal';
    if (next === textOrientation) return;
    // Доля прочитанного переносится на новую раскладку: пиксельная позиция
    // между режимами несопоставима, а прогресс по книге — да.
    const ratio = getProgressRatio();
    pinnedChapter = null;
    textOrientation = next;
    applyOrientationStyles();
    if (persist) {
      try { localStorage.setItem(ORIENTATION_KEY, next); } catch (_) {}
    }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const maxOffset = getMaxOffset();
      offset = Math.max(0, Math.min(maxOffset, ratio * maxOffset));
      isFinished = ratio >= 0.9995;
      updateTransform(); updateSeekUI(); setState(isPlaying);
      saveCurrentProgress();
    }));
  }
  function updateSettings() {
    const speed = getSpeed(), width = Number($('lineWidth').value), leading = Number($('leading').value), fontSize = Number($('fontSize').value);
    document.documentElement.style.setProperty('--line-chars', width);
    document.documentElement.style.setProperty('--reader-leading', leading);
    document.documentElement.style.setProperty('--reader-font-size', `${fontSize}px`);
    $('speedValue').textContent = `${speed} px/с`;
    $('lineWidthValue').textContent = `${width} знаков`;
    $('leadingValue').textContent = `${leading.toFixed(2).replace('.', ',')}×`;
    $('fontSizeValue').textContent = `${fontSize} px`;
    // Отступ перед текстом в 縦書き зависит от размера шрифта и интервала.
    document.documentElement.style.setProperty('--vertical-start-inset', `${verticalStartInset()}px`);
    pinnedChapter = null;
    requestAnimationFrame(() => { const maxOffset = getMaxOffset(); if (offset > maxOffset) offset = maxOffset; updateTransform(); updateSeekUI(); scheduleProgressSave(); });
  }

  // Persistent bookshelf: book text is kept in one IndexedDB store, while small progress
  // records are updated separately so a long novel is not rewritten every second.
  const LIBRARY_DB_NAME = 'kotoba-library-v1';
  function openLibraryDB() {
    if (libraryDBPromise) return libraryDBPromise;
    libraryDBPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB недоступен')); return; }
      const req = indexedDB.open(LIBRARY_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', {keyPath:'id'});
        if (!db.objectStoreNames.contains('shelf')) db.createObjectStore('shelf', {keyPath:'id'});
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Не удалось открыть книжную полку'));
    }).catch(err => { libraryDBPromise = null; throw err; });
    return libraryDBPromise;
  }
  function simpleHash(text) {
    let h = 2166136261;
    const value = String(text || '');
    for (let i=0; i<value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }
  async function libraryRequest(store, mode, action, value) {
    const db = await openLibraryDB();
    return await new Promise((resolve,reject) => {
      const tx = db.transaction(store, mode), os = tx.objectStore(store);
      let req;
      if (action === 'getAll') req = os.getAll();
      else if (action === 'get') req = os.get(value);
      else if (action === 'put') req = os.put(value);
      else if (action === 'delete') req = os.delete(value);
      if (req) { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }
      else { tx.oncomplete = () => resolve(true); tx.onerror = () => reject(tx.error); }
    });
  }
  function readLibraryFallback() {
    try { return JSON.parse(localStorage.getItem('kotoba-library-fallback-v1') || '[]'); } catch (_) { return []; }
  }
  function writeLibraryFallback(records) {
    try { localStorage.setItem('kotoba-library-fallback-v1', JSON.stringify(records)); return true; } catch (_) { return false; }
  }
  async function refreshBookShelf() {
    try { bookLibrary = await libraryRequest('shelf','readonly','getAll') || []; }
    catch (_) { bookLibrary = readLibraryFallback().map(r => r.meta || r).filter(Boolean); }
    bookLibrary.sort((a,b) => (b.lastOpenedAt || b.updatedAt || b.createdAt || 0) - (a.lastOpenedAt || a.updatedAt || a.createdAt || 0));
    renderBookShelf();
  }
  function renderBookShelf() {
    const grid = $('shelfGrid'); grid.replaceChildren();
    $('shelfCount').textContent = `${bookLibrary.length} ${bookLibrary.length === 1 ? 'книга' : (bookLibrary.length >= 2 && bookLibrary.length <= 4 ? 'книги' : 'книг')}`;
    if (!bookLibrary.length) {
      const empty = document.createElement('div'); empty.className='shelf-empty'; empty.textContent='Полка пока пуста. Открой EPUB / TXT или вставь свой фрагмент — книга появится здесь, а место чтения и закладки будут сохраняться.'; grid.appendChild(empty); return;
    }
    for (const book of bookLibrary) {
      const card = document.createElement('article'); card.className='book-card'+(book.id===currentBookId?' active':'');
      const main = document.createElement('button'); main.className='book-card-main'; main.type='button'; main.dataset.bookId=book.id;
      const title = document.createElement('span'); title.className='book-card-title'; title.textContent=book.title || 'Без названия'; title.title=title.textContent;
      const meta = document.createElement('span'); meta.className='book-card-meta'; meta.textContent=`${book.chapterCount || 1} гл. · ${Math.round((book.progressRatio || 0)*100)}% · ${book.source || 'Текст'}`;
      main.append(title,meta);
      const bottom = document.createElement('div'); bottom.className='book-card-bottom';
      const progress = document.createElement('div'); progress.className='book-progress'; const fill=document.createElement('span'); fill.style.width=`${Math.round((book.progressRatio||0)*100)}%`; progress.append(fill);
      const remove = document.createElement('button'); remove.type='button'; remove.className='book-remove'; remove.dataset.removeBook=book.id; remove.title='Убрать книгу с полки'; remove.setAttribute('aria-label',`Убрать ${book.title || 'книгу'} с полки`); remove.textContent='Убрать';
      bottom.append(progress,remove); card.append(main,bottom); grid.appendChild(card);
    }
  }
  function updateBookCardProgress(meta) {
    const button=document.querySelector(`.book-card-main[data-book-id="${CSS.escape(meta.id)}"]`);
    if(!button) return;
    button.closest('.book-card')?.classList.toggle('active',meta.id===currentBookId);
    const line=button.querySelector('.book-card-meta');
    if(line) line.textContent=`${meta.chapterCount||1} гл. · ${Math.round((meta.progressRatio||0)*100)}% · ${meta.source||'Текст'}`;
    const fill=button.closest('.book-card')?.querySelector('.book-progress > span');
    if(fill) fill.style.width=`${Math.round((meta.progressRatio||0)*100)}%`;
  }

  function plainDocument(text, title='Текст') {
    const clean=String(text||'').replace(/\r\n?/g,'\n').trim();
    const paragraphs=[]; const chapters=[];
    let activeChapter=null;
    for (const raw of clean.split(/\n\s*\n/)) {
      const value=raw.trim(); if(!value) continue;
      const md=value.match(/^#{1,6}\s+(.+)$/);
      const chapterLine=/^(?:第[一二三四五六七八九十百千〇零0-9]+[章話節編回]|(?:chapter|CHAPTER)\s+\d+|[序章終章])$/u.test(value);
      const heading=md ? md[1].trim() : (chapterLine ? value : '');
      if(heading) {
        if(activeChapter) activeChapter.endParagraph=Math.max(activeChapter.startParagraph,paragraphs.length-1);
        activeChapter={title:heading,startParagraph:paragraphs.length,endParagraph:paragraphs.length};
        chapters.push(activeChapter); paragraphs.push({text:heading,heading:true});
      } else {
        if(!activeChapter) { activeChapter={title:title||'Текст',startParagraph:0,endParagraph:0}; chapters.push(activeChapter); }
        paragraphs.push({text:value,heading:false});
      }
      activeChapter.endParagraph=paragraphs.length-1;
    }
    if(!paragraphs.length) chapters.length=0;
    else if(chapters.length) { chapters[0].startParagraph=0; chapters[chapters.length-1].endParagraph=paragraphs.length-1; }
    return {paragraphs,chapters};
  }
  async function storeBookRecord(record) {
    const now=Date.now();
    const meta={ id:record.id, title:record.title, source:record.source || 'Текст', hash:record.hash, paragraphCount:record.paragraphs.length, chapterCount:record.chapters.length || 1,
      createdAt:record.createdAt || now, updatedAt:now, lastOpenedAt:now, progressRatio:record.progressRatio || 0, chapterIndex:record.chapterIndex || 0, bookmarks:record.bookmarks || [] };
    try {
      const db=await openLibraryDB();
      await new Promise((resolve,reject)=>{
        const tx=db.transaction(['books','shelf'],'readwrite');
        tx.objectStore('books').put({id:record.id,title:record.title,source:record.source,hash:record.hash,paragraphs:record.paragraphs,chapters:record.chapters});
        tx.objectStore('shelf').put(meta);
        tx.oncomplete=()=>resolve(); tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error);
      });
    } catch (_) {
      const records=readLibraryFallback();
      const idx=records.findIndex(r=>(r.meta||r).id===record.id);
      const full={meta,content:{id:record.id,title:record.title,source:record.source,hash:record.hash,paragraphs:record.paragraphs,chapters:record.chapters}};
      if(idx>=0) records[idx]=full; else records.push(full);
      if(!writeLibraryFallback(records)) setSystemStatus('Книгу можно читать, но браузер не разрешил сохранить её на полке. Попробуй открыть приложение через localhost или GitHub Pages.', 'error', true);
    }
    const idx=bookLibrary.findIndex(b=>b.id===meta.id); if(idx>=0) bookLibrary[idx]={...bookLibrary[idx],...meta}; else bookLibrary.push(meta);
    bookLibrary.sort((a,b)=>(b.lastOpenedAt||0)-(a.lastOpenedAt||0)); renderBookShelf();
    return meta;
  }
  async function loadBookContent(id) {
    try { const result=await libraryRequest('books','readonly','get',id); if(result) return result; } catch (_) {}
    const found=readLibraryFallback().find(r=>(r.meta||r).id===id);
    return found?.content || null;
  }
  async function addBookToShelf(data) {
    const paragraphs=(data.paragraphs||[]).map(p=>({text:String(p.text||''),heading:!!p.heading})).filter(p=>p.text.trim());
    if(!paragraphs.length) throw new Error('В этом файле не найден текст для чтения.');
    const chapters=(data.chapters||[]).map((c,i)=>({title:String(c.title||`Глава ${i+1}`),startParagraph:Math.max(0,Number(c.startParagraph)||0),endParagraph:Math.max(0,Number(c.endParagraph)||0)}));
    if(!chapters.length) chapters.push({title:'Текст целиком',startParagraph:0,endParagraph:paragraphs.length-1});
    chapters.forEach((c,i)=>{ if(i===0)c.startParagraph=0; c.endParagraph=Math.min(paragraphs.length-1, Math.max(c.startParagraph,c.endParagraph)); });
    const bodyText=paragraphs.map(p=>p.text).join('\n\n'); const hash=simpleHash(bodyText+'\u241f'+data.title);
    const duplicate=bookLibrary.find(b=>b.hash===hash);
    if(duplicate) { await activateSavedBook(duplicate.id); return duplicate.id; }
    const id=`book-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
    const record={id,title:data.title||'Без названия',source:data.source||'Текст',hash,paragraphs,chapters,progressRatio:0,chapterIndex:0,bookmarks:[],createdAt:Date.now()};
    await storeBookRecord(record);
    await activateSavedBook(id,{record});
    return id;
  }
  async function activateSavedBook(id, options={}) {
    saveCurrentProgress();
    let stored=options.record || await loadBookContent(id);
    const meta=bookLibrary.find(b=>b.id===id);
    if(!stored || !meta) { setSystemStatus('Не удалось открыть эту книгу из хранилища браузера.', 'error', true); return; }
    currentBookRecord={...stored,...meta,paragraphs:stored.paragraphs,chapters:stored.chapters};
    currentBookId=id; currentBookName=currentBookRecord.title; currentChapters=currentBookRecord.chapters || [];
    try { localStorage.setItem('kotoba-last-book-id',id); } catch (_) {}
    const content=currentBookRecord.paragraphs.map(p=>p.text).join('\n\n');
    $('openFile').textContent='Открыть EPUB / TXT';
    $('textInput').value=content;
    pendingRestoreRatio=Number(currentBookRecord.progressRatio)||0;
    renderChapterControls(); renderBookmarkControls();
    await applyText(content,{paragraphs:currentBookRecord.paragraphs,chapters:currentChapters,bookId:id,bookRecord:currentBookRecord,restoreRatio:pendingRestoreRatio,source:'library'});
    await storeProgressMeta({lastOpenedAt:Date.now()});
    setSystemStatus(`Открыта книга «${currentBookName}» · позиция чтения восстановлена`, 'ready');
    renderBookShelf();
  }
  async function storeProgressMeta(patch={}) {
    if(!currentBookId || !currentBookRecord) return;
    const currentMeta=bookLibrary.find(b=>b.id===currentBookId) || {};
    const meta={...currentMeta,id:currentBookId,title:currentBookRecord.title,source:currentBookRecord.source,hash:currentBookRecord.hash,paragraphCount:currentBookRecord.paragraphs.length,chapterCount:currentChapters.length||1,
      createdAt:currentBookRecord.createdAt||Date.now(),updatedAt:Date.now(),progressRatio:getProgressRatio(),chapterIndex:updateChapterPosition()||0,bookmarks:currentBookRecord.bookmarks||[],...patch};
    const idx=bookLibrary.findIndex(b=>b.id===currentBookId); if(idx>=0) bookLibrary[idx]=meta; else bookLibrary.push(meta);
    try { await libraryRequest('shelf','readwrite','put',meta); }
    catch (_) {
      const records=readLibraryFallback(); const found=records.findIndex(r=>(r.meta||r).id===currentBookId);
      if(found>=0) records[found]={...records[found],meta}; else records.push({meta,content:{id:currentBookId,title:currentBookRecord.title,source:currentBookRecord.source,hash:currentBookRecord.hash,paragraphs:currentBookRecord.paragraphs,chapters:currentChapters}});
      writeLibraryFallback(records);
    }
    if (Object.keys(patch).length) renderBookShelf(); else updateBookCardProgress(meta);
  }
  function saveCurrentProgress() { if(currentBookId && currentBookRecord) storeProgressMeta().catch(()=>{}); }
  function scheduleProgressSave() { if(!currentBookId) return; if(progressSaveTimer) clearTimeout(progressSaveTimer); progressSaveTimer=setTimeout(()=>{progressSaveTimer=0;saveCurrentProgress();},280); }
  async function removeBookFromShelf(id) {
    const meta=bookLibrary.find(b=>b.id===id); if(!meta) return;
    if(!confirm(`Убрать «${meta.title}» с книжной полки?`)) return;
    try { const db=await openLibraryDB(); await new Promise((resolve,reject)=>{const tx=db.transaction(['books','shelf'],'readwrite');tx.objectStore('books').delete(id);tx.objectStore('shelf').delete(id);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);}); }
    catch (_) { const filtered=readLibraryFallback().filter(r=>(r.meta||r).id!==id); writeLibraryFallback(filtered); }
    bookLibrary=bookLibrary.filter(b=>b.id!==id);
    if(currentBookId===id) { currentBookId=null;currentBookRecord=null;currentChapters=[];currentBookName='';renderChapterControls();renderBookmarkControls();$('currentBookTitle').textContent='Демонстрационный текст';$('currentBookMeta').textContent='Добавь текст на полку, чтобы сохранять позицию и закладки';try{localStorage.removeItem('kotoba-last-book-id')}catch(_){} }
    renderBookShelf();
  }
  function renderChapterControls() {
    const select=$('chapterSelect'); select.replaceChildren();
    currentChapters.forEach((chapter,i)=>{const opt=document.createElement('option');opt.value=String(i);opt.textContent=chapter.title||`Глава ${i+1}`;select.appendChild(opt);});
    const noChapters=!currentBookId || currentChapters.length<1;
    select.disabled=noChapters; $('prevChapter').disabled=true; $('nextChapter').disabled=noChapters || currentChapters.length<2;
    $('addBookmark').disabled=!currentBookId;
    $('currentBookTitle').textContent=currentBookName || 'Демонстрационный текст';
    $('currentBookTitle').title=currentBookName || '';
    $('currentBookMeta').textContent=currentBookId ? `${currentChapters.length||1} гл. · 0% прочитано` : 'Добавь текст на полку, чтобы сохранять позицию и закладки';
  }
  function renderBookmarkControls() {
    const select=$('bookmarkSelect'); select.replaceChildren();
    const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent=`Закладки${currentBookRecord?.bookmarks?.length?` (${currentBookRecord.bookmarks.length})`:''}`;select.appendChild(placeholder);
    const marks=currentBookRecord?.bookmarks||[];
    marks.forEach(mark=>{const opt=document.createElement('option');opt.value=mark.id;opt.textContent=mark.label;select.appendChild(opt);});
    select.disabled=!currentBookId || !marks.length; $('deleteBookmark').hidden=true;
  }
  function saveBookmark() {
    if(!currentBookId || !currentBookRecord) return;
    const ratio=getProgressRatio(); const chapterIndex=updateChapterPosition()||0;
    const mark={id:`bm-${Date.now().toString(36)}`,ratio,chapterIndex,label:`${currentChapters[chapterIndex]?.title||`Глава ${chapterIndex+1}`} · ${Math.round(ratio*100)}%`,createdAt:Date.now()};
    currentBookRecord.bookmarks=currentBookRecord.bookmarks||[]; currentBookRecord.bookmarks.push(mark);
    storeProgressMeta({bookmarks:currentBookRecord.bookmarks}).then(()=>{renderBookmarkControls();$('bookmarkSelect').value=mark.id;$('deleteBookmark').hidden=false;});
  }
  function jumpToBookmark(id) {
    const mark=(currentBookRecord?.bookmarks||[]).find(m=>m.id===id); if(!mark) return;
    seekToRatio(mark.ratio,false); if($('chapterSelect') && currentChapters[mark.chapterIndex]) $('chapterSelect').value=String(mark.chapterIndex);
    $('deleteBookmark').hidden=false; saveCurrentProgress();
  }

  function loadScript(src, globalName) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    return new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = src; script.async = true;
      const timer = setTimeout(() => { script.remove(); reject(new Error('Истекло время ожидания загрузки библиотеки')); }, 25000);
      script.onload = () => { clearTimeout(timer); window[globalName] ? resolve(window[globalName]) : reject(new Error('Библиотека загружена, но её API не найдено')); };
      script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('Не удалось загрузить библиотеку с CDN')); };
      document.head.appendChild(script);
    });
  }
  function rejectPendingAnalyzerRequests(error) {
    for (const [id, pending] of analyzerPendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
      analyzerPendingRequests.delete(id);
    }
  }
  function resetAnalyzerWorker() {
    if (tokenizerWorker) {
      tokenizerWorker.onmessage = null;
      tokenizerWorker.onerror = null;
      tokenizerWorker.terminate();
      tokenizerWorker = null;
    }
    rejectPendingAnalyzerRequests(new Error('Запрос анализа отменён.'));
    tokenizer = null;
    tokenizerPromise = null;
  }
  function requestWorkerTokenization(worker, text) {
    const id = ++analyzerRequestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        analyzerPendingRequests.delete(id);
        reject(new Error('Worker не завершил анализ абзаца за 60 секунд.'));
      }, 60000);
      analyzerPendingRequests.set(id, { resolve, reject, timer });
      try {
        worker.postMessage({ type: 'tokenize', id, text: String(text || '') });
      } catch (err) {
        clearTimeout(timer);
        analyzerPendingRequests.delete(id);
        reject(err);
      }
    });
  }
  async function ensureTokenizer(force=false) {
    if (force) resetAnalyzerWorker();
    if (tokenizer) return tokenizer;
    if (!tokenizerPromise) {
      tokenizerPromise = new Promise((resolve, reject) => {
        let settled = false;
        const worker = new Worker(appAssetUrl('analyzer-worker.js'));
        tokenizerWorker = worker;
        const initTimer = setTimeout(() => {
          failInit(new Error('Worker анализатора не завершился за 120 секунд. Страница остаётся доступной; можно повторить подключение.'));
        }, 120000);
        function failInit(error) {
          if (settled) return;
          settled = true;
          clearTimeout(initTimer);
          reject(error);
        }
        worker.onmessage = event => {
          const message = event.data || {};
          if (message.type === 'ready') {
            if (settled) return;
            settled = true; clearTimeout(initTimer);
            setBootProgress(48,'Анализатор готов','Обрабатываю демонстрационный текст перед подключением словарей…');
            resolve({ tokenize: text => requestWorkerTokenization(worker, text) }); return;
          }
          if (message.type === 'init-progress') {
            const detail=message.message || 'Инициализирую японский анализатор…'; setSystemStatus(detail);
            const n=Number(message.progress)||0,total=Number(message.total)||12;
            setBootStep('analyzer','active',detail); setBootProgress(5+Math.min(1,n/total)*42,'Подключение анализатора',detail);
            return;
          }
          if (message.type === 'init-error') {
            failInit(new Error(message.error || 'Не удалось запустить японский анализатор.'));
            return;
          }
          if (message.id != null) {
            const pending = analyzerPendingRequests.get(message.id);
            if (!pending) return;
            clearTimeout(pending.timer);
            analyzerPendingRequests.delete(message.id);
            if (message.type === 'tokenized') pending.resolve(message.tokens || []);
            else pending.reject(new Error(message.error || 'Ошибка анализа текста.'));
          }
        };
        worker.onerror = event => {
          const error = new Error('Ошибка worker анализатора: ' + (event.message || 'неизвестная ошибка'));
          failInit(error);
          rejectPendingAnalyzerRequests(error);
          if (tokenizerWorker === worker) {
            worker.terminate();
            tokenizerWorker = null;
            tokenizer = null;
            tokenizerPromise = null;
          }
        };
        worker.postMessage({ type: 'init', scriptUrl: KUROMOJI_URL, dictPath: KUROMOJI_DICT });
      }).then(api => {
        tokenizer = api;
        return api;
      }).catch(err => {
        if (tokenizerWorker) {
          tokenizerWorker.terminate();
          tokenizerWorker = null;
        }
        rejectPendingAnalyzerRequests(err);
        tokenizer = null;
        tokenizerPromise = null;
        throw err;
      });
    }
    return tokenizerPromise;
  }
  async function ensureJSZip() {
    if (window.JSZip) return window.JSZip;
    if (!jsZipPromise) jsZipPromise = loadScript(JSZIP_URL, 'JSZip').catch(err => { jsZipPromise = null; throw err; });
    return jsZipPromise;
  }
  function furiganaHTML(surface, reading, shouldShow) {
    const safeSurface = escapeHTML(surface);
    if (!shouldShow || !reading || reading === '*' || !containsKanji(surface)) return safeSurface;
    let hira = toHiragana(reading);
    // Keep matching okurigana outside ruby when we can safely align its suffix.
    const suffixMatch = String(surface).match(/([\u3041-\u3096\u30a1-\u30f6ー]+)$/);
    if (suffixMatch && suffixMatch[1].length < surface.length) {
      const suffix = suffixMatch[1], hiraSuffix = toHiragana(suffix);
      if (hira.endsWith(hiraSuffix) && hira.length > hiraSuffix.length) {
        const kanjiPart = surface.slice(0, -suffix.length), readPart = hira.slice(0, -hiraSuffix.length);
        if (containsKanji(kanjiPart) && readPart) return `<ruby>${escapeHTML(kanjiPart)}<rt>${escapeHTML(readPart)}</rt></ruby>${escapeHTML(suffix)}`;
      }
    }
    return `<ruby>${safeSurface}<rt>${escapeHTML(hira)}</rt></ruby>`;
  }
  function renderToken(token, forcePlain=false) {
    const surface = token.surface_form || '';
    const known = tokenIsKnown(token);
    const mode = $('furiganaMode').value;
    const showRuby = !forcePlain && mode !== 'none' && (mode === 'all' || !known) && containsKanji(surface);
    const reading = token.reading && token.reading !== '*' ? toHiragana(token.reading) : '';
    const title = [token.basic_form && token.basic_form !== '*' ? `Форма: ${token.basic_form}` : '', reading ? `Чтение: ${reading}` : ''].filter(Boolean).join(' · ');
    return `<span class="word${known ? ' is-known' : ''}" tabindex="0" role="button" data-surface="${escapeHTML(surface)}" data-basic="${escapeHTML(token.basic_form && token.basic_form !== '*' ? token.basic_form : surface)}" data-reading="${escapeHTML(reading)}" data-pos="${escapeHTML([token.pos,token.pos_detail_1,token.pos_detail_2].filter(v => v && v !== '*').join(' · '))}" data-key="${escapeHTML(dictionaryKey(token))}" title="${escapeHTML(title || 'Нажми, чтобы открыть словарь')}">${furiganaHTML(surface, reading, showRuby)}</span>`;
  }
  function renderAnalyzedText() {
    copy.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (let paragraphIndex=0; paragraphIndex<analyzedParagraphs.length; paragraphIndex++) {
      const paragraph=analyzedParagraphs[paragraphIndex];
      const p = document.createElement('p'); p.dataset.paragraphIndex=String(paragraphIndex);
      if (paragraph.heading) p.className = 'chapter-heading';
      if (!paragraph.tokens) { p.textContent = paragraph.text; }
      else {
        const raw = paragraph.text; let cursor = 0;
        for (const token of paragraph.tokens) {
          const surface = String(token.surface_form || ''); if (!surface) continue;
          let idx = raw.indexOf(surface, cursor);
          if (idx < 0) idx = cursor;
          if (idx > cursor) p.appendChild(document.createTextNode(raw.slice(cursor, idx)));
          const wrap = document.createElement('span'); wrap.innerHTML = renderToken(token); p.appendChild(wrap.firstChild);
          cursor = Math.min(raw.length, idx + surface.length);
        }
        if (cursor < raw.length) p.appendChild(document.createTextNode(raw.slice(cursor)));
      }
      fragment.appendChild(p);
    }
    copy.appendChild(fragment);
    reader.classList.toggle('has-text', copy.textContent.trim().length > 0);
    updateTransform(); updateSeekUI();
  }
  function startAutomaticDictionaryLoad() {
    if(autoDictionaryStarted || dictionaryLoaded) return;
    autoDictionaryStarted=true;
    setBootStep('dictionary','active','Загружаю английский и русский JMdict…');
    setBootProgress(Math.max(52,bootProgress),'Подготовка словарей','Подключаю переводы и подготавливаю индекс поиска. При первом запуске это займёт немного времени.');
    loadFullDictionary().then(ok=>{
      if(ok) {
        bootDictionaryReady=true;
        setBootStep('dictionary','done',`Готово · ${dictionaryEntries.length.toLocaleString('ru-RU')} записей`);
        setBootStep('ready','active','Завершаю подготовку');
        if(bootAnalyzerReady) completeFirstSetup();
        else failFirstSetup('analyzer','Словарь готов, но анализатор не подключился. Можно продолжить чтение без автоматической фуриганы.');
      } else failFirstSetup('dictionary',dictLoadStatus.textContent || 'Не удалось подключить словари.');
    }).catch(err=>{console.warn('Automatic JMdict setup failed:',err);failFirstSetup('dictionary',err?.message || 'Не удалось подключить словари.');});
  }
  async function applyText(text, opts={}) {
    const version = ++renderVersion;
    analyzerBusy = true;
    const clean = String(text || '').replace(/\r\n?/g, '\n').trim();
    textInput.value = clean;
    if (opts.paragraphs) analyzedParagraphs=opts.paragraphs.map(p=>({text:String(p.text||''),heading:!!p.heading,tokens:null}));
    else analyzedParagraphs=plainDocument(clean,opts.title||currentBookName||'Текст').paragraphs.map(p=>({...p,tokens:null}));
    if (opts.chapters) currentChapters=opts.chapters.map(c=>({...c}));
    else if (!currentChapters.length || (!opts.preservePosition && opts.source!=='library' && !opts.bookId)) currentChapters=plainDocument(clean,opts.title||currentBookName||'Текст').chapters;
    if (!opts.preservePosition) { offset=0; isFinished=false; pause(false); }
    pendingRestoreRatio=opts.restoreRatio==null ? (opts.preservePosition ? getProgressRatio() : 0) : Number(opts.restoreRatio)||0;
    // Новая книга: пользователь ещё ничего не сдвигал, отложенное восстановление уместно.
    userMovedSinceApply=false;
    pinnedChapter=null;
    renderChapterControls(); renderBookmarkControls();
    if (!clean) { renderAnalyzedText(); setSystemStatus('Текст очищен. Открой EPUB / TXT или вставь фрагмент.', 'ready'); return; }
    renderAnalyzedText();
    setSystemStatus(`Текст загружен: ${analyzedParagraphs.length.toLocaleString('ru-RU')} абз. Подключаю анализатор…`);
    const restore=()=>new Promise(resolve=>requestAnimationFrame(()=>{
      if(version!==renderVersion) { resolve(); return; }
      // Анализ большого текста идёт долго, особенно на телефоне. Если за это время
      // пользователь уже перешёл к другой главе или нажал «рестарт», сохранённая
      // позиция не должна его откатывать.
      if (userMovedSinceApply) { pendingRestoreRatio=null; resolve(); return; }
      const ratio=pendingRestoreRatio || 0; offset=Math.max(0,Math.min(getMaxOffset(),ratio*getMaxOffset()));
      pendingRestoreRatio=null; isFinished=ratio>=0.9995; updateTransform(); updateSeekUI(); setState(false);
      if(currentBookId) saveCurrentProgress();
      resolve();
    }));
    try {
      const tok = await ensureTokenizer();
      if (version !== renderVersion) return;
      for (let i = 0; i < analyzedParagraphs.length; i++) {
        if (version !== renderVersion) return;
        const item = analyzedParagraphs[i];
        try { item.tokens = await tok.tokenize(item.text); } catch (_) { item.tokens = null; }
        if (i % 20 === 0) {
          setSystemStatus(`Разбираю японский текст: ${Math.min(i+1, analyzedParagraphs.length).toLocaleString('ru-RU')} / ${analyzedParagraphs.length.toLocaleString('ru-RU')} абз.…`);
          await new Promise(resolve => requestAnimationFrame(() => resolve()));
        }
      }
      if (version !== renderVersion) return;
      renderAnalyzedText(); await restore();
      analyzerBusy = false;
      setSystemStatus(`Анализ готов · ${analyzedParagraphs.length.toLocaleString('ru-RU')} абз. · нажимай на слово для поиска в словаре`, 'ready');
      bootAnalyzerReady=true; setBootStep('analyzer','done','Анализатор подключён и готов к работе');
      setBootProgress(Math.max(50,bootProgress),'Анализатор готов','Теперь загружаются словари, чтобы поиск и переводы работали без ручной настройки.');
      if(bootDictionaryReady) completeFirstSetup();
      else startAutomaticDictionaryLoad();
    } catch (err) {
      if (version !== renderVersion) return;
      renderAnalyzedText(); await restore(); analyzerBusy = false; bootAnalyzerFailed=true;
      setSystemStatus('Не удалось загрузить анализатор из локальных файлов приложения. Текст доступен, но фуригана и выбор слов пока недоступны. Попробуй повторить подключение.', 'error', true);
      setBootStep('analyzer','error',err?.message || 'Анализатор не запустился');
      setBootProgress(Math.max(48,bootProgress),'Анализатор не подключился','Продолжаю подготовку словаря. Можно будет продолжить чтение и повторить подключение анализатора позже.');
      console.warn('Kuromoji initialization failed:', err);
      startAutomaticDictionaryLoad();
    }
  }

  function extractHtmlText(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // EPUB ruby markers: without this, textContent would duplicate the reading
    // ("漢かん" instead of "漢") because <rt> and <rp> are regular inline text.
    doc.querySelectorAll('script,style,noscript,svg,nav,aside,footer,header,form,button,rt,rp').forEach(el => el.remove());
    const body = doc.body || doc.documentElement;
    const all = Array.from(body.querySelectorAll('h1,h2,h3,h4,h5,p,blockquote,pre,li'));
    const blocks = all.filter(el => !(el.tagName === 'LI' && el.querySelector('p')));
    function withBreaks(el) {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('br').forEach(br => br.replaceWith(document.createTextNode('\n')));
      return (clone.textContent || '').replace(/[\t\u00a0 ]+/g, ' ').replace(/ *\n */g, '\n').trim();
    }
    let paragraphs = blocks.map(withBreaks).filter(Boolean);
    if (!paragraphs.length) paragraphs = [(body.textContent || '').replace(/[\t\u00a0 ]+/g, ' ').trim()].filter(Boolean);
    // remove adjacent duplicate fragments sometimes produced by nested publisher markup
    paragraphs = paragraphs.filter((value, idx) => !(idx && value === paragraphs[idx-1]));
    return paragraphs.join('\n\n');
  }
  function resolveZipPath(baseFile, relative) {
    const cleanBase = baseFile.split('/').slice(0, -1).join('/');
    const u = new URL(relative, 'https://epub.invalid/' + (cleanBase ? cleanBase + '/' : ''));
    return decodeURIComponent(u.pathname.replace(/^\//, ''));
  }
  async function importEpub(file) {
    const JSZip = await ensureJSZip();
    setSystemStatus('Открываю EPUB: распаковываю контейнер и читаю главы…');
    const zip = await JSZip.loadAsync(file);
    const containerFile = zip.file('META-INF/container.xml');
    if (!containerFile) throw new Error('В файле нет META-INF/container.xml — это не похоже на EPUB.');
    const containerXML = new DOMParser().parseFromString(await containerFile.async('text'), 'application/xml');
    const rootfile = containerXML.querySelector('rootfile');
    const opfPath = rootfile?.getAttribute('full-path');
    if (!opfPath || !zip.file(opfPath)) throw new Error('Не найден OPF-пакет книги.');
    const opfXML = new DOMParser().parseFromString(await zip.file(opfPath).async('text'), 'application/xml');
    const dcTitle = opfXML.getElementsByTagNameNS('*','title')[0]?.textContent?.trim();
    const manifest = new Map();
    opfXML.querySelectorAll('manifest > item').forEach(item => manifest.set(item.getAttribute('id'), {href:item.getAttribute('href'),mediaType:item.getAttribute('media-type'),properties:item.getAttribute('properties')||''}));
    const spineItems = Array.from(opfXML.querySelectorAll('spine > itemref'));
    if (!spineItems.length) throw new Error('В EPUB не найден порядок чтения глав (spine).');
    const paragraphs=[], chapters=[]; let repeatedTitle='';
    for (let i=0; i<spineItems.length; i++) {
      const ref=spineItems[i], item=manifest.get(ref.getAttribute('idref'));
      if(!item||!item.href||(item.mediaType&&!/xhtml|html|xml/i.test(item.mediaType))) continue;
      let path; try { path=resolveZipPath(opfPath,item.href); } catch(_) { path=item.href; }
      const entry=zip.file(path)||zip.file(path.replace(/^\.\//,'')); if(!entry) continue;
      const html=await entry.async('text');
      const doc=new DOMParser().parseFromString(html,'text/html');
      const visibleHeading=(doc.querySelector('body h1,body h2,body h3,body h4')?.textContent||'').trim();
      const docTitle=(doc.querySelector('title')?.textContent||'').trim();
      let chapterTitle=visibleHeading || docTitle;
      if(!chapterTitle || chapterTitle.length>120 || (i>0 && chapterTitle===repeatedTitle)) chapterTitle=`Глава ${chapters.length+1}`;
      if(docTitle) repeatedTitle=docTitle;
      const content=extractHtmlText((doc.body||doc.documentElement).innerHTML||html);
      const localParas=content.split(/\n\s*\n/).map(x=>x.trim()).filter(Boolean);
      if(!localParas.length) continue;
      const startParagraph=paragraphs.length;
      const firstNorm=normalizeSearch(localParas[0]);
      if(chapterTitle && normalizeSearch(chapterTitle)!==firstNorm && chapterTitle!==dcTitle) paragraphs.push({text:chapterTitle,heading:true});
      else if(chapterTitle && normalizeSearch(chapterTitle)===firstNorm) localParas.shift();
      // A repeated book title isn't useful as a chapter name; give this section a stable label.
      if(!chapterTitle || chapterTitle===dcTitle) chapterTitle=`Глава ${chapters.length+1}`;
      for(const value of localParas) paragraphs.push({text:value,heading:/^#{1,6}\s+/.test(value)});
      const endParagraph=paragraphs.length-1;
      if(endParagraph>=startParagraph) chapters.push({title:chapterTitle,startParagraph,endParagraph});
      if(i%10===0){setSystemStatus(`Читаю EPUB: раздел ${i+1} из ${spineItems.length}…`);await new Promise(resolve=>requestAnimationFrame(()=>resolve()));}
    }
    if(!paragraphs.length) throw new Error('Текст не удалось извлечь. Возможно, книга представляет собой скан или нестандартный EPUB.');
    if(chapters.length){chapters[0].startParagraph=0;for(let i=0;i<chapters.length;i++){if(i<chapters.length-1)chapters[i].endParagraph=chapters[i+1].startParagraph-1;else chapters[i].endParagraph=paragraphs.length-1;}}
    return {title:dcTitle||file.name.replace(/\.epub$/i,''),source:file.name,paragraphs,chapters};
  }

  function uniqueStrings(items) { return [...new Set(items.map(x => String(x || '').trim()).filter(Boolean))]; }
  function normalizeSearch(value) { return String(value || '').normalize('NFKC').trim().toLocaleLowerCase(); }
  function searchHasJapanese(value) { return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff々〆ヶ]/.test(value || ''); }
  function toKatakana(value) { return String(value || '').replace(/[\u3041-\u3096]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60)); }
  function preferredWriting(entry) {
    const commonKanji = (entry.kanji || []).find(k => k.common);
    const commonKana = (entry.kana || []).find(k => k.common);
    return commonKanji?.text || entry.kanji?.[0]?.text || commonKana?.text || entry.kana?.[0]?.text || '—';
  }
  function preferredReading(entry, writing='') {
    const readings = entry.kana || [];
    const applies = readings.find(r => r.text && (r.appliesToKanji || []).includes(writing));
    const any = readings.find(r => r.common) || readings[0];
    return applies?.text || any?.text || '';
  }
  function canonicalEntryKey(entry) {
    const writing = preferredWriting(entry), reading = toHiragana(preferredReading(entry, writing));
    return `${writing}\u241f${reading}`;
  }
  function dictionaryEntryCommon(entry) { return !!((entry.kanji || []).some(x => x.common) || (entry.kana || []).some(x => x.common)); }
  function englishSensesFromWord(word) {
    return (word.sense || []).map(s => ({
      pos: uniqueStrings(s.partOfSpeech || []),
      defs: uniqueStrings((s.gloss || []).filter(g => !g.lang || g.lang === 'eng').map(g => g.text))
    })).filter(s => s.defs.length);
  }
  function russianSensesFromWord(word) {
    return (word.sense || []).map(s => ({
      pos: uniqueStrings(s.partOfSpeech || []),
      defs: uniqueStrings((s.gloss || []).filter(g => g.lang === 'rus').map(g => g.text))
    })).filter(s => s.defs.length);
  }
  function normalizeWordForms(word) {
    return {
      kanji: (word.kanji || []).map(k => ({text:k.text, common:!!k.common, tags:k.tags || []})),
      kana: (word.kana || []).map(k => ({text:k.text, common:!!k.common, appliesToKanji:k.appliesToKanji || [], tags:k.tags || []}))
    };
  }
  async function openDictionaryDB() {
    if (dictionaryDBPromise) return dictionaryDBPromise;
    dictionaryDBPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB недоступен')); return; }
      const request = indexedDB.open(JM_DB_NAME, 1);
      request.onupgradeneeded = () => { const db=request.result; if(!db.objectStoreNames.contains('archives')) db.createObjectStore('archives'); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Не удалось открыть кэш словаря'));
      request.onblocked = () => reject(new Error('Кэш словаря заблокирован другой вкладкой'));
    }).catch(err => { dictionaryDBPromise=null; throw err; });
    return dictionaryDBPromise;
  }
  async function readCachedArchive(language) {
    try {
      const db = await openDictionaryDB();
      return await new Promise((resolve,reject) => {
        const request=db.transaction('archives','readonly').objectStore('archives').get(`${JM_VERSION}-${language}`);
        request.onsuccess=()=>resolve(request.result || null); request.onerror=()=>reject(request.error);
      });
    } catch (_) { return null; }
  }
  async function cacheArchive(language, buffer) {
    try {
      const db = await openDictionaryDB();
      await new Promise((resolve,reject) => {
        const tx=db.transaction('archives','readwrite');
        tx.objectStore('archives').put(buffer,`${JM_VERSION}-${language}`);
        tx.oncomplete=()=>resolve(); tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error);
      });
      return true;
    } catch (_) { return false; }
  }
  async function fetchWithTimeout(url, options = {}, timeoutMs = 180000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`Истекло время ожидания загрузки ресурса (${Math.round(timeoutMs / 1000)} с).`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  async function fetchArchive(language) {
    const cached = await readCachedArchive(language);
    if (cached instanceof ArrayBuffer && cached.byteLength) {
      updateDictStatus(`Архив ${language === 'rus' ? 'RU' : 'EN'} найден в локальном кэше…`);
      return cached;
    }
    const url = JM_ASSETS[language];
    updateDictStatus(`Скачиваю JMdict ${language === 'rus' ? 'на русском' : 'на английском'}…`);
    const response = await fetchWithTimeout(url, {credentials:'omit', cache:'force-cache'}, 180000);
    if (!response.ok) throw new Error(`Не удалось скачать ${language.toUpperCase()} архив: HTTP ${response.status}`);
    let buffer;
    if (response.body && response.body.getReader) {
      const reader = response.body.getReader(), chunks=[]; let received=0;
      const total = Number(response.headers.get('content-length')) || 0;
      while (true) {
        const part=await reader.read(); if(part.done) break;
        chunks.push(part.value); received+=part.value.byteLength;
        const mb=(received/1048576).toFixed(1).replace('.',',');
        const totalText=total ? ` / ${(total/1048576).toFixed(1).replace('.',',')} МБ` : '';
        updateDictStatus(`Скачиваю ${language.toUpperCase()}: ${mb}${totalText}`);
      }
      const all=new Uint8Array(received); let pos=0; for(const chunk of chunks){all.set(chunk,pos);pos+=chunk.length;}
      buffer=all.buffer;
    } else buffer=await response.arrayBuffer();
    await cacheArchive(language, buffer.slice(0));
    return buffer;
  }
  /**
   * Загружает собранный на CI словарь и раскладывает кортежи в обычные записи.
   * Формат: [id, kanji, kana, senses, rusSenses, common], части речи — индексы.
   */
  async function ingestCompiledDictionary(data, label='') {
    const posTable = data.pos || [];
    const rows = data.entries || [];
    const posOf = (indices) => (indices || []).map((index) => posTable[index]).filter(Boolean);
    const next = new Map();
    for (let i = 0; i < rows.length; i++) {
      const [id, kanji, kana, senses, rusSenses, common] = rows[i];
      next.set(id, {
        id,
        kanji: (kanji || []).map(([text, isCommon]) => ({ text, common: !!isCommon })),
        kana: (kana || []).map(([text, isCommon, appliesToKanji]) => ({
          text,
          common: !!isCommon,
          appliesToKanji: appliesToKanji || [],
        })),
        senses: (senses || []).map(([pos, defs]) => ({ pos: posOf(pos), defs: defs || [] })),
        rusSenses: (rusSenses || []).map(([pos, defs]) => ({ pos: posOf(pos), defs: defs || [] })),
        common: !!common,
      });
      if (i && i % 20000 === 0) {
        updateDictStatus(`${label}: ${i.toLocaleString('ru-RU')} / ${rows.length.toLocaleString('ru-RU')} записей…`);
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      }
    }
    dictionaryById = next;
    try { data.entries.length = 0; } catch (_) {}
  }
  async function fetchCompiledDictionary(key, label) {
    const response = await fetchWithTimeout(COMPILED_DICT[key], { credentials: 'omit', cache: 'force-cache' }, 180000);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    let buffer;
    if (response.body && response.body.getReader) {
      const reader = response.body.getReader(), chunks = [];
      let received = 0;
      const total = Number(response.headers.get('content-length')) || 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        chunks.push(part.value);
        received += part.value.byteLength;
        const mb = (received / 1048576).toFixed(1).replace('.', ',');
        const totalText = total ? ` / ${(total / 1048576).toFixed(1).replace('.', ',')} МБ` : '';
        updateDictStatus(`Скачиваю ${label}: ${mb}${totalText}`);
      }
      buffer = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
      buffer = buffer.buffer;
    } else {
      buffer = await response.arrayBuffer();
    }
    updateDictStatus(`Разбираю ${label}…`);
    return JSON.parse(new TextDecoder().decode(buffer));
  }
  async function parseDictionaryArchive(input, forcedLanguage=null, fileName='') {
    const JSZip = await ensureJSZip();
    let data;
    if (input instanceof File && /\.json$/i.test(input.name)) {
      data=JSON.parse(await input.text());
      fileName=input.name;
    } else {
      const zip=await JSZip.loadAsync(input);
      const jsonFile=Object.values(zip.files).find(f=>!f.dir && /\.json$/i.test(f.name));
      if(!jsonFile) throw new Error('В архиве не найден JSON-файл словаря.');
      fileName=fileName || jsonFile.name;
      data=JSON.parse(await jsonFile.async('string'));
    }
    if(!Array.isArray(data.words)) throw new Error('JSON не похож на JMdict-Simplified: поле words не найдено.');
    let language=forcedLanguage;
    if(!language) language=/jmdict-rus|rus/i.test(fileName) ? 'rus' : 'eng';
    return {data,language};
  }
  async function ingestDictionary(data, language, statusLabel='', rebuildIndex=true) {
    if (language === 'eng') {
      const words=data.words || [];
      for(let i=0;i<words.length;i++) {
        const w=words[i], id=String(w.id);
        const old=dictionaryById.get(id);
        const forms=normalizeWordForms(w);
        dictionaryById.set(id, {
          id, kanji:forms.kanji, kana:forms.kana,
          senses:englishSensesFromWord(w),
          rusSenses:old?.rusSenses || [],
          tags:w.tags || {},
          common: dictionaryEntryCommon(forms),
        });
        if(i && i%20000===0) { updateDictStatus(`Индексирую JMdict EN: ${i.toLocaleString('ru-RU')} / ${words.length.toLocaleString('ru-RU')}…`); await new Promise(resolve=>requestAnimationFrame(()=>resolve())); }
      }
    } else {
      const words=data.words || [];
      for(let i=0;i<words.length;i++) {
        const w=words[i], id=String(w.id), old=dictionaryById.get(id);
        const forms=normalizeWordForms(w);
        dictionaryById.set(id, {
          id, kanji:old?.kanji?.length ? old.kanji : forms.kanji,
          kana:old?.kana?.length ? old.kana : forms.kana,
          senses:old?.senses || [], rusSenses:russianSensesFromWord(w),
          tags:old?.tags || w.tags || {},
          common:old ? old.common : dictionaryEntryCommon(forms),
        });
        if(i && i%15000===0) { updateDictStatus(`Подключаю русские переводы: ${i.toLocaleString('ru-RU')} / ${words.length.toLocaleString('ru-RU')}…`); await new Promise(resolve=>requestAnimationFrame(()=>resolve())); }
      }
    }
    // Release the large source object as soon as its compact entries have been extracted.
    try { data.words.length=0; } catch (_) {}
    if(rebuildIndex) await updateDictionaryIndex();
    if(statusLabel) updateDictStatus(statusLabel, 'ready');
  }
  async function updateDictionaryIndex() {
    dictionaryEntries=[...dictionaryById.values()];
    formIndex=new Map(); prefixIndex=new Map();
    const total=dictionaryEntries.length;
    for(let i=0;i<total;i++) {
      if(i && i%5000===0) {
        updateDictStatus(`Индексирую словарь: ${i.toLocaleString('ru-RU')} / ${total.toLocaleString('ru-RU')} записей…`);
        await new Promise(resolve=>requestAnimationFrame(()=>resolve()));
      }
      const entry=dictionaryEntries[i];
      const forms=new Set([...(entry.kanji||[]).map(x=>x.text),...(entry.kana||[]).map(x=>x.text)]);
      for(const form of forms) {
        const norm=normalizeSearch(form); if(!norm) continue;
        if(!formIndex.has(norm)) formIndex.set(norm,[]);
        formIndex.get(norm).push(entry);
        const chars=[...norm];
        if(chars.length>=2) {
          const prefix=chars.slice(0,2).join('');
          if(!prefixIndex.has(prefix)) prefixIndex.set(prefix,[]);
          prefixIndex.get(prefix).push(norm);
        }
      }
    }
    dictionaryLoaded=dictionaryEntries.length>0;
    dictStateDot.classList.toggle('ready',dictionaryLoaded);
    dictStateDot.classList.toggle('error',dictionaryLoadFailed);
    if(dictSearch.value.trim()) queueDictionarySearch(true);
    if(currentWord) showWordInDictionary(currentWord, true);
  }
  function updateDictStatus(message, state='loading') {
    dictLoadStatus.textContent=message; dictStateDot.classList.toggle('ready',state==='ready'); dictStateDot.classList.toggle('error',state==='error');
    dictStateDot.title=message; dictStateDot.setAttribute('aria-label',message);
    if(state==='ready') dictFallback.hidden=true;
    // Preserve the analyzer retry control while dictionary progress updates the same status bar.
    // Пока идёт анализ текста, прогресс словаря остаётся в панели словаря и в
    // экране первого запуска, чтобы не перебивать статус анализатора.
    if (!analyzerBusy || state === 'error') {
      setSystemStatus(message,bootAnalyzerFailed?'error':state==='error'?'error':state==='ready'?'ready':'loading',bootAnalyzerFailed);
    }
    updateBootDictionaryProgress(message,state);
  }
  /** Загружает собранный на CI словарь: сначала частые слова, потом полный набор. */
  async function loadCompiledDictionary() {
    try {
      const core = await fetchCompiledDictionary('core', 'частый словарь');
      await ingestCompiledDictionary(core, 'Индексирую частый словарь');
      updateDictStatus('Индексирую частый словарь…');
      await updateDictionaryIndex();
      updateDictStatus(`Базовый словарь · ${dictionaryEntries.length.toLocaleString('ru-RU')} частых слов · догружаю полный…`);
    } catch (err) {
      // Ядро — оптимизация: без него грузим сразу полный словарь.
      console.warn('Compiled core dictionary unavailable:', err);
    }
    const full = await fetchCompiledDictionary('full', 'полный словарь');
    await ingestCompiledDictionary(full, 'Индексирую полный словарь');
    updateDictStatus('Индексирую полный словарь…');
    await updateDictionaryIndex();
  }

  async function loadFullDictionary(force=false) {
    if(dictionaryLoadingPromise) return dictionaryLoadingPromise;
    if(dictionaryLoaded && !force) { updateDictStatus(`JMdict подключён · ${dictionaryEntries.length.toLocaleString('ru-RU')} записей`,'ready'); return; }
    dictionaryLoadFailed=false;
    dictionaryLoadingPromise=(async()=>{
      try {
        try {
          await loadCompiledDictionary();
        } catch (compiledError) {
          // Совместимость: если собранного словаря нет (старый деплой или ручная
          // сборка только с архивами), грузим два zip-архива как раньше.
          console.warn('Compiled dictionary unavailable, using archives:', compiledError);
          await ensureJSZip();
          for(const language of ['eng','rus']) {
            updateDictStatus(language==='eng' ? 'Готовлю полный английский JMdict…' : 'Добавляю русские переводы…');
            const buffer=await fetchArchive(language);
            updateDictStatus(`Распаковываю словарь ${language.toUpperCase()}…`);
            const parsed=await parseDictionaryArchive(buffer,language,`jmdict-${language}-${JM_VERSION}.json`);
            await ingestDictionary(parsed.data, language, '', false);
          }
          updateDictStatus('Индексирую объединённый словарь…');
          await updateDictionaryIndex();
        }
        dictionaryLoaded=true; dictionaryLoadFailed=false;
        updateDictStatus(`Полный JMdict · ${dictionaryEntries.length.toLocaleString('ru-RU')} записей · русский + английский`,'ready');
        dictFallback.hidden=true;
        return true;
      } catch(err) {
        dictionaryLoadFailed=true;
        dictStateDot.classList.add('error');
        updateDictStatus(`Автозагрузка не удалась: ${err?.message || 'ошибка сети'}`,'error');
        dictFallback.hidden=false;
        dictSearchResults.innerHTML='<div class="dict-empty">Полный словарь не удалось загрузить автоматически. Проверь соединение или скачай архивы ниже и подключи их кнопкой выбора файла.</div>';
        console.warn('JMdict download failed:',err);
        return false;
      } finally { dictionaryLoadingPromise=null; }
    })();
    return dictionaryLoadingPromise;
  }
  async function importDictionaryFile(file) {
    try {
      updateDictStatus(`Читаю файл ${file.name}…`);
      const parsed=await parseDictionaryArchive(file,null,file.name);
      await ingestDictionary(parsed.data,parsed.language,`Подключён архив ${parsed.language.toUpperCase()}`);
      dictionaryLoadFailed=false;
      const needsOther=parsed.language==='eng' ? 'Для русских переводов также подключи Russian ZIP.' : 'Добавлен русский словарь; English ZIP расширит покрытие до полного JMdict.';
      updateDictStatus(`${parsed.language.toUpperCase()} · ${dictionaryEntries.length.toLocaleString('ru-RU')} словарных записей. ${needsOther}`,'ready');
    } catch(err) {
      dictionaryLoadFailed=true; updateDictStatus(`Не удалось прочитать словарь: ${err.message || 'ошибка файла'}`,'error'); dictFallback.hidden=false;
      console.error(err);
    }
  }
  const POS_RU = {
    'n':'сущ.', 'n-adv':'нареч. / сущ.', 'n-suf':'суффикс, сущ.', 'n-pref':'приставка, сущ.',
    'pn':'местоим. сущ.', 'adj-i':'и-прилаг.', 'adj-na':'на-прилаг.', 'adj-no':'но-прилаг.', 'adj-f':'прилаг.',
    'adv':'нареч.', 'adv-to':'нареч.', 'exp':'выражение', 'int':'междометие', 'conj':'союз', 'cop':'связка',
    'prt':'частица', 'pref':'приставка', 'suf':'суффикс', 'ctr':'счётное слово', 'aux':'вспом. слово',
    'v1':'глагол ichidan', 'v5u':'глагол godan', 'v5k':'глагол godan', 'v5g':'глагол godan', 'v5s':'глагол godan',
    'v5t':'глагол godan', 'v5n':'глагол godan', 'v5b':'глагол godan', 'v5m':'глагол godan', 'v5r':'глагол godan',
    'v5w':'глагол godan', 'vk':'глагол kuru', 'vs':'глагол suru', 'vs-i':'глагол suru', 'vi':'непереходный глагол', 'vt':'переходный глагол',
    'uk':'устаревшее употребление', 'ok':'устаревшее написание', 'arch':'архаизм', 'sl':'разговорное', 'col':'разговорное', 'hon':'почтительное', 'hum':'скромное'
  };
  function posLabels(senses) {
    const tags=uniqueStrings((senses||[]).flatMap(s=>s.pos||[]));
    return tags.slice(0,5).map(tag=>POS_RU[tag] || tag).join(' · ');
  }
  function setMobileDictionaryOpen(open) {
    if (!mobileLayoutQuery.matches) return;
    const isOpen = Boolean(open);
    if (isOpen && mobileSettings.open) mobileSettings.open = false;
    dictPanel.classList.toggle('mobile-sheet-open', isOpen);
    dictPanel.classList.toggle('mobile-sheet-collapsed', !isOpen);
    document.body.classList.toggle('mobile-dictionary-open', isOpen);
    mobileDictToggle.setAttribute('aria-expanded', String(isOpen));
    mobileDictionaryFab.setAttribute('aria-expanded', String(isOpen));
    mobileDictionaryFab.setAttribute('aria-label', isOpen ? 'Словарь открыт' : 'Открыть словарь');
    mobileDictToggle.setAttribute('aria-label', isOpen ? 'Свернуть словарь' : 'Развернуть словарь');
    mobileDictToggle.innerHTML = '<span aria-hidden="true">' + (isOpen ? '⌄' : '⌃') + '</span>';
  }
  function setMobileShelfOpen(open) {
    if (!mobileLayoutQuery.matches) return;
    const isOpen = Boolean(open);
    bookShelf.classList.toggle('mobile-collapsed', !isOpen);
    mobileShelfToggle.textContent = isOpen ? 'Скрыть' : 'Показать';
    mobileShelfToggle.setAttribute('aria-expanded', String(isOpen));
  }
  function syncResponsiveLayout() {
    const isMobile = mobileLayoutQuery.matches;
    document.body.classList.toggle('mobile-layout', isMobile);
    mobileSettings.open = !isMobile;
    document.body.classList.remove('mobile-settings-open');
    if (isMobile) {
      setMobileShelfOpen(false);
      setMobileDictionaryOpen(false);
    } else {
      bookShelf.classList.remove('mobile-collapsed');
      dictPanel.classList.remove('mobile-sheet-open', 'mobile-sheet-collapsed');
      document.body.classList.remove('mobile-dictionary-open');
      mobileDictToggle.setAttribute('aria-expanded', 'true');
      mobileDictToggle.setAttribute('aria-label', 'Словарь открыт');
      mobileDictToggle.innerHTML = '<span aria-hidden="true">⌃</span>';
    }
  }
  function setDictionaryView(view) {
    dictionaryView = view === 'detail' ? 'detail' : 'results';
    const detail = dictionaryView === 'detail';
    dictSearchResults.hidden = detail;
    dictDetail.hidden = !detail;
    $('dictResultsLabel').textContent = detail ? 'Словарная статья' : (dictSearch.value.trim() ? (isCyrillicQuery(dictSearch.value) ? 'Совпадения по русскому переводу' : 'Совпадения') : 'Результаты поиска');
    if (detail) $('dictResultsCount').textContent = '';
    if (dictMainView) dictMainView.scrollTop = 0;
  }
  function entryPreview(entry) {
    const russian=(entry.rusSenses||[]).flatMap(s=>s.defs||[]).find(Boolean);
    const english=(entry.senses||[]).flatMap(s=>s.defs||[]).find(Boolean);
    return russian || english || 'Перевод для этой записи не указан';
  }
  function entryReadingsLabel(entry) { return [...new Set((entry.kana||[]).map(x=>x.text).filter(Boolean))].slice(0,4).join('、'); }
  function isCyrillicQuery(value) { return /[\u0400-\u04FF]/.test(value || ''); }
  function cleanGlossText(value) {
    return normalizeSearch(value).replace(/ё/g, 'е').replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '').replace(/\s+/g, ' ').trim();
  }
  function russianWordStem(value) {
    const word = cleanGlossText(value).replace(/[^\p{L}]/gu, '');
    // Lightweight morphology for dictionary search (not a full Russian lemmatizer).
    // This makes птица / птицы / птицу comparable without matching arbitrary substrings.
    if (word.length < 5) return word;
    const endings = ['иями','ями','ами','ого','ему','ому','ыми','ими','ией','иям','иях','ою','ею','ией','ией','ьего','ьему','иях','ов','ев','ей','ам','ям','ах','ях','ами','ями','ою','ею','ая','яя','ое','ее','ые','ие','ый','ий','ой','ую','юю','ому','ему','а','я','ы','и','у','ю','е','о'];
    for (const ending of endings) {
      if (word.endsWith(ending) && word.length - ending.length >= 4) return word.slice(0, -ending.length);
    }
    return word;
  }
  function translationMatchScore(definition, query) {
    const rawDef=normalizeSearch(definition).replace(/ё/g,'е').replace(/\s+/g,' ').trim();
    const def=cleanGlossText(rawDef), q=cleanGlossText(query);
    if(!def||!q) return 0;
    const core=cleanGlossText(rawDef.replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g,' ').replace(/[–—]/g,' '));
    const coreTokens=core.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const qSingle=!/[\s-]/u.test(q);
    // Strongly prefer a standalone Russian gloss and the first lexical item in a gloss;
    // a category note such as "кондор (птица)" should not beat the direct translation "птица".
    if(def===q) return 360;
    if(core===q) return 345;
    const firstGloss=cleanGlossText(rawDef.split(/[;；]/u)[0].replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g,' '));
    if(firstGloss===q) return 330;
    if(core.startsWith(q)) {
      const next=[...core.slice(q.length)][0]||'';
      if(!/[\p{L}\p{N}]/u.test(next)) return 305;
    }
    if(coreTokens.includes(q)) return 245;
    if(qSingle && isCyrillicQuery(q) && q.length>=5) {
      const stem=russianWordStem(q);
      if(stem.length>=4 && coreTokens.some(token=>russianWordStem(token)===stem)) return 265;
    }
    if(def.includes(q) && !core.includes(q)) return 25;
    let from=0;
    while((from=core.indexOf(q,from))!==-1) {
      const before=from>0?[...core.slice(0,from)].pop():'';
      const after=[...core.slice(from+q.length)][0]||'';
      const boundary=(!before||!/[\p{L}\p{N}]/u.test(before))&&(!after||!/[\p{L}\p{N}]/u.test(after));
      if(boundary) return 150;
      from+=Math.max(1,q.length);
    }
    return core.includes(q)?20:0;
  }

  function searchDictionary(query, limit=35) {
    const q=normalizeSearch(query); if(!q || !dictionaryEntries.length) return [];
    const keys=[q];
    if(searchHasJapanese(q)) {
      const h=normalizeSearch(toHiragana(q)), k=normalizeSearch(toKatakana(q));
      if(h && !keys.includes(h)) keys.push(h); if(k && !keys.includes(k)) keys.push(k);
      const found=new Map();
      for(const key of keys) for(const entry of (formIndex.get(key)||[])) found.set(entry.id,{entry,score:100});
      if([...q].length>=2 && found.size<limit*2) {
        const chars=[...q], pref=chars.slice(0,2).join('');
        for(const form of (prefixIndex.get(pref)||[])) {
          if(keys.some(key=>form.startsWith(key))) for(const entry of (formIndex.get(form)||[])) {
            if(!found.has(entry.id)) found.set(entry.id,{entry,score:55});
          }
          if(found.size>=limit*5) break;
        }
      }
      return [...found.values()].sort((a,b)=>b.score-a.score || Number(dictionaryEntryCommon(b.entry))-Number(dictionaryEntryCommon(a.entry)) || a.entry.id.localeCompare(b.entry.id)).slice(0,limit).map(x=>x.entry);
    }
    // Cyrillic queries search Russian glosses only, avoiding irrelevant English matches.
    const russianOnly = isCyrillicQuery(q);
    const matches=[];
    for(const entry of dictionaryEntries) {
      let score=0;
      for(const sense of (entry.rusSenses||[])) {
        for(const def of (sense.defs||[])) score=Math.max(score,translationMatchScore(def,q));
        if(score>=180) break;
      }
      if(!russianOnly) {
        for(const sense of (entry.senses||[])) {
          for(const def of (sense.defs||[])) score=Math.max(score,translationMatchScore(def,q));
          if(score>=180) break;
        }
      }
      if(score) {
        const baseWriting = preferredWriting(entry);
        const lexicalBoost = (dictionaryEntryCommon(entry) ? 9 : 0) + (baseWriting && [...baseWriting].length <= 2 ? 5 : 0) + (baseWriting && containsKanji(baseWriting) ? 4 : 0);
        // Ties for common one-kanji entries are broken by how directly the gloss represents the query.
        matches.push({entry,score:score+lexicalBoost});
      }
    }
    matches.sort((a,b)=>b.score-a.score || Number(dictionaryEntryCommon(b.entry))-Number(dictionaryEntryCommon(a.entry)) || a.entry.id.localeCompare(b.entry.id));
    return matches.slice(0,limit).map(x=>x.entry);
  }
  function renderSearchResults(entries, query) {
    dictSearchResults.replaceChildren();
    if(dictionaryView==='results') $('dictResultsLabel').textContent=query ? (isCyrillicQuery(query) ? 'Совпадения по русскому переводу' : 'Совпадения') : 'Результаты поиска';
    if(dictionaryView==='results') $('dictResultsCount').textContent=entries.length ? `${entries.length}${entries.length>=35?' +':''}` : '';
    if(!query) { dictSearchResults.innerHTML='<div class="dict-empty">Нажми на слово в тексте или введи запрос на японском, русском или английском.</div>'; return; }
    if(!dictionaryEntries.length) { dictSearchResults.innerHTML='<div class="dict-empty">Словарь ещё не подключён. Идёт загрузка JMdict — можно попробовать повторить её кнопкой выше.</div>'; return; }
    if(!entries.length) { dictSearchResults.innerHTML='<div class="dict-empty">Ничего не найдено. Попробуй словарную форму, чтение хираганой или более короткий перевод.</div>'; return; }
    const fragment=document.createDocumentFragment();
    for(const entry of entries) {
      const button=document.createElement('button'); button.type='button'; button.className='dict-result'+(String(entry.id)===String(activeDictionaryEntryId)?' active':''); button.dataset.entryId=entry.id;
      const top=document.createElement('span'); top.className='dict-result-top';
      const word=document.createElement('span'); word.className='dict-result-word'; word.textContent=preferredWriting(entry);
      const reading=document.createElement('span'); reading.className='dict-result-reading'; reading.textContent=entryReadingsLabel(entry);
      top.append(word,reading);
      const preview=document.createElement('span'); preview.className='dict-result-preview'; preview.textContent=entryPreview(entry);
      const tags=document.createElement('span'); tags.className='dict-result-tags'; tags.textContent=[dictionaryEntryCommon(entry)?'частое слово':'',posLabels([...(entry.rusSenses||[]),...(entry.senses||[])])].filter(Boolean).join(' · ');
      button.append(top,preview); if(tags.textContent) button.append(tags); fragment.appendChild(button);
    }
    dictSearchResults.appendChild(fragment);
  }
  function renderSenseGroup(senses, heading, max=14) {
    if(!senses?.length) return '';
    let html=`<div class="dict-section-label">${escapeHTML(heading)}</div>`; let n=0;
    for(const sense of senses) {
      const defs=uniqueStrings(sense.defs||[]); if(!defs.length) continue;
      if(n>=max) break;
      const pos=uniqueStrings(sense.pos||[]).map(tag=>POS_RU[tag]||tag).slice(0,4).join(' · ');
      html+='<div class="dict-sense">'; if(pos) html+=`<div class="dict-sense-head">${escapeHTML(pos)}</div>`;
      html+='<ol class="dict-sense-defs">';
      for(const def of defs.slice(0,8)) { if(n>=max*8) break; html+=`<li>${escapeHTML(def)}</li>`; n++; }
      html+='</ol></div>';
    }
    return html;
  }
  function showDictionaryEntry(entry, wordContext=null) {
    activeDictionaryEntryId=String(entry.id);
    const writing=preferredWriting(entry), reading=preferredReading(entry,writing);
    const key=wordContext?.key || canonicalEntryKey(entry);
    currentWord={surface:wordContext?.surface || writing, basic:wordContext?.basic || writing, reading:wordContext?.reading || toHiragana(reading), pos:wordContext?.pos || posLabels([...(entry.rusSenses||[]),...(entry.senses||[])]), key, entryId:String(entry.id), tokenContext:wordContext || null};
    const forms=[...(entry.kanji||[]).map(x=>x.text),...(entry.kana||[]).map(x=>x.text)];
    const uniqueForms=[...new Set(forms)].filter(x=>x && x!==writing);
    let html=`<button type="button" class="dict-back" id="backToDictResults">← К результатам</button><div class="dict-detail-top"><div class="dict-detail-word">${escapeHTML(writing)}</div><div class="dict-detail-reading">${escapeHTML(entryReadingsLabel(entry) || reading)}</div><div class="dict-detail-meta">${dictionaryEntryCommon(entry)?'Частое слово · ':''}${escapeHTML(posLabels([...(entry.rusSenses||[]),...(entry.senses||[])]))}</div>`;
    if(uniqueForms.length) html+=`<div class="dict-form-chips">${uniqueForms.slice(0,14).map(x=>`<span class="dict-chip">${escapeHTML(x)}</span>`).join('')}</div>`;
    html+='</div>';
    html+=renderSenseGroup(entry.rusSenses||[],'Русский перевод',12);
    html+=renderSenseGroup(entry.senses||[],'English · JMdict',14);
    if(!(entry.rusSenses||[]).length && !(entry.senses||[]).length) html+='<p class="dict-note">Для этой записи перевод не найден в загруженных словарных данных.</p>';
    html+='<div class="dict-actions"><button class="button primary" id="knownToggle">'+(knownWords.has(key)?'✓ Известно — снять':'✓ Отметить как известное')+'</button>';
    html+=`<a class="button" href="https://jisho.org/search/${encodeURIComponent(writing+' #words')}" target="_blank" rel="noopener noreferrer">Jisho ↗</a></div>`;
    html+='<div class="dict-note">Словарные данные: JMdict / EDRDG. Русский перевод доступен не для каждой записи; английский охватывает полную базу.</div>';
    dictDetail.innerHTML=html;
    renderSearchResults(searchDictionary(dictSearch.value || writing, 35),dictSearch.value || writing);
    setDictionaryView('detail');
  }
  function showWordFallback(wordContext, message='') {
    const reading=wordContext.reading || '';
    dictDetail.innerHTML=`<button type="button" class="dict-back" id="backToDictResults">← К результатам</button><div class="dict-detail-top"><div class="dict-detail-word">${escapeHTML(wordContext.surface || wordContext.basic || '')}</div><div class="dict-detail-reading">${escapeHTML(reading)}</div><div class="dict-detail-meta">${escapeHTML(wordContext.pos || 'Слово из текста')}</div></div><p class="dict-note">${escapeHTML(message || 'Ищу словарную запись…')}</p><div class="dict-actions"><button class="button primary" id="knownToggle">${knownWords.has(wordContext.key)?'✓ Известно — снять':'✓ Отметить как известное'}</button><a class="button" href="https://jisho.org/search/${encodeURIComponent((wordContext.basic||wordContext.surface)+'%20%23words')}" target="_blank" rel="noopener noreferrer">Jisho ↗</a></div>`;
    setDictionaryView('detail');
  }
  function findEntryForContext(wordContext) {
    for(const candidate of [wordContext.basic,wordContext.surface]) {
      const list=formIndex.get(normalizeSearch(candidate))||[];
      if(list.length) return list.find(e=>preferredReading(e,preferredWriting(e)) && toHiragana(preferredReading(e,preferredWriting(e)))===toHiragana(wordContext.reading)) || list.find(dictionaryEntryCommon) || list[0];
    }
    return null;
  }
  function showWordInDictionary(wordContext, refresh=false) {
    if(!wordContext) return;
    const target=wordContext.tokenContext || wordContext;
    if(!refresh) {
      currentWord={...target};
      dictSearch.value=target.basic || target.surface || '';
    }
    if(!dictionaryEntries.length) {
      showWordFallback(target, 'Полный JMdict пока не загружен. Открой «Настройки словаря и загрузка файлов» под полем поиска и нажми «Загрузить / повторить».');
      return;
    }
    const exact=findEntryForContext(target);
    if(exact) showDictionaryEntry(exact,target);
    else {
      const results=searchDictionary(target.basic || target.surface,35);
      renderSearchResults(results,target.basic || target.surface);
      showWordFallback(target,'Точного совпадения не найдено. Проверь словарную форму или выбери подходящую запись в результатах.');
    }
  }
  function queueDictionarySearch(immediate=false) {
    if(dictionarySearchTimer) clearTimeout(dictionarySearchTimer);
    const run=()=>{
      setDictionaryView('results');
      const query=dictSearch.value.trim();
      if(!query) { activeDictionaryEntryId=null; renderSearchResults([], ''); return; }
      if(!dictionaryEntries.length) { renderSearchResults([],query); return; }
      const entries=searchDictionary(query,35); renderSearchResults(entries,query);
      // For exact Japanese lookup, preview the best exact entry without making the search field jump.
      if(searchHasJapanese(query)) {
        const exact=(formIndex.get(normalizeSearch(query)) || formIndex.get(normalizeSearch(toHiragana(query))) || formIndex.get(normalizeSearch(toKatakana(query))) || []);
        if(exact.length && !currentWord?.tokenContext && !activeDictionaryEntryId) showDictionaryEntry(exact.find(dictionaryEntryCommon)||exact[0]);
      }
    };
    if(immediate) run(); else dictionarySearchTimer=setTimeout(run,260);
  }
  async function showDictionary(tokenEl) {
    pause(false);
    if (mobileLayoutQuery.matches) setMobileDictionaryOpen(true);
    const surface=tokenEl.dataset.surface || tokenEl.textContent;
    const basic=tokenEl.dataset.basic || surface;
    const reading=tokenEl.dataset.reading || '';
    const wordContext={surface,basic,reading,pos:tokenEl.dataset.pos||'',key:tokenEl.dataset.key||`${basic}\u241f${reading}`};
    wordContext.tokenContext=wordContext;
    currentWord=wordContext; activeDictionaryEntryId=null;
    showWordFallback(wordContext,'Ищу словарную запись…');
    showWordInDictionary(wordContext);
    // Never load the large dictionary implicitly on a word click: that operation is user-triggered.
  }
  playPause.addEventListener('click', togglePlayback);
  restart.addEventListener('click', resetReader);
  $('speed').addEventListener('input', updateSettings);
  $('lineWidth').addEventListener('input', updateSettings);
  $('leading').addEventListener('input', updateSettings);
  $('fontSize').addEventListener('input', updateSettings);
  $('furiganaMode').addEventListener('change', () => { renderAnalyzedText(); updateTransform(); });
  $('textOrientation').addEventListener('change', (event) => setTextOrientation(event.target.value));
  $('applyText').addEventListener('click', async () => {
    const data=plainDocument(textInput.value,'Вставленный текст');
    if(!data.paragraphs.length) { setSystemStatus('Вставь текст перед добавлением на книжную полку.', 'error', true); return; }
    const title=data.paragraphs[0].text.replace(/^#{1,6}\s*/,'').slice(0,44) || `Вставленный текст · ${new Date().toLocaleDateString('ru-RU')}`;
    try { await addBookToShelf({title,source:'Вставленный текст',paragraphs:data.paragraphs,chapters:data.chapters}); editor.open=false; }
    catch(err) { setSystemStatus(`Не удалось добавить текст: ${err.message||err}`,'error',true); }
  });
  $('clearText').addEventListener('click', () => { textInput.value = ''; editor.open = true; });
  $('editText').addEventListener('click', () => { editor.open = true; editor.scrollIntoView({behavior:'smooth', block:'nearest'}); textInput.focus({preventScroll:true}); });
  $('openFile').addEventListener('click', () => filePicker.click());
  filePicker.addEventListener('change', async () => {
    const file=filePicker.files&&filePicker.files[0]; if(!file)return;
    try {
      let data;
      if(/\.epub$/i.test(file.name)||file.type==='application/epub+zip') data=await importEpub(file);
      else {
        const raw=await file.text(); const content=/\.html?$/i.test(file.name)?extractHtmlText(raw):raw;
        data=plainDocument(content,file.name.replace(/\.[^.]+$/,'')); data.title=file.name.replace(/\.[^.]+$/,''); data.source=file.name;
      }
      await addBookToShelf(data); editor.open=false;
    } catch(err) {
      console.error(err); setSystemStatus(`Не удалось открыть файл: ${err.message||'неизвестная ошибка'}`,'error',true);
      alert(`Не удалось открыть файл.\n\n${err.message||'Проверь формат книги.'}`);
    } finally { filePicker.value=''; }
  });
  $('prevChapter').addEventListener('click',()=>jumpToChapter((Number($('chapterSelect').value)||0)-1));
  $('nextChapter').addEventListener('click',()=>jumpToChapter((Number($('chapterSelect').value)||0)+1));
  $('chapterSelect').addEventListener('change',()=>jumpToChapter($('chapterSelect').value));
  $('addBookmark').addEventListener('click',saveBookmark);
  $('bookmarkSelect').addEventListener('change',()=>{const id=$('bookmarkSelect').value;if(id){jumpToBookmark(id);$('deleteBookmark').hidden=false;}else $('deleteBookmark').hidden=true;});
  $('deleteBookmark').addEventListener('click',()=>{
    const id=$('bookmarkSelect').value;if(!id||!currentBookRecord)return;
    currentBookRecord.bookmarks=(currentBookRecord.bookmarks||[]).filter(mark=>mark.id!==id);
    storeProgressMeta({bookmarks:currentBookRecord.bookmarks}).then(renderBookmarkControls);
  });
  $('shelfGrid').addEventListener('click',event=>{
    const remove=event.target.closest('[data-remove-book]');
    if(remove){event.stopPropagation();removeBookFromShelf(remove.dataset.removeBook);return;}
    const button=event.target.closest('[data-book-id]'); if(button) { activateSavedBook(button.dataset.bookId); setMobileShelfOpen(false); }
  });
  $('bookPosition').addEventListener('input',event=>{seekToRatio(Number(event.target.value)/1000,false);scheduleProgressSave();});
  $('bookPosition').addEventListener('change',()=>saveCurrentProgress());
  $('loadDictionary').addEventListener('click', () => {
    loadFullDictionary(true).then(ok => {
      if(ok) {
        bootDictionaryReady=true;
        if(bootAnalyzerReady) completeFirstSetup();
      }
    });
  });
  $('pickDictionary').addEventListener('click', () => dictFilePicker.click());
  dictFilePicker.addEventListener('change', async () => {
    const file=dictFilePicker.files && dictFilePicker.files[0]; if(!file) return;
    await importDictionaryFile(file); dictFilePicker.value='';
  });
  $('clearDictSearch').addEventListener('click', () => { dictSearch.value=''; currentWord=null; activeDictionaryEntryId=null; setDictionaryView('results'); queueDictionarySearch(true); dictSearch.focus(); });
  mobileDictToggle.addEventListener('click', () => setMobileDictionaryOpen(false));
  mobileDictionaryFab.addEventListener('click', () => { pause(false); setMobileDictionaryOpen(true); });
  mobileShelfToggle.addEventListener('click', () => setMobileShelfOpen(bookShelf.classList.contains('mobile-collapsed')));
  mobileSettingsQuick.addEventListener('click', () => {
    if (!mobileLayoutQuery.matches) return;
    mobileSettings.open = !mobileSettings.open;
    if (mobileSettings.open) {
      setMobileDictionaryOpen(false);
      mobileSettings.scrollIntoView({behavior:'smooth', block:'start'});
    }
  });
  mobileSettings.addEventListener('toggle', () => {
    if (!mobileLayoutQuery.matches) return;
    document.body.classList.toggle('mobile-settings-open', mobileSettings.open);
    if (mobileSettings.open) setMobileDictionaryOpen(false);
  });
  dictSearch.addEventListener('input', () => { currentWord=null; activeDictionaryEntryId=null; setDictionaryView('results'); queueDictionarySearch(false); });
  dictSearch.addEventListener('keydown', event => { if(event.key==='Enter') { event.preventDefault(); queueDictionarySearch(true); const first=dictSearchResults.querySelector('.dict-result'); if(first) first.click(); } });
  dictSearchResults.addEventListener('click', event => {
    const button=event.target.closest('.dict-result'); if(!button) return;
    const entry=dictionaryById.get(String(button.dataset.entryId)); if(!entry) return;
    currentWord=null; showDictionaryEntry(entry,null);
  });
  dictDetail.addEventListener('click', event => {
    if(event.target.closest('#backToDictResults')) {
      setDictionaryView('results');
      queueDictionarySearch(true);
      return;
    }
    if(!event.target.closest('#knownToggle') || !currentWord) return;
    if(knownWords.has(currentWord.key)) knownWords.delete(currentWord.key); else knownWords.add(currentWord.key);
    saveKnownWords();
    const button=dictDetail.querySelector('#knownToggle');
    if(button) button.textContent=knownWords.has(currentWord.key)?'✓ Известно — снять':'✓ Отметить как известное';
    renderAnalyzedText();
  });
  bootContinue.addEventListener('click',()=>{bootSplash.hidden=true;bootSplash.classList.remove('closing');});
  retryAnalyzer.addEventListener('click', async () => {
    resetAnalyzerWorker(); bootAnalyzerFailed=false;
    await applyText(textInput.value, {retry:true,preservePosition:true});
  });
  copy.addEventListener('click', event => {
    const word = event.target.closest('.word');
    if (word) { event.stopPropagation(); showDictionary(word); }
  });
  copy.addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.classList.contains('word')) { event.preventDefault(); showDictionary(event.target); }
  });

  function clickedOnGlyph(event) {
    let node = null, offsetInNode = 0;
    if (document.caretPositionFromPoint) { const pos = document.caretPositionFromPoint(event.clientX,event.clientY); if(pos){node=pos.offsetNode;offsetInNode=pos.offset;} }
    else if (document.caretRangeFromPoint) { const range = document.caretRangeFromPoint(event.clientX,event.clientY); if(range){node=range.startContainer;offsetInNode=range.startOffset;} }
    if (!node || node.nodeType !== Node.TEXT_NODE) return false;
    const value=node.textContent||''; if(!value.length) return false;
    const start=Math.max(0,Math.min(offsetInNode,value.length-1)); const range=document.createRange();
    range.setStart(node,start); range.setEnd(node,Math.min(start+1,value.length)); const rect=range.getBoundingClientRect();
    return rect.width>0 && event.clientX>=rect.left-2 && event.clientX<=rect.right+2 && event.clientY>=rect.top-2 && event.clientY<=rect.bottom+2;
  }
  reader.addEventListener('click', event => {
    if (event.target.closest('button,input,textarea,label,details,a,.word')) return;
    if (clickedOnGlyph(event)) return;
    togglePlayback();
  });
  reader.addEventListener('wheel', event => {
    if (!copy.textContent.trim()) return;
    event.preventDefault(); pause(false);
    // Тачпад присылает жест двумя пальцами как deltaY, а боком — как deltaX.
    // В вертикальном режиме боковой жест естественнее, поэтому берём
    // доминирующую ось, иначе прокрутка просто не срабатывала.
    const lineHeight = Number(event.deltaMode) === 1 ? 16 : 1;
    const delta = isVertical() && Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ? event.deltaX
      : event.deltaY;
    offset=Math.max(0,Math.min(getMaxOffset(),offset+delta*lineHeight*1.75));
    isFinished=offset>=getMaxOffset()-1; updateTransform(); updateSeekUI(); scheduleProgressSave();
  },{passive:false});
  document.addEventListener('keydown', event => {
    if (event.code !== 'Space' || event.repeat) return;
    const target=event.target;
    if(target && (target.matches('textarea,input,button,select,a') || target.isContentEditable || target.classList?.contains('word'))) return;
    event.preventDefault(); togglePlayback();
  });
  document.addEventListener('visibilitychange', () => { if(document.hidden && isPlaying) pause(); });
  window.addEventListener('resize', () => { if(isPlaying){stopAnimation();rafId=requestAnimationFrame(tick);} updateTransform(); updateSeekUI(); });
  if (mobileLayoutQuery.addEventListener) mobileLayoutQuery.addEventListener('change', syncResponsiveLayout);
  else mobileLayoutQuery.addListener(syncResponsiveLayout);
  syncResponsiveLayout();
  window.addEventListener('pagehide',()=>saveCurrentProgress());
  window.addEventListener('beforeunload',()=>saveCurrentProgress());

  textInput.value = sample;
  currentBookName='Демонстрационный текст';
  currentChapters=[{title:'Демонстрационный текст',startParagraph:0,endParagraph:sample.split(/\n\s*\n/).length-1}];
  applyOrientationStyles();
  updateSettings();
  applyText(sample,{title:'Демонстрационный текст'});
  // Словарь не зависит от анализатора: грузим оба параллельно, чтобы первый
  // запуск упирался в самый медленный ресурс, а не в их сумму.
  startAutomaticDictionaryLoad();
  refreshBookShelf().then(async()=>{
    let lastId=null; try{lastId=localStorage.getItem('kotoba-last-book-id')}catch(_){}
    if(lastId&&bookLibrary.some(b=>b.id===lastId)) await activateSavedBook(lastId);
  });
  // Словарь и анализатор грузятся параллельно; ресурсы отдаются локально и кэшируются в IndexedDB.
})();
