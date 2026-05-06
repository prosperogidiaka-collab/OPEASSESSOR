require('dotenv').config();

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { pathToFileURL } = require('url');

const { VALID_STATE_KEYS, createStateStore } = require('./state-store');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8000);
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : ROOT;
const DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(DATA_DIR, 'ope-shared-state.json');
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 100 * 1024 * 1024);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const STORAGE_BACKEND = (process.env.STORAGE_BACKEND || 'file').trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const SUPABASE_TABLE_PREFIX = (process.env.SUPABASE_TABLE_PREFIX || 'ope_').trim();
const PDF_BROWSER_PATH = (process.env.PDF_BROWSER_PATH || '').trim();
const PDF_EXPORT_TIMEOUT_MS = Number(process.env.PDF_EXPORT_TIMEOUT_MS || 45000);
const PDF_EXPORT_TEMP_DIR = path.join(ROOT, '.pdf-export-cache');

const stateStore = createStateStore({
  storageBackend: STORAGE_BACKEND,
  dataFile: DATA_FILE,
  supabaseUrl: SUPABASE_URL,
  supabaseServiceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
  supabaseTablePrefix: SUPABASE_TABLE_PREFIX
});

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

function getLocalAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(Boolean)
    .filter((address) => address.family === 'IPv4' && !address.internal)
    .map((address) => address.address);
}

function getCorsOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return '';
  if (ALLOWED_ORIGINS.includes('*')) return '*';
  return ALLOWED_ORIGINS.includes(origin) ? origin : '';
}

function buildResponseHeaders(req, type, extraHeaders = {}) {
  const headers = {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  };
  const corsOrigin = getCorsOrigin(req);
  if (corsOrigin) {
    headers['Access-Control-Allow-Origin'] = corsOrigin;
    headers['Access-Control-Allow-Methods'] = 'GET, PUT, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers['Vary'] = headers['Vary'] ? `${headers['Vary']}, Origin` : 'Origin';
  }
  return headers;
}

function send(req, res, status, body, type = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, buildResponseHeaders(req, type, extraHeaders));
  res.end(body);
}

function sendJson(req, res, status, payload, extraHeaders = {}) {
  send(req, res, status, JSON.stringify(payload), 'application/json; charset=utf-8', extraHeaders);
}

function resolveRequestPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const cleanPath = decoded === '/' ? '/index.html' : decoded;
  const filePath = path.resolve(ROOT, '.' + cleanPath);
  if (!filePath.startsWith(ROOT)) return null;
  return filePath;
}

