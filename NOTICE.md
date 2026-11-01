# Сторонние компоненты и лицензии

Код 読みやすい распространяется по лицензии MIT (см. [LICENSE](LICENSE)).
Ниже перечислены сторонние компоненты и данные, которые включаются в сборку
сайта, и условия, на которых они используются.

## Данные словаря

### JMdict / JMdict-Simplified

- **Что используется:** словарные статьи JMdict, распространяемые в формате JSON
  проектом [jmdict-simplified](https://github.com/scriptin/jmdict-simplified),
  включая английский снимок (`jmdict-eng`) и русский снимок (`jmdict-rus`).
- **Правообладатели:** James William Breen и
  Electronic Dictionary Research and Development Group (EDRDG).
- **Лицензия:** Creative Commons Attribution-ShareAlike 4.0 International
  (CC BY-SA 4.0).
  - Условия: https://creativecommons.org/licenses/by-sa/4.0/
  - Условия EDRDG: https://www.edrdg.org/edrdg/licence.html
  - Проект JMdict: https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project
- **Требования, которые выполняет приложение:**
  - указание источника в интерфейсе (подпись под панелью словаря) и в этом файле;
  - ссылки на лицензию EDRDG и на проект jmdict-simplified;
  - регулярное обновление данных: версия снимка задаётся в
    [`site/config.js`](site/config.js) и проверяется в CI.
- **Важно:** данные JMdict **не** распространяются под MIT. Производные от них
  файлы (включая скомпилированные словарные индексы) распространяются на условиях
  CC BY-SA 4.0. Код приложения при этом может оставаться под MIT.

## Библиотеки

### Kuromoji.js

- **Что используется:** `kuromoji@0.1.2` — морфологический анализатор японского
  текста и его словарь.
- **Автор:** Takuya Asano и участники проекта.
- **Лицензия:** Apache License 2.0.
  - https://github.com/takuyaa/kuromoji.js/blob/master/LICENSE
- **Примечание:** файлы лицензии копируются в `site/vendor/kuromoji/` при сборке.

### JSZip

- **Что используется:** `jszip@3.10.1` — чтение ZIP-архивов, включая EPUB и
  архивы словарей.
- **Автор:** Stuart Knightley и участники проекта.
- **Лицензия:** двойная, MIT или GPLv3 (по выбору пользователя).
  - https://github.com/Stuk/jszip/blob/main/LICENSE.markdown
- **Примечание:** проект использует вариант MIT.

## Шрифты и оформление

Приложение не поставляет шрифты и использует только системные:
`Yu Mincho`, `Hiragino Mincho ProN`, `Noto Serif CJK JP`, `Noto Serif JP`,
а также системный sans-serif для интерфейса.

## Иконка

`site/app-icon.svg` создана для этого проекта и распространяется по лицензии MIT
вместе с остальным кодом.
