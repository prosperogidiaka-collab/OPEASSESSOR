require('dotenv').config();

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { pathToFileURL } = require('url');
const puppeteer = require('puppeteer-core');
const qrcodeGenerator = require('qrcode-generator');

const { VALID_STATE_KEYS, createStateStore } = require('./state-store');
const { buildDedicatedPdfRouteDocument, isDedicatedPdfRouteType } = require('./pdf-templates');

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
const ALLOWED_ORIGINS = ((process.env.ALLOWED_ORIGINS || '').trim()
  ? (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
  : ['*']);
const STORAGE_BACKEND = (process.env.STORAGE_BACKEND || 'file').trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const SUPABASE_TABLE_PREFIX = (process.env.SUPABASE_TABLE_PREFIX || 'ope_').trim();
const PDF_BROWSER_PATH = (process.env.PDF_BROWSER_PATH || '').trim();
const PDF_EXPORT_TIMEOUT_MS = Number(process.env.PDF_EXPORT_TIMEOUT_MS || 45000);
const PDF_EXPORT_TEMP_DIR = path.join(ROOT, '.pdf-export-cache');
const PDF_DEBUG_CAPTURE = ['1', 'true', 'yes'].includes((process.env.PDF_DEBUG_CAPTURE || '').toString().trim().toLowerCase());

let sharedPdfBrowserPromise = null;

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

function injectOrReplaceMetaTag(html = '', matcher, tagMarkup) {
  if (matcher.test(html)) return html.replace(matcher, tagMarkup);
  return html.replace('</head>', `    ${tagMarkup}\n</head>`);
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
  const hasResultLink = currentUrl.searchParams.has('r');
  const wantsCorrection = ['1', 'true', 'yes'].includes((currentUrl.searchParams.get('c') || currentUrl.searchParams.get('downloadCorrection') || '').toLowerCase());
  let title = 'OPE Assessor';
  let description = 'Teacher dashboards, secure quiz links, verified student results, and correction-ready assessment sharing.';
  if (hasQuizLink) {
    title = 'Join Quiz on OPE Assessor';
    description = 'Open this secure OPE Assessor quiz link to start the assessment from any device.';
  } else if (hasResultLink && wantsCorrection) {
    title = 'Student Correction on OPE Assessor';
    description = 'Open this secure OPE Assessor link to review the student correction sheet and answer-by-answer feedback.';
  } else if (hasResultLink) {
    title = 'Verified Student Result on OPE Assessor';
    description = 'Open this secure OPE Assessor result link to view the verified score summary and certificate details.';
  }
  const imageUrl = new URL('/summary-preview.png', getRequestBaseUrl(req)).toString();
  return {
    title,
    description,
    url: currentUrl.toString(),
    imageUrl,
    imageAlt: 'OPE Assessor dashboard preview with logo, analytics cards, quiz overview, and result verification highlights.'
  };
}

function decorateHtmlForSharing(req, htmlBuffer) {
  const shareMeta = buildShareMeta(req);
  let html = Buffer.isBuffer(htmlBuffer) ? htmlBuffer.toString('utf8') : String(htmlBuffer || '');
  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtmlAttr(shareMeta.title)}</title>`);
  html = injectOrReplaceMetaTag(html, /<meta name="description" content="[^"]*">/i, `<meta name="description" content="${escapeHtmlAttr(shareMeta.description)}">`);
  html = injectOrReplaceMetaTag(html, /<meta property="og:title" content="[^"]*">/i, `<meta property="og:title" content="${escapeHtmlAttr(shareMeta.title)}">`);
  html = injectOrReplaceMetaTag(html, /<meta property="og:description" content="[^"]*">/i, `<meta property="og:description" content="${escapeHtmlAttr(shareMeta.description)}">`);
  html = injectOrReplaceMetaTag(html, /<meta property="og:image" content="[^"]*">/i, `<meta property="og:image" content="${escapeHtmlAttr(shareMeta.imageUrl)}">`);
  html = injectOrReplaceMetaTag(html, /<meta property="og:image:alt" content="[^"]*">/i, `<meta property="og:image:alt" content="${escapeHtmlAttr(shareMeta.imageAlt)}">`);
  html = injectOrReplaceMetaTag(html, /<meta property="og:url" content="[^"]*">/i, `<meta property="og:url" content="${escapeHtmlAttr(shareMeta.url)}">`);
  html = injectOrReplaceMetaTag(html, /<link rel="canonical" href="[^"]*">/i, `<link rel="canonical" href="${escapeHtmlAttr(shareMeta.url)}">`);
  html = injectOrReplaceMetaTag(html, /<meta name="twitter:title" content="[^"]*">/i, `<meta name="twitter:title" content="${escapeHtmlAttr(shareMeta.title)}">`);
  html = injectOrReplaceMetaTag(html, /<meta name="twitter:description" content="[^"]*">/i, `<meta name="twitter:description" content="${escapeHtmlAttr(shareMeta.description)}">`);
  html = injectOrReplaceMetaTag(html, /<meta name="twitter:image" content="[^"]*">/i, `<meta name="twitter:image" content="${escapeHtmlAttr(shareMeta.imageUrl)}">`);
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

function normalizeEmail(value = '') {
  return (value || '').toString().trim().toLowerCase();
}

function parsePdfRoutePath(pathname = '') {
  const parts = (pathname || '').split('/').filter(Boolean);
  if (parts[0] !== 'pdf' || parts.length < 3) return null;
  return {
    type: parts[1],
    recordId: decodeURIComponent(parts.slice(2).join('/'))
  };
}

function serializeInlineScriptData(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function buildAbsoluteAssetUrl(baseUrl = '', assetPath = '') {
  const base = (baseUrl || '').toString().trim().replace(/\/+$/, '');
  const normalizedPath = assetPath.startsWith('/') ? assetPath : `/${assetPath}`;
  return base ? `${base}${normalizedPath}` : normalizedPath;
}

function injectPdfBootstrap(htmlBuffer, payload) {
  const scriptTag = `<script>window.__OPE_PDF_BOOTSTRAP__=${serializeInlineScriptData(payload)};</script>`;
  let html = Buffer.isBuffer(htmlBuffer) ? htmlBuffer.toString('utf8') : String(htmlBuffer || '');
  if (/<\/head>/i.test(html)) {
    html = html.replace(/<\/head>/i, `${scriptTag}\n</head>`);
  } else {
    html = `${scriptTag}${html}`;
  }
  return Buffer.from(html, 'utf8');
}

function buildVerificationQrSvg(value = '') {
  try {
    if (!value) return '';
    const qr = qrcodeGenerator(0, 'M');
    qr.addData(value);
    qr.make();
    return qr.createSvgTag(3, 0);
  } catch (error) {
    return '';
  }
}

function buildPdfRouteDocument(payload = {}, options = {}) {
  const title = escapeHtmlAttr(payload.title || 'OPE Assessor PDF Export');
  const baseUrl = (options.baseUrl || '').toString().trim().replace(/\/+$/, '');
  const styleHref = buildAbsoluteAssetUrl(baseUrl, '/style.css');
  const configHref = buildAbsoluteAssetUrl(baseUrl, '/config.js');
  const repositoryHref = buildAbsoluteAssetUrl(baseUrl, '/repository.js');
  const presenterHref = buildAbsoluteAssetUrl(baseUrl, '/presenter.js');
  const appHref = buildAbsoluteAssetUrl(baseUrl, '/app.js');
  return Buffer.from(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex,nofollow">
  <title>${title}</title>
  ${baseUrl ? `<base href="${escapeHtmlAttr(`${baseUrl}/`)}">` : ''}
  <link rel="stylesheet" href="${escapeHtmlAttr(styleHref)}">
  <script>window.__OPE_PDF_READY__=false;window.__OPE_PDF_BOOTSTRAP__=${serializeInlineScriptData(payload)};</script>
</head>
<body class="pdf-route-active">
  <div id="app"></div>
  <script src="${escapeHtmlAttr(configHref)}"></script>
  <script src="${escapeHtmlAttr(repositoryHref)}"></script>
  <script src="${escapeHtmlAttr(presenterHref)}"></script>
  <script src="${escapeHtmlAttr(appHref)}"></script>
  <script>
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        if (typeof initializeApp === 'function') initializeApp();
      });
    } else if (typeof initializeApp === 'function') {
      initializeApp();
    }
  </script>
</body>
</html>`, 'utf8');
}

