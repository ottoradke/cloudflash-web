# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a static landing page for **Cloudflash** — a single `index.html` file with no build system, package manager, or dependencies. It announces the platform's relaunch and collects collaboration inquiries via email.

## Deployment

Published on **Vercel** at **cloudflash.com**. No build configuration needed — Vercel auto-detects static sites and serves `index.html` directly. Push to the connected Git branch to deploy.

## Local Development

No build step required. Open `index.html` directly in a browser or serve it with any static file server, e.g.:

```bash
python -m http.server 8080
# or
npx serve .
```

The **Live Server** VS Code extension (by Ritwick Dey) also works — right-click `index.html` → Open with Live Server.

## Architecture

The entire application lives in `index.html` with three embedded sections:

- **`<style>`** — All CSS including keyframe animations (`fadeUp`, `blink`, `pulse`), responsive breakpoints (`@media (max-width: 500px)`), and a blue gradient theme (`#2179c8` → `#1a6bbf`)
- **`<body>`** — Three top-level sections:
  - `.page` — header with animated SVG logo + cursor, hero text
  - `.mesh-zone` — full-viewport-width canvas animation (40 nodes, 120px connection distance) with `.lower` overlay containing the info row (status/timeline/platforms/contact)
  - `footer` — copyright and contact email
- **`<script>`** — Two scripts: email decode + canvas mesh animation. Canvas is sized via `window.innerWidth` × `meshZone.offsetHeight` and reinitializes nodes on resize.

Typography is loaded from Google Fonts (Inter).

## Email Obfuscation

The contact email (`hello@cloudflash.com`) is **never written as plain text** in the HTML source. It is base64-encoded and injected at runtime via JavaScript to prevent scraper harvesting:

```js
const e = atob('aGVsbG9AY2xvdWRmbGFzaC5jb20=');
document.getElementById('contact-link').href = 'mailto:' + e;
document.getElementById('footer-email').textContent = e;
```

Do not add the email address as plain text anywhere in the HTML.
