# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a static landing page for **Cloudflash** — a single `index.html` file with no build system, package manager, or dependencies. It announces the platform's relaunch and collects collaboration inquiries via email.

## Deployment

Published on **Vercel**. No build configuration needed — Vercel auto-detects static sites and serves `index.html` directly. Push to the connected Git branch to deploy.

## Local Development

No build step required. Open `index.html` directly in a browser or serve it with any static file server, e.g.:

```bash
python -m http.server 8080
# or
npx serve .
```

## Architecture

The entire application lives in `index.html` with three embedded sections:

- **`<style>`** — All CSS including keyframe animations (`fadeUp`, `blink`, `pulse`), responsive breakpoints (`@media (max-width: 500px)`), and a blue gradient theme (`#2179c8` → `#1560aa`)
- **`<body>`** — Static HTML: header with animated SVG cursor, hero section, info row (status/timeline/platforms/contact), footer
- **`<script>`** — Canvas-based animated mesh: 40 nodes moving across the viewport, connected by lines when within 120px of each other; resizes on `window.resize`

Typography is loaded from Google Fonts (Inter).