async function buildDedicatedPdfRouteResponse(req) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parsedRoute = parsePdfRoutePath(requestUrl.pathname);
  if (!parsedRoute || !isDedicatedPdfRouteType(parsedRoute.type)) return null;

  const quizzes = await stateStore.getStateValue('quizzes');
  const submissions = await stateStore.getStateValue('submissions');
  const verificationBaseUrl = getVerificationBaseUrl(req);

  if (parsedRoute.type === 'result-summary') {
    const target = (submissions || []).find((item) => ((item.shareKey || '').toString().trim().toLowerCase()) === parsedRoute.recordId.toLowerCase());
    if (!target) {
      const error = new Error('Result summary not found');
      error.statusCode = 404;
      throw error;
    }
    const quiz = quizzes && quizzes[target.quizId];
    if (!quiz) {
      const error = new Error('Quiz record not found for this result');
      error.statusCode = 404;
      throw error;
    }
    const shareUrl = `${verificationBaseUrl}?r=${encodeURIComponent(target.shareKey || parsedRoute.recordId)}`;
    return Buffer.from(buildDedicatedPdfRouteDocument({
      type: 'result-summary',
      title: 'Student Result Summary PDF',
      quiz,
      submission: target,
      rankValue: computeSubmissionRank(submissions, target),
      verificationQrSvg: buildVerificationQrSvg(shareUrl)
    }), 'utf8');
  }

  if (parsedRoute.type === 'student-correction') {
    const target = (submissions || []).find((item) => ((item.shareKey || '').toString().trim().toLowerCase()) === parsedRoute.recordId.toLowerCase());
    if (!target) {
      const error = new Error('Student correction record not found');
      error.statusCode = 404;
      throw error;
    }
    const quiz = quizzes && quizzes[target.quizId];
    if (!quiz) {
      const error = new Error('Quiz record not found for this correction');
      error.statusCode = 404;
      throw error;
    }
    return Buffer.from(buildDedicatedPdfRouteDocument({
      type: 'student-correction',
      title: 'Student Correction PDF',
      quiz,
      submission: target,
      subjectName: (requestUrl.searchParams.get('subject') || '').trim(),
      showNegativePenalty: true
    }), 'utf8');
  }

  if (parsedRoute.type === 'facility-index') {
    const quiz = quizzes && quizzes[parsedRoute.recordId];
    if (!quiz) {
      const error = new Error('Quiz record not found for facility index export');
      error.statusCode = 404;
      throw error;
    }
    return Buffer.from(buildDedicatedPdfRouteDocument({
      type: 'facility-index',
      title: 'Facility Index PDF',
      quiz,
      submissions: (submissions || []).filter((item) => item && item.quizId === quiz.id),
      subjectName: (requestUrl.searchParams.get('subject') || '').trim()
    }), 'utf8');
  }

  return null;
}

