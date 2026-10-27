# 読みやすい — Japanese reading practice

A browser-based Japanese reading tool with bottom-to-top adjustable scrolling, EPUB/TXT/MD/HTML import, chapter navigation, bookmarks, saved per-book progress, furigana support, a JMdict-based dictionary panel, and a local book shelf.

## Live deployment

The GitHub Actions workflow in `.github/workflows/ci-cd.yml` validates the static app and deploys it to GitHub Pages when changes are pushed to `main` (or manually dispatched from `main`).

Expected URL: https://the-trvlr.github.io/yomiyasui/

## Project layout

- `site/index.html` — the single-file application.
- `scripts/check-html.mjs` — lightweight CI checks for HTML structure, duplicate IDs, and inline JavaScript syntax.
- `.github/workflows/ci-cd.yml` — validation and Pages deployment pipeline.

## Local development

Open `site/index.html` in a modern browser for a quick local smoke test. The Japanese morphological analyzer and dictionary archives are downloaded from external sources on first use, so those features require internet access until resources are cached.

For a local static server, from the repository root run:

```sh
python3 -m http.server 8000 --directory site
```

Then open http://localhost:8000.

Run CI checks locally:

```sh
node scripts/check-html.mjs site/index.html
```

## GitHub Pages

The workflow deploys the `site/` directory using GitHub Actions. In **Settings → Pages**, select **GitHub Actions** as the build and deployment source if it has not been selected automatically. Check the Actions tab for the deployment result.

## Privacy and storage

The site is static and does not currently have accounts, a backend, or cloud synchronization. Books, progress, bookmarks, and known-word data are stored in the browser on the user's device. They are not committed to Git. Storage is specific to the browser profile and site origin.

Do not add books, private reading logs, dictionary caches, credentials, or other personal data to this repository.

## Dictionary data and external dependencies

The app fetches Kuromoji resources and JMdict-Simplified archives at runtime. JMdict-derived data is governed by its applicable license; consult the notices in the app and upstream projects before redistributing dictionary data. Dictionary archives are not committed to this repository.

## Current scope

This is an early MVP. It is intentionally a static site; there is no backend, login system, or cloud sync yet. PWA support can be added in a later change.
