require('dotenv').config();

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID, randomBytes, pbkdf2Sync, timingSafeEqual } = require('crypto');
const { pathToFileURL } = require('url');
const puppeteer = require('puppeteer-core');
const qrcodeGenerator = require('qrcode-generator');

const { VALID_STATE_KEYS, createStateStore, buildAdminScope, buildTeacherScope } = require('./state-store');
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

// Auth: super-admin credentials are read from env vars so they never ship in the
// client bundle. The defaults preserve backward compatibility with existing
// installations; rotate them via env (.env) in any real deployment.
const SUPER_ADMIN_EMAIL = (process.env.SUPER_ADMIN_EMAIL || 'prosperogidiaka@gmail.com').toString().trim().toLowerCase();
const SUPER_ADMIN_PASSWORD = (process.env.SUPER_ADMIN_PASSWORD || '7767737Prosper').toString();
const SESSION_TTL_MS = Math.max(60 * 1000, Number(process.env.SESSION_TTL_MS || 24 * 60 * 60 * 1000));
const PBKDF2_ITERATIONS = Math.max(10000, Number(process.env.PBKDF2_ITERATIONS || 100000));
const PBKDF2_KEY_BYTES = 32;
const PBKDF2_SALT_BYTES = 16;

// In-memory session store: token -> { email, role, expiresAt }
const sessions = new Map();