function computeSubmissionRank(submissions = [], targetSubmission = {}) {
  const submissionId = (targetSubmission.submissionId || '').toString().trim();
  const ordered = (submissions || [])
    .filter((item) => item && item.quizId === targetSubmission.quizId)
    .slice()
    .sort((left, right) => (Number(right.percent) || 0) - (Number(left.percent) || 0) || (Number(left.timeSpent) || 0) - (Number(right.timeSpent) || 0));
  const byIdIndex = ordered.findIndex((item) => (item.submissionId || '') === submissionId);
  if (byIdIndex >= 0) return String(byIdIndex + 1);
  const email = normalizeEmail(targetSubmission.email);
  if (!email) return '-';
  const byEmailIndex = ordered.findIndex((item) => normalizeEmail(item.email) === email);
  return byEmailIndex >= 0 ? String(byEmailIndex + 1) : '-';
}

function getVerificationBaseUrl(req) {
  return new URL('/', getRequestBaseUrl(req)).toString();
}

async function buildPdfBootstrapPayload(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parsedRoute = parsePdfRoutePath(url.pathname);
  if (!parsedRoute) return null;

  const quizzes = await stateStore.getStateValue('quizzes');
  const submissions = await stateStore.getStateValue('submissions');
  const pagePortrait = { orientation: 'portrait', rootWidthMm: 190, marginsMm: { top: 12, right: 10, bottom: 12, left: 10 } };
  const verificationBaseUrl = getVerificationBaseUrl(req);

  if (parsedRoute.type === 'result-summary') {
    const target = (submissions || []).find((item) => ((item.shareKey || '').toString().trim().toLowerCase()) === parsedRoute.recordId.toLowerCase());
    if (!target) {
      const error = new Error('Result summary not found');
      error.statusCode = 404;
      throw error;
    }
    const quiz = quizzes && quizzes[target.quizId];
    if (!quiz) {
      const error = new Error('Quiz record not found for this result');
      error.statusCode = 404;
      throw error;
    }
    const shareUrl = `${verificationBaseUrl}?r=${encodeURIComponent(target.shareKey || parsedRoute.recordId)}`;
    return {
      type: 'result-summary',
      title: 'Student Result Summary PDF',
      quiz,
      submission: target,
      rankValue: computeSubmissionRank(submissions, target),
      verificationBaseUrl,
      verificationQrSvg: buildVerificationQrSvg(shareUrl),
      page: pagePortrait
    };
  }

  if (parsedRoute.type === 'student-correction') {
    const target = (submissions || []).find((item) => ((item.shareKey || '').toString().trim().toLowerCase()) === parsedRoute.recordId.toLowerCase());
    if (!target) {
      const error = new Error('Student correction record not found');
      error.statusCode = 404;
      throw error;
    }
    const quiz = quizzes && quizzes[target.quizId];
    if (!quiz) {
      const error = new Error('Quiz record not found for this correction');
      error.statusCode = 404;
      throw error;
    }
    return {
      type: 'student-correction',
      title: 'Student Correction PDF',
      quiz,
      submission: target,
      subjectName: (url.searchParams.get('subject') || '').trim(),
      showNegativePenalty: true,
      verificationBaseUrl,
      page: pagePortrait
    };
  }

  if (parsedRoute.type === 'facility-index') {
    const quiz = quizzes && quizzes[parsedRoute.recordId];
    if (!quiz) {
      const error = new Error('Quiz record not found for facility index export');
      error.statusCode = 404;
      throw error;
    }
    return {
      type: 'facility-index',
      title: 'Facility Index PDF',
      quiz,
      submissions: (submissions || []).filter((item) => item && item.quizId === quiz.id),
      subjectName: (url.searchParams.get('subject') || '').trim(),
      verificationBaseUrl,
      page: pagePortrait
    };
  }

  if (parsedRoute.type === 'teacher-summary') {
    const quiz = quizzes && quizzes[parsedRoute.recordId];
    if (!quiz) {
      const error = new Error('Quiz record not found for teacher summary export');
      error.statusCode = 404;
      throw error;
    }
    const format = (url.searchParams.get('format') || '').trim();
    const subjectCount = Array.isArray(quiz.subjects) ? quiz.subjects.length : 0;
    const useLandscape = format === 'separate' && subjectCount > 4;
    return {
      type: 'teacher-summary',
      title: 'Teacher Result Summary PDF',
      quiz,
      submissions: (submissions || []).filter((item) => item && item.quizId === quiz.id),
      format,
      verificationBaseUrl,
      page: {
        orientation: useLandscape ? 'landscape' : 'portrait',
        rootWidthMm: useLandscape ? 277 : 190,
        marginsMm: { top: 12, right: 10, bottom: 12, left: 10 }
      }
    };
  }

  return null;
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
    @page {
      size: A4 ${orientation};
      margin: ${top}mm ${right}mm ${bottom}mm ${left}mm;
    }
    html, body {
      margin: 0;
      padding: 0;
      background: #ffffff;
      width: ${orientation === 'landscape' ? 297 : 210}mm;
      min-height: ${orientation === 'landscape' ? 210 : 297}mm;
      font-family: "Noto Sans", "DejaVu Sans", Arial, sans-serif;
      color: #111827;
      overflow: visible;
    }
    #pdf-root {
      width: ${orientation === 'landscape' ? 277 : 190}mm;
      min-height: 297mm;
      margin: 0 auto;
      background: white;
      color: #111827;
      overflow: visible;
    }
    img, svg, canvas { max-width: 100%; }
    .pdf-card, .avoid-break, .pdf-question-card, .pdf-summary-card, .pdf-meta-card, .facility-question-card, .facility-summary-card, .summary-row {
      break-inside: avoid;
      page-break-inside: avoid;
      overflow: visible;
    }
    .long-card {
      break-inside: auto;
      page-break-inside: auto;
    }
  </style>
