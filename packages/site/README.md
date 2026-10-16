# @flows/site — marketing site

Static, zero-dependency landing page for bridge. Designed to look like a rendered markdown file and to be trivially readable by agents/LLMs.

## Files

- `index.html` — the page. No JS, no build, system fonts, light/dark via `prefers-color-scheme`. Fully readable without CSS.
- `content.md` — the same content as raw markdown; linked from the page head (`<link rel="alternate" type="text/markdown">`).
- `llms.txt` — plain-text summary for agents/LLMs per the llms.txt convention, linked from the page head.

## Editing

Edit `content.md` and `index.html` in lockstep (content is duplicated by design — no build step, so the markdown must be kept in sync manually). Screenshots/diagrams go in the `.figure` placeholders in `index.html`; add assets under `assets/`.

## Deploy

Static assets — deploy as its own Cloudflare Pages project, or as a separate Worker with assets binding. The main worker serves the webapp at `/`, so the marketing site intentionally lives outside `packages/worker`. A common setup: `bridge.example.com` → this site, `app` or `panel` → the main worker. See `deploy.md` at repo root for the existing deploy flow.
