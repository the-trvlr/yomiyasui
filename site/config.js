/**
 * Единственный источник версий и общих констант приложения.
 *
 * ВАЖНО: этот файл читают не только браузеры, но и сборочные скрипты
 * (`scripts/prepare-site-assets.sh`, `.github/workflows/ci-cd.yml`).
 * Меняйте версию JMdict только здесь — иначе CI упадёт на `npm run check`.
 */

/** Версия приложения, отображается в шапке и на экране первого запуска. */
export const APP_VERSION = '1.1';

/** Снимок JMdict-Simplified. Формат: <версия>+<дата снимка>. */
export const JM_VERSION = '3.6.2+20261012204142';

/** Имя IndexedDB-кэша словарей. Меняйте при несовместимом формате кэша. */
export const JM_DB_NAME = 'kotoba-jmdict-cache-v03';