</head>
<body>
  <div id="pdf-root">${html || ''}</div>
  <script>window.__OPE_PDF_READY__ = true;</script>
</body>
</html>`;
}

function normalizePdfMargins(options = {}) {
  const margins = options.margins && typeof options.margins === 'object' ? options.margins : {};
  return {
    top: Number(margins.top) >= 0 ? Number(margins.top) : 12,
    right: Number(margins.right) >= 0 ? Number(margins.right) : 10,
    bottom: Number(margins.bottom) >= 0 ? Number(margins.bottom) : 12,
    left: Number(margins.left) >= 0 ? Number(margins.left) : 10
  };
}

function buildInternalPdfUrl(routePath = '') {
  const target = (routePath || '').toString().trim();
  if (!target.startsWith('/pdf/')) {
    throw new Error('PDF export requires a dedicated /pdf/... route path.');
  }
  return `http://127.0.0.1:${PORT}${target}`;
}

async function getSharedPdfBrowser(browserPath) {
  if (!sharedPdfBrowserPromise) {
    sharedPdfBrowserPromise = puppeteer.launch({
      headless: 'new',
      executablePath: browserPath,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }).then((browser) => {
      browser.on('disconnected', () => {
        if (sharedPdfBrowserPromise) sharedPdfBrowserPromise = null;
      });
      return browser;
    }).catch((error) => {
      sharedPdfBrowserPromise = null;
      throw error;
    });
  }
  return sharedPdfBrowserPromise;
}