function escapeHtmlAttr(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getRequestBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const forwardedProto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = (req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const protocol = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
  const host = forwardedHost || req.headers.host || `localhost:${PORT}`;
  return `${protocol}://${host}`;
}

function buildShareMeta(req) {
  const currentUrl = new URL(req.url || '/', getRequestBaseUrl(req));
  const hasQuizLink = currentUrl.searchParams.has('q');
  const title = hasQuizLink ? 'Join Quiz on OPE Assessor' : 'OPE Assessor';
  const description = hasQuizLink
    ? 'Open this secure OPE Assessor quiz link to start the assessment.'
    : 'Zero-Friction Assessment Portal with secure quiz sharing, student results, and teacher dashboards.';
  const imageUrl = new URL('/summary-preview.png', getRequestBaseUrl(req)).toString();
  return {
    title,
    description,
    url: currentUrl.toString(),
    imageUrl
  };
}

function decorateHtmlForSharing(req, htmlBuffer) {
  const shareMeta = buildShareMeta(req);
  let html = Buffer.isBuffer(htmlBuffer) ? htmlBuffer.toString('utf8') : String(htmlBuffer || '');
  html = html
    .replace(/<meta property="og:title" content="[^"]*">/i, `<meta property="og:title" content="${escapeHtmlAttr(shareMeta.title)}">`)
    .replace(/<meta property="og:description" content="[^"]*">/i, `<meta property="og:description" content="${escapeHtmlAttr(shareMeta.description)}">`)
    .replace(/<meta property="og:image" content="[^"]*">/i, `<meta property="og:image" content="${escapeHtmlAttr(shareMeta.imageUrl)}">`)
    .replace(/<meta name="twitter:title" content="[^"]*">/i, `<meta name="twitter:title" content="${escapeHtmlAttr(shareMeta.title)}">`)
    .replace(/<meta name="twitter:description" content="[^"]*">/i, `<meta name="twitter:description" content="${escapeHtmlAttr(shareMeta.description)}">`)
    .replace(/<meta name="twitter:image" content="[^"]*">/i, `<meta name="twitter:image" content="${escapeHtmlAttr(shareMeta.imageUrl)}">`);
  if (!/<meta property="og:url"/i.test(html)) {
    html = html.replace('</head>', `    <meta property="og:url" content="${escapeHtmlAttr(shareMeta.url)}">\n    <link rel="canonical" href="${escapeHtmlAttr(shareMeta.url)}">\n</head>`);
  }
  return Buffer.from(html, 'utf8');
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (Buffer.byteLength(data) > MAX_BODY_BYTES) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function normalizeClientIp(value = '') {
  const raw = (value || '').toString().trim();
  if (!raw) return '';
  if (raw === '::1') return '127.0.0.1';
  if (raw.startsWith('::ffff:')) return raw.slice(7);
  return raw;
}

function getClientIp(req) {
  const forwarded = (req.headers['x-forwarded-for'] || '').toString().split(',').map((part) => normalizeClientIp(part)).filter(Boolean);
  if (forwarded.length) return forwarded[0];
  return normalizeClientIp(
    req.headers['x-real-ip']
      || req.socket?.remoteAddress
      || req.connection?.remoteAddress
      || ''
  );
}

function getPdfBrowserCandidates() {
  return [
    PDF_BROWSER_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ].filter(Boolean);
}

function findPdfBrowserPath() {
  const resolved = getPdfBrowserCandidates().find((candidate) => {
    try {
      return candidate && fs.existsSync(candidate);
    } catch (error) {
      return false;
    }
  });
  if (!resolved) {
    throw new Error('No Chromium-based browser was found for PDF export. Set PDF_BROWSER_PATH in the server environment.');
  }
  return resolved;
}

function sanitizePdfFilename(value = '') {
  const cleaned = (value || 'ope-export.pdf').toString().trim().replace(/[\\/:*?"<>|]+/g, '-');
  return cleaned.toLowerCase().endsWith('.pdf') ? cleaned : `${cleaned || 'ope-export'}.pdf`;
}

function buildPdfDocumentHtml(html, options = {}) {
  const title = escapeHtmlAttr(options.title || 'OPE Assessor PDF Export');
  const orientation = (options.orientation || 'portrait').toString().trim().toLowerCase() === 'landscape' ? 'landscape' : 'portrait';
  const margins = options.margins && typeof options.margins === 'object' ? options.margins : {};
  const top = Number(margins.top) >= 0 ? Number(margins.top) : 10;
  const right = Number(margins.right) >= 0 ? Number(margins.right) : 10;
  const bottom = Number(margins.bottom) >= 0 ? Number(margins.bottom) : 10;
  const left = Number(margins.left) >= 0 ? Number(margins.left) : 10;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    html, body { margin: 0; padding: 0; background: #ffffff; color: #0B1220; font-family: "Segoe UI", Arial, sans-serif; }
    body { width: 100%; overflow: visible; }
    #pdf-container {
      width: 794px;
      min-height: 1123px;
      background: white;
      overflow: visible;
      margin: 0 auto;
    }
    img, svg, canvas { max-width: 100%; }
    .pdf-card, .avoid-break, .pdf-question-card, .pdf-summary-card, .pdf-meta-card, .facility-question-card, .facility-summary-card, .summary-row {
      break-inside: avoid;
      page-break-inside: avoid;
    }
    @page {
      size: A4 ${orientation};
      margin: ${top}mm ${right}mm ${bottom}mm ${left}mm;
    }
    @media print {
      body { background: white; }
      #pdf-container {
        width: 210mm;
        min-height: 297mm;
        overflow: visible;
        page-break-inside: auto;
      }
      .pdf-card, .avoid-break, .pdf-question-card, .pdf-summary-card, .pdf-meta-card, .facility-question-card, .facility-summary-card, .summary-row {
        break-inside: avoid;
        page-break-inside: avoid;
      }
    }
  </style>
</head>
<body>
  <div id="pdf-container">${html || ''}</div>
</body>
</html>`;
}

function renderPdfWithHeadlessBrowser(html, options = {}) {
  const browserPath = findPdfBrowserPath();
  fs.mkdirSync(PDF_EXPORT_TEMP_DIR, { recursive: true });
  const jobId = randomUUID();
  const jobDir = path.join(PDF_EXPORT_TEMP_DIR, jobId);
  const sourcePath = path.join(jobDir, 'source.html');
  const pdfPath = path.join(jobDir, 'export.pdf');
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(sourcePath, buildPdfDocumentHtml(html, options), 'utf8');

  return new Promise((resolve, reject) => {
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--allow-file-access-from-files',
      '--run-all-compositor-stages-before-draw',
      '--virtual-time-budget=12000',
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      pathToFileURL(sourcePath).toString()
    ];
    const child = spawn(browserPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    let finished = false;
    const finalize = (callback) => {
      if (finished) return;
      finished = true;
      try { callback(); }
      finally {
        try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (error) {}
      }
    };
    const timeout = setTimeout(() => {
      try { child.kill(); } catch (error) {}
      finalize(() => reject(new Error('PDF export timed out while rendering the page.')));
    }, Math.max(10000, PDF_EXPORT_TIMEOUT_MS));

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timeout);
      finalize(() => reject(error));
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        finalize(() => reject(new Error(stderr || stdout || `PDF export failed with exit code ${code}`)));
        return;
      }
      try {
        const buffer = fs.readFileSync(pdfPath);
        finalize(() => resolve(buffer));
      } catch (error) {
        finalize(() => reject(new Error(`PDF export completed but the PDF file could not be read. ${error.message}`)));
      }
    });
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname;

  if (req.method === 'OPTIONS') {
    return send(req, res, 204, '', 'text/plain; charset=utf-8');
  }

  if (route === '/api/health' && req.method === 'GET') {
    return sendJson(req, res, 200, {
      ok: true,
      host: HOST,
      port: PORT,
      addresses: getLocalAddresses(),
      publicBaseUrl: PUBLIC_BASE_URL || null,
      storageBackend: stateStore.backend,
      storageDetails: stateStore.details,
      maxBodyBytes: MAX_BODY_BYTES,
      allowedOrigins: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : ['same-origin only']
    });
  }

  if (route === '/api/client-context' && req.method === 'GET') {
    return sendJson(req, res, 200, {
      ipAddress: getClientIp(req),
      userAgent: (req.headers['user-agent'] || '').toString(),
      requestedAt: new Date().toISOString()
    });
  }

  if (route === '/api/state' && req.method === 'GET') {
    try {
      return sendJson(req, res, 200, await stateStore.getState());
    } catch (error) {
      return sendJson(req, res, 500, { error: error.message || 'Failed to load shared state' });
    }
  }

  if (route.startsWith('/api/state/')) {
    const stateKey = decodeURIComponent(route.replace('/api/state/', ''));
    if (!VALID_STATE_KEYS.includes(stateKey)) {
      return sendJson(req, res, 404, { error: 'Unknown state key' });
    }

    if (req.method === 'GET') {
      try {
        const value = await stateStore.getStateValue(stateKey);
        return sendJson(req, res, 200, { key: stateKey, value });
      } catch (error) {
        return sendJson(req, res, 500, { error: error.message || 'Failed to load shared state value' });
      }
    }

    if (req.method === 'PUT') {
      try {
        const body = await readRequestBody(req);
        const parsed = JSON.parse(body || '{}');
        if (!Object.prototype.hasOwnProperty.call(parsed, 'value')) {
          return sendJson(req, res, 400, { error: 'Missing value' });
        }
        await stateStore.putStateValue(stateKey, parsed.value);
        return sendJson(req, res, 200, { ok: true, key: stateKey, backend: stateStore.backend });
      } catch (error) {
        const message = error.message || 'Invalid request body';
        const isBodyError = message === 'Missing value' || message === 'Payload too large' || /JSON/i.test(message);
        return sendJson(req, res, isBodyError ? 400 : 500, { error: message });
      }
    }
  }

  if (route === '/api/export/pdf' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      const parsed = JSON.parse(body || '{}');
      const html = typeof parsed.html === 'string' ? parsed.html : '';
      if (!html.trim()) return sendJson(req, res, 400, { error: 'Missing html' });
      const filename = sanitizePdfFilename(parsed.filename || 'ope-export.pdf');
      const pdfBuffer = await renderPdfWithHeadlessBrowser(html, parsed.options || {});
      return send(req, res, 200, pdfBuffer, 'application/pdf', {
        'Content-Disposition': `${parsed.inline ? 'inline' : 'attachment'}; filename="${escapeHtmlAttr(filename)}"`
      });
    } catch (error) {
      const message = error.message || 'Unable to generate PDF';
      const isBodyError = message === 'Missing html' || message === 'Payload too large' || /JSON/i.test(message);
      return sendJson(req, res, isBodyError ? 400 : 500, { error: message });
    }
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  if ((req.url || '').startsWith('/api/')) {
    const handled = await handleApi(req, res);
    if (handled !== false) return;
    return sendJson(req, res, 404, { error: 'Not found' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(req, res, 405, 'Method not allowed');
  }

  const filePath = resolveRequestPath(req.url || '/');
  if (!filePath) return send(req, res, 403, 'Forbidden');

  fs.readFile(filePath, (err, data) => {
    if (err) {
      const fallback = path.join(ROOT, 'index.html');
      return fs.readFile(fallback, (fallbackErr, fallbackData) => {
        if (fallbackErr) return send(req, res, 404, 'Not found');
        const html = decorateHtmlForSharing(req, fallbackData);
        send(req, res, 200, req.method === 'HEAD' ? '' : html, TYPES['.html']);
      });
    }

    const type = TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const body = type.startsWith('text/html') ? decorateHtmlForSharing(req, data) : data;
    send(req, res, 200, req.method === 'HEAD' ? '' : body, type);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`OPE Assessor server is running at http://localhost:${PORT}`);
  console.log(`Storage backend: ${stateStore.backend}`);
  if (stateStore.backend === 'file') {
    console.log(`Shared quiz data file: ${DATA_FILE}`);
  } else {
    console.log(`Supabase URL: ${SUPABASE_URL}`);
    console.log(`Supabase table prefix: ${SUPABASE_TABLE_PREFIX}`);
  }
  if (PUBLIC_BASE_URL) {
    console.log(`Public base URL: ${PUBLIC_BASE_URL}`);
  }
  console.log(`Allowed CORS origins: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(', ') : 'same-origin only'}`);
  getLocalAddresses().forEach((address) => {
    console.log(`Open from another device on this Wi-Fi: http://${address}:${PORT}`);
  });
});
