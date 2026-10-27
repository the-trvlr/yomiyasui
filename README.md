# 読みやすい — Japanese reading practice

A browser-based Japanese reading tool with bottom-to-top adjustable scrolling, EPUB/TXT/MD/HTML import, chapter navigation, bookmarks, saved per-book progress, furigana support, a JMdict-based dictionary panel, and a local book shelf.

## Live deployment

The GitHub Actions workflow in `.github/workflows/ci-cd.yml` validates the static app and deploys it to GitHub Pages when changes are pushed to `main` (or manually dispatched from `main`).

Expected URL: https://the-trvlr.github.io/yomiyasui/

## Project layout

- `site/index.html` — the application, first-run progress screen, and reader UI.
- `site/app-icon.svg` and `site/manifest.webmanifest` — app identity and install metadata.
- `site/analyzer-worker.js` — Japanese analysis in a background worker.
- `scripts/check-html.mjs` — CI checks for page structure and JavaScript syntax.
- `.github/workflows/ci-cd.yml` — validation and Pages deployment pipeline.

## Local development

Runtime assets are generated, not committed to Git. To create a local copy of the same self-contained static assets used by the deployment, run this once from the repository root (Node.js/npm and curl are required):

```sh
bash scripts/prepare-site-assets.sh
```

This downloads the pinned Kuromoji and JSZip libraries, their required files, and the JMdict English/Russian archives into `site/vendor/` and `site/data/`. These generated files are ignored by Git.

Then start a local static server:

```sh
python3 -m http.server 8000 --directory site
```

Open http://localhost:8000. Do not open the HTML directly as a `file://` URL: the analyzer and dictionary load their bundled resources over HTTP.

Run CI checks locally:

```sh
node scripts/check-html.mjs site/index.html
```

## GitHub Pages

The workflow deploys the `site/` directory using GitHub Actions. In **Settings → Pages**, select **GitHub Actions** as the build and deployment source if it has not been selected automatically. Check the Actions tab for the deployment result.

## Privacy and storage

The site is static and does not currently have accounts, a backend, or cloud synchronization. Books, progress, bookmarks, and known-word data are stored in the browser on the user's device. They are not committed to Git. Storage is specific to the browser profile and site origin.

Do not add books, private reading logs, dictionary caches, credentials, or other personal data to this repository.

## Dictionary data and bundled runtime assets

The GitHub Pages build downloads pinned copies of Kuromoji, JSZip, and the JMdict-Simplified English/Russian archives, then includes them in the published `site/` artifact. The browser loads these assets from the same site origin rather than from third-party CDNs or release URLs. On first launch, the app shows progress while preparing the analyzer and dictionary index. Dictionary archives are cached in IndexedDB where supported, so they usually do not need to be downloaded again on later launches.

JMdict-derived data is governed by the EDRDG license; the build includes a copy of the license alongside the dictionary archives. Kuromoji and JSZip license notices are included with their bundled files. Runtime assets are generated at deploy time and are not committed to the repository.

## Current scope

This is an early MVP. It is intentionally a static site; there is no backend, login system, or cloud sync yet. PWA support can be added in a later change.