function renderPdfWithBrowserFallback({ html = '', routePath = '', bootstrap = null, baseUrl = '', options = {}, browserPath, jobDir }) {
  const pdfPath = path.join(jobDir, 'export.pdf');
  let sourceTarget = '';

  if (routePath) {
    sourceTarget = buildInternalPdfUrl(routePath);
  } else if (bootstrap && typeof bootstrap === 'object') {
    const sourcePath = path.join(jobDir, 'source.html');
    fs.writeFileSync(sourcePath, buildPdfRouteDocument(bootstrap, { baseUrl }), 'utf8');
    sourceTarget = pathToFileURL(sourcePath).toString();
  } else {
    const sourcePath = path.join(jobDir, 'source.html');
    fs.writeFileSync(sourcePath, buildPdfDocumentHtml(html, options), 'utf8');
    sourceTarget = pathToFileURL(sourcePath).toString();
  }

  return new Promise((resolve, reject) => {
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--allow-file-access-from-files',
      '--run-all-compositor-stages-before-draw',
      '--virtual-time-budget=20000',
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      sourceTarget
    ];
    const child = spawn(browserPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    const timeout = setTimeout(() => {
      try { child.kill(); } catch (error) {}
      reject(new Error('PDF export timed out while rendering the page.'));
    }, Math.max(20000, PDF_EXPORT_TIMEOUT_MS));

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr || stdout || `PDF export failed with exit code ${code}`));
        return;
      }
      try {
        resolve(fs.readFileSync(pdfPath));
      } catch (error) {
        reject(new Error(`PDF export completed but the PDF file could not be read. ${error.message}`));
      }
    });
  });
}

