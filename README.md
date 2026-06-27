# PDF Text Editor

A browser-only PDF text editor built with Bun, Vite, React, PDF.js, and pdf-lib.

## Features

- Drag and drop or upload a PDF.
- Render PDF pages locally in the browser.
- Select visible text runs and replace their text.
- Preview replacements on the page.
- Download an edited PDF without a backend.
- Deploy as a static site on GitHub Pages.

## Local Development

```bash
bun install
bun run dev
```

## Build

```bash
bun run build
```

## GitHub Pages

The repository includes `.github/workflows/deploy.yml`.

1. Push the project to GitHub.
2. In the repository settings, set Pages source to GitHub Actions.
3. Push to `main` or run the workflow manually.

The Vite `base` path is derived from `GITHUB_REPOSITORY` during the workflow, so the app works at `https://OWNER.github.io/REPOSITORY/`.

## Editing Model

This first version edits text by placing a white mask over the selected text run and drawing the replacement text into the downloaded PDF. It works well for common simple PDFs, but it does not yet rewrite original PDF content streams, preserve original font/color exactly, or handle complex rotated/curved text. Later features can add richer annotations, images, free text, and deeper content editing.

Bundled Noto fonts are used for export. `public/fonts/OFL.txt` contains the font license.