function hashPassword(plain) {
  const salt = randomBytes(PBKDF2_SALT_BYTES);
  const hash = pbkdf2Sync(String(plain || ''), salt, PBKDF2_ITERATIONS, PBKDF2_KEY_BYTES, 'sha256');
  return `pbkdf2-sha256:${PBKDF2_ITERATIONS}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPasswordHash(plain, encoded) {
  if (!encoded || typeof encoded !== 'string') return false;
  const parts = encoded.split(':');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[2], 'hex');
    expected = Buffer.from(parts[3], 'hex');
  } catch (error) {
    return false;
  }
  if (!salt.length || !expected.length) return false;
  const actual = pbkdf2Sync(String(plain || ''), salt, iterations, expected.length, 'sha256');
  if (actual.length !== expected.length) return false;
  try {
    return timingSafeEqual(actual, expected);
  } catch (error) {
    return false;
  }
}

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (!session || session.expiresAt <= now) sessions.delete(token);
  }
}

function createSession(email, role) {
  pruneExpiredSessions();
  const token = randomBytes(32).toString('hex');
  sessions.set(token, {
    email: (email || '').toString().trim().toLowerCase(),
    role: role || 'teacher',
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return token;
}

function getSessionFromRequest(req) {
  const header = (req.headers['authorization'] || '').toString().trim();
  if (!header) return null;
  const match = /^Bearer\s+(\S+)/i.exec(header);
  if (!match) return null;
  const token = match[1];
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function deleteSessionFromRequest(req) {
  const header = (req.headers['authorization'] || '').toString().trim();
  const match = /^Bearer\s+(\S+)/i.exec(header);
  if (match) sessions.delete(match[1]);
}

// Derive the storage-layer scope from a session. Super-admin sessions get the
// admin scope (full table reads); regular teacher sessions are restricted to
// their own rows. Throws on missing session — every read call site that uses
// this helper is already auth-gated, so a missing session is a programming
// bug, not a user-facing error.
function deriveScope(session) {
  if (!session) throw new Error('Session required to derive scope');
  if (session.role === 'super_admin') return buildAdminScope();
  return buildTeacherScope(session.email);
}

function redactTeacherRecord(record) {
  if (!record || typeof record !== 'object') return record;
  // Never expose stored credential material to clients via /api/state.
  const clone = { ...record };
  delete clone.password;
  delete clone.passwordHash;
  return clone;
}

function redactTeachersMap(map) {
  if (!map || typeof map !== 'object') return map;
  const out = {};
  Object.keys(map).forEach((key) => { out[key] = redactTeacherRecord(map[key]); });
  return out;
}

function redactStateForClient(state) {
  if (!state || typeof state !== 'object') return state;
  return { ...state, teachers: redactTeachersMap(state.teachers || {}) };
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stripCredentialFieldsFromTeacherInput(value) {
  if (!isPlainObject(value)) return value;
  const out = {};
  Object.keys(value).forEach((teacherKey) => {
    const record = value[teacherKey];
    if (!isPlainObject(record)) {
      out[teacherKey] = record;
      return;
    }
    const sanitized = { ...record };
    delete sanitized.password;
    delete sanitized.passwordHash;
    out[teacherKey] = sanitized;
  });
  return out;
}

async function migrateLegacyPasswordsAtStartup() {
  let teachers;
  try {
    // Startup migration runs before any session exists and must see every row.
    teachers = await stateStore.getStateValue('teachers', buildAdminScope());
  } catch (error) {
    console.warn('[Auth] Skipped password migration — failed to read teachers state:', error.message || error);
    return;
  }
  if (!isPlainObject(teachers)) return;
  let mutated = false;
  const next = {};
  const now = new Date().toISOString();
  Object.keys(teachers).forEach((key) => {
    const record = teachers[key];
    if (!isPlainObject(record)) {
      next[key] = record;
      return;
    }
    const isSuperAdmin = ((record.teacherId || record.email || key) || '').toString().trim().toLowerCase() === SUPER_ADMIN_EMAIL;
    if (isSuperAdmin) {
      // Super-admin credentials live only in env; strip any password residue.
      // Use `undefined` explicitly so the state-store merge (which is spread-only)
      // overwrites any existing field instead of leaving the legacy value behind,
      // and bump updatedAt so the migrated record always has a newer stamp.
      if ('password' in record || 'passwordHash' in record) {
        next[key] = {
          ...record,
          password: undefined,
          passwordHash: undefined,
          passwordResetAt: now,
          updatedAt: now
        };
        mutated = true;
      } else {
        next[key] = record;
      }
      return;
    }
    if (typeof record.password === 'string' && record.password) {
      next[key] = {
        ...record,
        passwordHash: hashPassword(record.password),
        password: undefined,
        passwordResetAt: now,
        updatedAt: now
      };
      mutated = true;
      return;
    }
    next[key] = record;
  });
  if (mutated) {
    try {
      await stateStore.putStateValue('teachers', next);
      console.log('[Auth] Migrated plaintext teacher passwords to PBKDF2 hashes.');
    } catch (error) {
      console.warn('[Auth] Failed to persist migrated teacher records:', error.message || error);
    }
  }
}

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
  // Only treat the SPA root as a canonical URL — share-link variants get a query string
  // we keep, but unknown deep paths fall back to the site root so we don't advertise
  // arbitrary URLs (e.g. /healthz) as canonical pages.
  const knownSpaPath = currentUrl.pathname === '/' || currentUrl.pathname === '/index.html';
  const canonicalUrl = knownSpaPath
    ? currentUrl.toString()
    : new URL('/', getRequestBaseUrl(req)).toString();
  return {
    title,
    description,
    url: canonicalUrl,
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
  // Read raw bytes (not a UTF-8 string) so a gzipped Content-Encoding payload
  // round-trips intact through zlib. Cap raw bytes received at MAX_BODY_BYTES
  // so a hostile / runaway client can't exhaust memory; cap the decompressed
  // size at the same limit so a small zip-bomb doesn't unfold into GB.
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const buffer = Buffer.concat(chunks, received);
      const encoding = ((req.headers && req.headers['content-encoding']) || '').toString().toLowerCase().trim();
      if (encoding === 'gzip') {
        try {
          const zlib = require('zlib');
          const decompressed = zlib.gunzipSync(buffer, { maxOutputLength: MAX_BODY_BYTES });
          resolve(decompressed.toString('utf8'));
        } catch (err) {
          reject(new Error(`Failed to decompress gzip body: ${err.message || err}`));
        }
        return;
      }
      resolve(buffer.toString('utf8'));
    });
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

  // Public share-key-gated route: students download results via /pdf/...?r=<shareKey>
  // without a session. Access control is the shareKey itself, so we need admin
  // scope to look it up across submissions.
  const quizzes = await stateStore.getStateValue('quizzes', buildAdminScope());
  const submissions = await stateStore.getStateValue('submissions', buildAdminScope());
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

  // Same public share-key-gated lookup as buildDedicatedPdfRouteResponse — no session.
  const quizzes = await stateStore.getStateValue('quizzes', buildAdminScope());
  const submissions = await stateStore.getStateValue('submissions', buildAdminScope());
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
  const candidates = [PDF_BROWSER_PATH];
  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || '';
    candidates.push(
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      localAppData ? path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
      localAppData ? path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
      programFiles ? path.join(programFiles, 'Chromium', 'Application', 'chrome.exe') : ''
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/snap/bin/chromium',
      '/snap/bin/google-chrome'
    );
  }
  return candidates.filter(Boolean);
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
    const tried = getPdfBrowserCandidates();
    throw new Error(`No Chromium-based browser was found for PDF export on this server. Set PDF_BROWSER_PATH in the server environment to a Chrome/Edge/Chromium executable. Tried: ${tried.join(', ') || '(none)'}.`);
  }
  return resolved;
}

function detectPdfBrowserPath() {
  try {
    return findPdfBrowserPath();
  } catch (error) {
    return null;
  }
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
    const pdfBrowser = detectPdfBrowserPath();
    return sendJson(req, res, 200, {
      ok: true,
      pdfExportSupported: !!pdfBrowser,
      pdfBrowserPath: pdfBrowser ? path.basename(pdfBrowser) : null,
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

  // ---- Auth endpoints ---------------------------------------------------
  if (route === '/api/auth/super-admin/login' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      const parsed = JSON.parse(body || '{}');
      const email = (parsed.email || '').toString().trim().toLowerCase();
      const password = (parsed.password || '').toString();
      if (email !== SUPER_ADMIN_EMAIL || password !== SUPER_ADMIN_PASSWORD) {
        return sendJson(req, res, 401, { error: 'Invalid admin email or password' });
      }
      const token = createSession(SUPER_ADMIN_EMAIL, 'super_admin');
      return sendJson(req, res, 200, {
        ok: true,
        sessionToken: token,
        role: 'super_admin',
        email: SUPER_ADMIN_EMAIL,
        expiresInMs: SESSION_TTL_MS
      });
    } catch (error) {
      const message = error.message || 'Invalid request body';
      const isBodyError = /JSON/i.test(message) || message === 'Payload too large';
      return sendJson(req, res, isBodyError ? 400 : 500, { error: message });
    }
  }

  if (route === '/api/auth/teacher/login' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      const parsed = JSON.parse(body || '{}');
      const email = (parsed.email || '').toString().trim().toLowerCase();
      const password = (parsed.password || '').toString();
      if (!email || !password) return sendJson(req, res, 400, { error: 'Email and password are required' });
      if (email === SUPER_ADMIN_EMAIL) return sendJson(req, res, 401, { error: 'Use the admin login for this account' });
      // Pre-session credential lookup: no session yet, must read full teachers map.
      const teachers = await stateStore.getStateValue('teachers', buildAdminScope());
      const record = teachers && teachers[email];
      if (!record || typeof record !== 'object') {
        return sendJson(req, res, 401, { error: 'Invalid teacher ID or password' });
      }
      let ok = false;
      let migratedRecord = null;
      if (record.passwordHash) {
        ok = verifyPasswordHash(password, record.passwordHash);
      } else if (typeof record.password === 'string' && record.password) {
        // Lazy-migrate: legacy plaintext password matches → upgrade to PBKDF2 hash now.
        if (record.password === password) {
          ok = true;
          migratedRecord = { ...record, passwordHash: hashPassword(password), passwordResetAt: new Date().toISOString() };
          delete migratedRecord.password;
        }
      }
      if (!ok) return sendJson(req, res, 401, { error: 'Invalid teacher ID or password' });
      if (migratedRecord) {
        try {
          await stateStore.putStateValue('teachers', { [email]: migratedRecord });
        } catch (error) {
          console.warn('[Auth] Could not persist lazy password migration:', error.message || error);
        }
      }
      const token = createSession(email, 'teacher');
      return sendJson(req, res, 200, {
        ok: true,
        sessionToken: token,
        role: 'teacher',
        email,
        expiresInMs: SESSION_TTL_MS
      });
    } catch (error) {
      const message = error.message || 'Invalid request body';
      const isBodyError = /JSON/i.test(message) || message === 'Payload too large';
      return sendJson(req, res, isBodyError ? 400 : 500, { error: message });
    }
  }

  if (route === '/api/auth/teacher/register' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      const parsed = JSON.parse(body || '{}');
      const email = (parsed.email || '').toString().trim().toLowerCase();
      const password = (parsed.password || '').toString();
      const profile = isPlainObject(parsed.profile) ? parsed.profile : {};
      if (!email || !password) return sendJson(req, res, 400, { error: 'Email and password are required' });
      if (password.length < 4) return sendJson(req, res, 400, { error: 'Password must be at least 4 characters' });
      if (email === SUPER_ADMIN_EMAIL) return sendJson(req, res, 409, { error: 'Admin account already exists. Login instead.' });
      // Pre-session existence check: must see the full teachers map to detect duplicates.
      const teachers = (await stateStore.getStateValue('teachers', buildAdminScope())) || {};
      if (teachers[email]) return sendJson(req, res, 409, { error: 'Teacher ID already exists. Login instead.' });
      const now = new Date().toISOString();
      const cleanProfile = { ...profile };
      delete cleanProfile.password;
      delete cleanProfile.passwordHash;
      const newRecord = {
        ...cleanProfile,
        teacherId: email,
        email,
        passwordHash: hashPassword(password),
        role: 'teacher',
        name: cleanProfile.name || '',
        phone: cleanProfile.phone || '',
        tokenBalance: cleanProfile.tokenBalance ?? 0,
        tokenUpdatedAt: now,
        tokenRequestStatus: cleanProfile.tokenRequestStatus || '',
        unlimitedExpiresAt: cleanProfile.unlimitedExpiresAt || '',
        unlimitedDeviceId: cleanProfile.unlimitedDeviceId || '',
        createdAt: now,
        updatedAt: now,
        passwordResetAt: now
      };
      await stateStore.putStateValue('teachers', { [email]: newRecord });
      const token = createSession(email, 'teacher');
      return sendJson(req, res, 200, {
        ok: true,
        sessionToken: token,
        role: 'teacher',
        email,
        expiresInMs: SESSION_TTL_MS
      });
    } catch (error) {
      const message = error.message || 'Invalid request body';
      const isBodyError = /JSON/i.test(message) || message === 'Payload too large';
      return sendJson(req, res, isBodyError ? 400 : 500, { error: message });
    }
  }

  if (route === '/api/auth/teacher/change-password' && req.method === 'POST') {
    const session = getSessionFromRequest(req);
    if (!session) return sendJson(req, res, 401, { error: 'Not authenticated' });
    if (session.role !== 'teacher') return sendJson(req, res, 403, { error: 'Only teacher accounts can change their own password here' });
    try {
      const body = await readRequestBody(req);
      const parsed = JSON.parse(body || '{}');
      const currentPassword = (parsed.currentPassword || '').toString();
      const newPassword = (parsed.newPassword || '').toString();
      if (!newPassword || newPassword.length < 4) return sendJson(req, res, 400, { error: 'New password must be at least 4 characters' });
      const teachers = (await stateStore.getStateValue('teachers', deriveScope(session))) || {};
      const record = teachers[session.email];
      if (!record) return sendJson(req, res, 404, { error: 'Teacher not found' });
      let currentOk = false;
      if (record.passwordHash) currentOk = verifyPasswordHash(currentPassword, record.passwordHash);
      else if (typeof record.password === 'string') currentOk = record.password === currentPassword;
      if (!currentOk) return sendJson(req, res, 401, { error: 'Current password is incorrect' });
      const updated = { ...record, passwordHash: hashPassword(newPassword), updatedAt: new Date().toISOString(), passwordResetAt: new Date().toISOString() };
      delete updated.password;
      await stateStore.putStateValue('teachers', { [session.email]: updated });
      return sendJson(req, res, 200, { ok: true });
    } catch (error) {
      const message = error.message || 'Invalid request body';
      const isBodyError = /JSON/i.test(message) || message === 'Payload too large';
      return sendJson(req, res, isBodyError ? 400 : 500, { error: message });
    }
  }

  if (route === '/api/auth/teacher/admin-reset-password' && req.method === 'POST') {
    const session = getSessionFromRequest(req);
    if (!session || session.role !== 'super_admin') return sendJson(req, res, 403, { error: 'Admin authentication required' });
    try {
      const body = await readRequestBody(req);
      const parsed = JSON.parse(body || '{}');
      const teacherEmail = (parsed.teacherEmail || '').toString().trim().toLowerCase();
      const newPassword = (parsed.newPassword || '').toString();
      if (!teacherEmail || !newPassword) return sendJson(req, res, 400, { error: 'Teacher email and new password required' });
      if (newPassword.length < 4) return sendJson(req, res, 400, { error: 'Password must be at least 4 characters' });
      if (teacherEmail === SUPER_ADMIN_EMAIL) return sendJson(req, res, 400, { error: 'Admin password is set via environment variables, not the API' });
      // Super-admin only — deriveScope returns admin scope so the cross-tenant lookup works.
      const teachers = (await stateStore.getStateValue('teachers', deriveScope(session))) || {};
      const record = teachers[teacherEmail];
      if (!record) return sendJson(req, res, 404, { error: 'Teacher not found' });
      const updated = { ...record, passwordHash: hashPassword(newPassword), updatedAt: new Date().toISOString(), passwordResetAt: new Date().toISOString() };
      delete updated.password;
      await stateStore.putStateValue('teachers', { [teacherEmail]: updated });
      return sendJson(req, res, 200, { ok: true });
    } catch (error) {
      const message = error.message || 'Invalid request body';
      const isBodyError = /JSON/i.test(message) || message === 'Payload too large';
      return sendJson(req, res, isBodyError ? 400 : 500, { error: message });
    }
  }

  if (route === '/api/auth/session' && req.method === 'GET') {
    const session = getSessionFromRequest(req);
    if (!session) return sendJson(req, res, 200, { authenticated: false });
    return sendJson(req, res, 200, {
      authenticated: true,
      email: session.email,
      role: session.role,
      expiresAt: session.expiresAt
    });
  }

  if (route === '/api/auth/logout' && req.method === 'POST') {
    deleteSessionFromRequest(req);
    return sendJson(req, res, 200, { ok: true });
  }

  // ---- Shared state ----------------------------------------------------
  if (route === '/api/state' && req.method === 'GET') {
    const session = getSessionFromRequest(req);
    if (!session) return sendJson(req, res, 401, { error: 'Authentication required' });
    try {
      return sendJson(req, res, 200, redactStateForClient(await stateStore.getState(deriveScope(session))));
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
      const session = getSessionFromRequest(req);
      if (!session) return sendJson(req, res, 401, { error: 'Authentication required' });
      try {
        const value = await stateStore.getStateValue(stateKey, deriveScope(session));
        const safeValue = stateKey === 'teachers' ? redactTeachersMap(value || {}) : value;
        return sendJson(req, res, 200, { key: stateKey, value: safeValue });
      } catch (error) {
        return sendJson(req, res, 500, { error: error.message || 'Failed to load shared state value' });
      }
    }

    if (req.method === 'PUT') {
      // Mutation policy:
      //   submissions  → public (anonymous students must be able to submit; merge-only semantics protect existing rows)
      //   everything   → requires a valid session token
      // In addition, PUT /api/state/teachers is rewritten to strip credential fields so that
      //   the auth endpoints remain the only way to set or change passwords.
      const session = getSessionFromRequest(req);
      const requiresAuth = stateKey !== 'submissions';
      if (requiresAuth && !session) {
        return sendJson(req, res, 401, { error: 'Authentication required for this state key' });
      }
      try {
        const body = await readRequestBody(req);
        const parsed = JSON.parse(body || '{}');
        if (!Object.prototype.hasOwnProperty.call(parsed, 'value')) {
          return sendJson(req, res, 400, { error: 'Missing value' });
        }
        let nextValue = parsed.value;
        if (stateKey === 'teachers') nextValue = stripCredentialFieldsFromTeacherInput(nextValue);
        await stateStore.putStateValue(stateKey, nextValue);
        return sendJson(req, res, 200, { ok: true, key: stateKey, backend: stateStore.backend });
      } catch (error) {
        const message = error.message || 'Invalid request body';
        const isBodyError = message === 'Missing value' || message === 'Payload too large' || /JSON/i.test(message);
        return sendJson(req, res, isBodyError ? 400 : 500, { error: message });
      }
    }
  }

  // ---- Per-quiz read/write -------------------------------------------------
  // Mirrors functions/api/quizzes/[id].js for the Node dev path. The Cloudflare
  // route is the production path; the Node route exists so `pushSingleQuizToCloud`
  // and per-quiz refreshes work against `npm start` too.
  if (route.startsWith('/api/quizzes/')) {
    const session = getSessionFromRequest(req);
    if (!session) return sendJson(req, res, 401, { error: 'Authentication required' });
    const quizId = decodeURIComponent(route.replace('/api/quizzes/', '')).trim();
    if (!quizId) return sendJson(req, res, 400, { error: 'Missing quiz id' });
    const sessionEmail = (session.email || '').toString().trim().toLowerCase();
    const isAdmin = session.role === 'super_admin';
    const scope = deriveScope(session);

    if (req.method === 'GET') {
      try {
        // Scope-filtered read: a non-admin teacher only sees their own quizzes,
        // so an unowned/missing quiz is indistinguishable (404) — no info leak.
        const quizzes = (await stateStore.getStateValue('quizzes', scope)) || {};
        const quiz = quizzes[quizId];
        if (!quiz) return sendJson(req, res, 404, { error: 'Quiz not found' });
        const allSubmissions = (await stateStore.getStateValue('submissions', scope)) || [];
        const submissions = allSubmissions.filter((item) => item && item.quizId === quizId);
        return sendJson(req, res, 200, { quiz, submissions });
      } catch (error) {
        return sendJson(req, res, 500, { error: error.message || 'Failed to load quiz' });
      }
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      try {
        const body = await readRequestBody(req);
        const parsedBody = JSON.parse(body || '{}');
        if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
          return sendJson(req, res, 400, { error: 'Body must be a JSON object' });
        }
        // Two accepted shapes (mirrors functions/api/quizzes/[id].js):
        //   1) <quiz> — bare quiz, legacy per-quiz save.
        //   2) { quiz?, submissions? } — bundle for teacher-side regrade /
        //      delete flows so they don't fall back to bulk submissions PUT.
        const isBundle = Array.isArray(parsedBody.submissions) || (parsedBody.quiz && typeof parsedBody.quiz === 'object' && !Array.isArray(parsedBody.quiz));
        const parsedQuiz = isBundle
          ? (parsedBody.quiz && typeof parsedBody.quiz === 'object' && !Array.isArray(parsedBody.quiz) ? parsedBody.quiz : null)
          : parsedBody;
        const submissionsInput = isBundle && Array.isArray(parsedBody.submissions) ? parsedBody.submissions : null;
        if (!parsedQuiz && !submissionsInput) {
          return sendJson(req, res, 400, { error: 'Body must include quiz, submissions, or both' });
        }
        if (parsedQuiz) {
          const bodyTeacherId = (parsedQuiz.teacherId || '').toString().trim().toLowerCase();
          if (!isAdmin && bodyTeacherId && bodyTeacherId !== sessionEmail) {
            return sendJson(req, res, 403, { error: 'Cannot save a quiz owned by another teacher' });
          }
          if (!isAdmin && !bodyTeacherId) parsedQuiz.teacherId = sessionEmail;
        }
        // Ownership check against the existing row regardless of shape.
        const existingMap = (await stateStore.getStateValue('quizzes', buildAdminScope())) || {};
        const existing = existingMap[quizId];
        const existingTeacher = (existing && (existing.teacherId || '')).toString().trim().toLowerCase();
        if (existingTeacher && existingTeacher !== sessionEmail && !isAdmin) {
          return sendJson(req, res, 403, { error: 'Quiz id is already owned by another teacher' });
        }
        if (submissionsInput && !existing && !parsedQuiz) {
          return sendJson(req, res, 404, { error: 'Quiz must exist before its submissions can be saved' });
        }
        const syncedAt = new Date().toISOString();
        if (parsedQuiz) {
          const next = { ...parsedQuiz, id: quizId, cloudSyncedAt: syncedAt, updatedAt: parsedQuiz.updatedAt || syncedAt };
          await stateStore.putStateValue('quizzes', { [quizId]: next });
        }
        let submissionsUpserted = 0;
        if (submissionsInput) {
          const cleaned = [];
          for (let index = 0; index < submissionsInput.length; index += 1) {
            const item = submissionsInput[index];
            if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
            const itemQuizId = (item.quizId || '').toString().trim();
            if (itemQuizId && itemQuizId !== quizId) {
              return sendJson(req, res, 400, { error: `submissions[${index}].quizId does not match the quiz in the URL` });
            }
            cleaned.push({ ...item, quizId });
          }
          if (cleaned.length) {
            // The state-store merges by submissionId, so passing the per-quiz
            // slice doesn't clobber other quizzes' submissions.
            await stateStore.putStateValue('submissions', cleaned);
            submissionsUpserted = cleaned.length;
          }
        }
        return sendJson(req, res, 200, { ok: true, id: quizId, syncedAt, submissionsUpserted });
      } catch (error) {
        const message = error.message || 'Invalid request body';
        const isBodyError = message === 'Payload too large' || /JSON/i.test(message);
        return sendJson(req, res, isBodyError ? 400 : 500, { error: message });
      }
    }

    return sendJson(req, res, 405, { error: 'Method not allowed' });
  }

  // ---- Public share-key correction lookup ---------------------------------
  // No auth: the shareKey is the access token. Used by the student-correction
  // route in the SPA so a student opening the link from WhatsApp / email on a
  // device they didn't take the test on can still load their correction.
  if (route.startsWith('/api/submissions/share/')) {
    if (req.method !== 'GET') return sendJson(req, res, 405, { error: 'Method not allowed' });
    const shareKey = decodeURIComponent(route.replace('/api/submissions/share/', '')).trim().toLowerCase();
    if (!shareKey) return sendJson(req, res, 400, { error: 'Missing share key' });
    try {
      const submissions = (await stateStore.getStateValue('submissions', buildAdminScope())) || [];
      const submission = submissions.find((item) => ((item && item.shareKey) || '').toString().trim().toLowerCase() === shareKey) || null;
      if (!submission) return sendJson(req, res, 404, { error: 'Correction not found for this share link.' });
      const quizzes = (await stateStore.getStateValue('quizzes', buildAdminScope())) || {};
      const quiz = quizzes[submission.quizId] || null;
      return sendJson(req, res, 200, { submission, quiz });
    } catch (error) {
      return sendJson(req, res, 500, { error: error.message || 'Failed to load correction' });
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
  // Convenience alias used by health-check probes that expect /healthz to return JSON.
  if (req.url === '/healthz' || req.url === '/healthz/') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(req, res, 405, 'Method not allowed');
    }
    req.url = '/api/health';
  }

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
  console.log(`Super-admin email: ${SUPER_ADMIN_EMAIL} (password is read from SUPER_ADMIN_PASSWORD env var; rotate it in .env)`);
  getLocalAddresses().forEach((address) => {
    console.log(`Open from another device on this Wi-Fi: http://${address}:${PORT}`);
  });
  migrateLegacyPasswordsAtStartup().catch((error) => {
    console.warn('[Auth] Password migration encountered an error:', error.message || error);
  });
});
