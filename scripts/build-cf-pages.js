// Build script for Cloudflare Pages.
//
// Cloudflare Pages doesn't have a `.vercelignore` equivalent for direct
// uploads, so this script stages the production-only static assets into
// `dist/` and leaves /functions where it is (Pages reads functions from the
// project root automatically).
//
// Run via `npm run build` (Cloudflare Pages calls this automatically; locally
// it's chained from `npm run cf:deploy`).

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// Static files / dirs that ship to the browser. (Note: state-store.js and
// pdf-templates.js are server-only modules and stay at the project root —
// they're consumed by Pages Functions or the local Node server, not loaded in
// the browser, so they don't belong in dist/.)
const INCLUDE = [
  'index.html',
  'app.js',
  'config.js',
  'manifest.json',
  'presenter.js',
  'repository.js',
  'service-worker.js',
  'style.css',
  'ope-icon-192.png',
  'ope-icon-512.png',
  '_redirects',
  '_routes.json',
  '_headers'
];

function rmDist() {
  if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true, force: true });
}

function copyEntry(name) {
  const src = path.join(ROOT, name);
  const dest = path.join(DIST, name);
  if (!fs.existsSync(src)) {
    console.warn(`[cf:build] skip missing: ${name}`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.cpSync(src, dest, { recursive: true });
  } else {
    fs.copyFileSync(src, dest);
  }
}

rmDist();
fs.mkdirSync(DIST, { recursive: true });
INCLUDE.forEach(copyEntry);
console.log(`[cf:build] staged ${INCLUDE.length} entries to ${DIST}`);