async function renderPdfWithHeadlessBrowser({ html = '', routePath = '', bootstrap = null, baseUrl = '', options = {} } = {}) {
  const browserPath = findPdfBrowserPath();
  const margins = normalizePdfMargins(options);
  fs.mkdirSync(PDF_EXPORT_TEMP_DIR, { recursive: true });
  const jobId = randomUUID();
  const jobDir = path.join(PDF_EXPORT_TEMP_DIR, jobId);
  const debugScreenshotPath = path.join(jobDir, 'debug-pdf-output.png');
  const projectDebugScreenshotPath = path.join(ROOT, 'debug-pdf-output.png');
  fs.mkdirSync(jobDir, { recursive: true });
  let browser = null;
  let page = null;

  try {
    browser = await getSharedPdfBrowser(browserPath);
    page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 2200, deviceScaleFactor: 1 });
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);
    const usesPdfRoute = !!routePath;
    const usesPdfAppRenderer = !usesPdfRoute && !!(bootstrap && typeof bootstrap === 'object');

    if (routePath) {
      const pdfUrl = buildInternalPdfUrl(routePath);
      const response = await page.goto(pdfUrl, {
        waitUntil: ['domcontentloaded', 'networkidle0'],
        timeout: 60000
      });
      if (!response || !response.ok()) {
        throw new Error(`PDF route failed to load: ${pdfUrl}`);
      }
    } else if (bootstrap && typeof bootstrap === 'object') {
      await page.setContent(buildPdfRouteDocument(bootstrap, { baseUrl }).toString('utf8'), {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
    } else {
      await page.setContent(buildPdfDocumentHtml(html, options), {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
    }

    await page.emulateMediaType('screen');
    await page.evaluateHandle('document.fonts ? document.fonts.ready : Promise.resolve()');
    await page.waitForSelector('#pdf-root', {
      visible: true,
      timeout: usesPdfAppRenderer ? 30000 : 5000
    });
    if (usesPdfAppRenderer) {
      await page.waitForFunction(() => window.__OPE_PDF_READY__ !== false, {
        timeout: 15000
      });
    }
    await page.waitForFunction(() => {
      const root = document.querySelector('#pdf-root');
      return root && root.innerText.trim().length > 100;
    }, {
      timeout: usesPdfRoute || usesPdfAppRenderer ? 15000 : 5000
    });
    await page.waitForFunction(() => {
      const images = Array.from(document.images || []);
      return images.every((img) => img.complete && img.naturalWidth > 0);
    }, {
      timeout: 10000
    }).catch(() => {});
    await page.screenshot({
      path: debugScreenshotPath,
      fullPage: true
    });
    try {
      fs.copyFileSync(debugScreenshotPath, projectDebugScreenshotPath);
    } catch (error) {}

    const rootState = await page.$eval('#pdf-root', (element) => {
      const rect = element.getBoundingClientRect();
      return {
        text: element.innerText.trim(),
        width: rect.width,
        height: rect.height
      };
    });
    if (!rootState.text || rootState.text.length < 100 || rootState.width < 100 || rootState.height < 100) {
      throw new Error('PDF root is empty. Do not export blank PDF.');
    }

    return await page.pdf({
      format: 'A4',
      landscape: (options.orientation || 'portrait').toString().trim().toLowerCase() === 'landscape',
      printBackground: true,
      preferCSSPageSize: true,
      margin: {
        top: `${margins.top}mm`,
        right: `${margins.right}mm`,
        bottom: `${margins.bottom}mm`,
        left: `${margins.left}mm`
      }
    });
  } catch (error) {
    const message = error && error.message ? error.message : '';
    if (/EPERM|spawn/i.test(message)) {
      return await renderPdfWithBrowserFallback({ html, routePath, bootstrap, baseUrl, options, browserPath, jobDir });
    }
    throw error;
  } finally {
    if (page) {
      try { await page.close(); } catch (error) {}
    }
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (error) {}
  }
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
      pdfExportSupported: true,
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

  if (route === '/api/export/pdf' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      const parsed = req.method === 'POST'
        ? JSON.parse((await readRequestBody(req)) || '{}')
        : {
            html: typeof url.searchParams.get('html') === 'string' ? url.searchParams.get('html') : '',
            routePath: typeof url.searchParams.get('routePath') === 'string' ? url.searchParams.get('routePath').trim() : '',
            filename: url.searchParams.get('filename') || 'ope-export.pdf',
            inline: ['1', 'true', 'yes'].includes(((url.searchParams.get('inline') || '')).toLowerCase()),
            options: {
              title: url.searchParams.get('title') || '',
              orientation: url.searchParams.get('orientation') || 'portrait'
            }
          };
      const html = typeof parsed.html === 'string' ? parsed.html : '';
      const routePath = typeof parsed.routePath === 'string' ? parsed.routePath.trim() : '';
      const bootstrap = parsed.bootstrap && typeof parsed.bootstrap === 'object' ? parsed.bootstrap : null;
      if (!routePath && !html.trim()) return sendJson(req, res, 400, { error: 'Missing routePath or html' });
      const filename = sanitizePdfFilename(parsed.filename || 'ope-export.pdf');
      const pdfBuffer = await renderPdfWithHeadlessBrowser({
        html,
        routePath,
        bootstrap,
        baseUrl: getRequestBaseUrl(req),
        options: parsed.options || {}
      });
      return send(req, res, 200, pdfBuffer, 'application/pdf', {
        'Content-Disposition': `${parsed.inline ? 'inline' : 'attachment'}; filename="${escapeHtmlAttr(filename)}"`
      });
    } catch (error) {
      const message = error.message || 'Unable to generate PDF';
      const isBodyError = message === 'Missing routePath or html' || message === 'Payload too large' || /JSON/i.test(message);
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

  try {
    const dedicatedPdfDocument = await buildDedicatedPdfRouteResponse(req);
    if (dedicatedPdfDocument) {
      return send(req, res, 200, req.method === 'HEAD' ? '' : dedicatedPdfDocument, TYPES['.html']);
    }

    const pdfBootstrap = await buildPdfBootstrapPayload(req);
    if (pdfBootstrap) {
      const documentBuffer = buildPdfRouteDocument(pdfBootstrap, { baseUrl: getRequestBaseUrl(req) });
      return send(req, res, 200, req.method === 'HEAD' ? '' : documentBuffer, TYPES['.html']);
    }
  } catch (error) {
    const statusCode = Number(error.statusCode) || 500;
    return send(req, res, statusCode, error.message || 'Unable to prepare PDF view');
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
