// OPE ASSESSOR - Complete Application Logic
// Blue Pastel Theme   Centered Layout   Protected Results Access

// ============================================================================
// STATE & STORAGE
// ============================================================================

const SUPER_ADMIN_EMAIL = 'prosperogidiaka@gmail.com';
// The super-admin password is no longer kept in the client bundle. It is verified
// server-side via /api/auth/super-admin/login (see server.js). The constant below
// remains only as a no-op marker so other tooling that referenced it still parses
// cleanly; it is never used for authentication.
const SUPER_ADMIN_PASSWORD = '';
const ADMIN_CONTACT_EMAIL = SUPER_ADMIN_EMAIL;
const STORAGE_KEYS = {
  quizzes: 'ope_quizzes_v2',
  submissions: 'ope_submissions_v2',
  // Small, append-only queue of student submissions that haven't been confirmed
  // saved to the cloud yet (POST /api/submissions). Drained on submit, on app
  // load, and whenever the browser comes back online. NOT part of NETWORK_SYNC_KEYS
  // — it's a local retry buffer, never itself synced.
  submissionOutbox: 'ope_submission_outbox_v1',
  teacherId: 'ope_teacher_id',
  teachers: 'ope_teachers_v1',
  tokenTransactions: 'ope_token_transactions_v1',
  teacherSession: 'ope_teacher_session_v1',
  students: 'ope_teacher_students_v1',
  appState: 'ope_app_state_v1',
  syncApiBaseUrl: 'ope_sync_api_base_url_v1',
  // Local-only credential cache, never synced to the server. Used so that an
  // already-registered teacher can still authenticate offline against a hash
  // computed and stored after their last successful online login.
  localAuth: 'ope_local_auth_v1',
  // Active session token returned by /api/auth/* endpoints. Only used to gate
  // mutation calls to /api/state/<key>; cleared on logout.
  authSession: 'ope_auth_session_v1',
  alertState: 'ope_alert_state_v1'
};
const NETWORK_SYNC_KEYS = [
  STORAGE_KEYS.quizzes,
  STORAGE_KEYS.submissions,
  STORAGE_KEYS.teachers,
  STORAGE_KEYS.students,
  STORAGE_KEYS.tokenTransactions
];
const NETWORK_STATE_KEY_MAP = {
  [STORAGE_KEYS.quizzes]: 'quizzes',
  [STORAGE_KEYS.submissions]: 'submissions',
  [STORAGE_KEYS.teachers]: 'teachers',
  [STORAGE_KEYS.students]: 'students',
  [STORAGE_KEYS.tokenTransactions]: 'tokenTransactions'
};
// Sync is manual-only: it runs when the teacher clicks a Sync button, never on
// a timer, focus, visibilitychange, online, or from the service worker. There
// is still a single best-effort pull on first load so a teacher signing in on a
// new browser sees their cloud data — that's a one-shot read, not a retry loop.
const DEFAULT_NETWORK_SYNC_POLL_MS = 15000;
const DEFAULT_NETWORK_SYNC_RETRY_MS = 1500;
// Cap how long the very first paint waits on the cloud pull. Keep this short
// so a slow/cold serverless backend doesn't leave the user staring at a blank
// screen — the app falls back to local data and a background sync still runs.
const DEFAULT_STARTUP_SYNC_TIMEOUT_MS = 2000;
// Teacher/admin workspaces need a longer read window than the public/student
// routes because /api/state can legitimately include many quizzes, teachers,
// and submissions. If the wait still expires, we let the request finish in the
// background and force a re-render when the late result lands.
const DEFAULT_WORKSPACE_SYNC_TIMEOUT_MS = 12000;
const DEFAULT_TEACHER_NAV_SYNC_TIMEOUT_MS = 10000;
const PORTABLE_QUIZ_CODE_PREFIX = 'OPEQUIZ:';
const MAX_PORTABLE_LINK_LENGTH = 3500;
const DEFAULT_SUPPORT_SETTINGS = {
  email: ADMIN_CONTACT_EMAIL,
  whatsapp: ''
};
const APP_DEVICE_ID_KEY = 'ope_app_device_id_v1';
const APP_LOGO_SRC = '/ope-icon-192.png?v=20260525-attached-approved-3';
const APP_INSTALL_HELP_MESSAGE = 'To install OPE Assessor, open your browser menu and choose Install app or Add to Home screen.';
const TOKEN_PRICE_PER_QUIZ = 1000;
const TOKEN_UNLIMITED_TRANSFER_COOLDOWN_DAYS = 30;
const TOKEN_PACKAGE_DEFINITIONS = {
  single: { key: 'single', label: 'Single', tokens: 1, price: 1000, useCase: 'One-off' },
  starter: { key: 'starter', label: 'Starter', tokens: 3, price: 2700, useCase: 'Save ₦300' },
  standard: { key: 'standard', label: 'Standard', tokens: 7, price: 6000, useCase: 'Save ₦1,000' },
  pro: { key: 'pro', label: 'Pro', tokens: 15, price: 12000, useCase: 'Save ₦3,000' },
  school: { key: 'school', label: 'School', tokens: 50, price: 35000, useCase: 'Save ₦15,000' },
  'unlimited-3mo': { key: 'unlimited-3mo', label: '3-Month Unlimited', tokens: 0, price: 50000, unlimitedDays: 90, useCase: 'Unlimited quiz saving for 3 months on one registered device' }
};

function normalizeApiBaseUrl(value) {
  return (value || '').toString().trim().replace(/\/+$/, '');
}

function readStoredSyncApiBaseUrl() {
  if (typeof window === 'undefined') return '';
  try {
    return normalizeApiBaseUrl(localStorage.getItem(STORAGE_KEYS.syncApiBaseUrl) || '');
  } catch (error) {
    return '';
  }
}

function readQuerySyncApiBaseUrl() {
  if (typeof window === 'undefined') return '';
  try {
    const params = new URLSearchParams(window.location.search || '');
    return normalizeApiBaseUrl(params.get('syncApiBaseUrl') || params.get('apiBaseUrl') || '');
  } catch (error) {
    return '';
  }
}

function getNetworkSyncConfig() {
  const rawConfig = typeof window !== 'undefined' && window.OPE_CONFIG && typeof window.OPE_CONFIG === 'object'
    ? window.OPE_CONFIG
    : {};
  const apiBaseUrl = readQuerySyncApiBaseUrl() || readStoredSyncApiBaseUrl() || normalizeApiBaseUrl(rawConfig.apiBaseUrl);
  const pollIntervalMs = Number(rawConfig.syncPollIntervalMs) > 0
    ? Number(rawConfig.syncPollIntervalMs)
    : DEFAULT_NETWORK_SYNC_POLL_MS;
  return { apiBaseUrl, pollIntervalMs };
}

const NETWORK_SYNC_CONFIG = getNetworkSyncConfig();

function buildApiUrl(path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return NETWORK_SYNC_CONFIG.apiBaseUrl
    ? `${NETWORK_SYNC_CONFIG.apiBaseUrl}${normalizedPath}`
    : normalizedPath;
}

function getCurrentSyncServerBaseUrl() {
  if (NETWORK_SYNC_CONFIG.apiBaseUrl) return NETWORK_SYNC_CONFIG.apiBaseUrl;
  if (typeof window !== 'undefined' && /^https?:$/i.test(window.location.protocol || '')) return window.location.origin;
  return '';
}

function getCurrentSyncServerLabel() {
  return getCurrentSyncServerBaseUrl() || 'this app origin';
}

function setNetworkSyncApiBaseUrl(value) {
  const normalized = normalizeApiBaseUrl(value);
  NETWORK_SYNC_CONFIG.apiBaseUrl = normalized;
  try {
    if (normalized) localStorage.setItem(STORAGE_KEYS.syncApiBaseUrl, normalized);
    else localStorage.removeItem(STORAGE_KEYS.syncApiBaseUrl);
  } catch (error) {}
  networkSyncReady = false;
  networkSyncFailed = false;
  networkSyncFailureMessage = '';
  lastNetworkPullAt = 0;
}

// --------------------------------------------------------------------------
// Auth helpers
// Server is the source of truth for credentials. Local hash cache only exists
// to allow already-registered teachers to log in offline after a previous
// successful online login. The super-admin login is server-only.
// --------------------------------------------------------------------------
const AUTH_PBKDF2_ITERATIONS = 100000;
const AUTH_PBKDF2_KEY_BITS = 256;

function getStoredAuthSession() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEYS.authSession) || 'null');
    if (!raw || typeof raw !== 'object') return null;
    if (raw.expiresAt && Number(raw.expiresAt) < Date.now()) {
      localStorage.removeItem(STORAGE_KEYS.authSession);
      return null;
    }
    return raw;
  } catch (error) {
    return null;
  }
}

function getAuthSessionToken() {
  const session = getStoredAuthSession();
  return session && session.token ? session.token : '';
}

function setStoredAuthSession({ token, role, email, expiresInMs }) {
  if (!token) {
    try { localStorage.removeItem(STORAGE_KEYS.authSession); } catch (error) {}
    return;
  }
  const expiresAt = Date.now() + (Number(expiresInMs) > 0 ? Number(expiresInMs) : 24 * 60 * 60 * 1000);
  try {
    localStorage.setItem(STORAGE_KEYS.authSession, JSON.stringify({ token, role: role || '', email: email || '', expiresAt }));
  } catch (error) {}
  // Any keys that were marked dirty while we were anonymous (e.g. ensureSuperAdminAccount
  // re-writing the teachers map at startup) can now be flushed to the server.
  if (typeof schedulePendingNetworkFlush === 'function') {
    try { schedulePendingNetworkFlush(50); } catch (error) {}
  }
}

function clearStoredAuthSession() {
  try { localStorage.removeItem(STORAGE_KEYS.authSession); } catch (error) {}
}

function withAuthHeader(headers = {}) {
  const token = getAuthSessionToken();
  if (!token) return headers;
  return { ...headers, Authorization: `Bearer ${token}` };
}

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0) return new Uint8Array();
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function deriveAuthHashRaw(password, saltBytes, iterations = AUTH_PBKDF2_ITERATIONS, keyBits = AUTH_PBKDF2_KEY_BITS) {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('Web Crypto API is required for password operations.');
  }
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(password || '')),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    baseKey,
    keyBits
  );
  return new Uint8Array(derived);
}

async function computeLocalAuthHash(password, saltBytes) {
  const salt = saltBytes || crypto.getRandomValues(new Uint8Array(16));
  const hash = await deriveAuthHashRaw(password, salt);
  return `pbkdf2-sha256:${AUTH_PBKDF2_ITERATIONS}:${bytesToHex(salt)}:${bytesToHex(hash)}`;
}

async function verifyLocalAuthHash(password, encoded) {
  if (!encoded || typeof encoded !== 'string') return false;
  const parts = encoded.split(':');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1) return false;
  const saltBytes = hexToBytes(parts[2]);
  const expectedBytes = hexToBytes(parts[3]);
  if (!saltBytes.length || !expectedBytes.length) return false;
  const actualBytes = await deriveAuthHashRaw(password, saltBytes, iterations, expectedBytes.length * 8);
  if (actualBytes.length !== expectedBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < actualBytes.length; i++) diff |= actualBytes[i] ^ expectedBytes[i];
  return diff === 0;
}

function getLocalAuthMap() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEYS.localAuth) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (error) {
    return {};
  }
}

function setLocalAuthRecord(email, record) {
  const id = (email || '').toString().trim().toLowerCase();
  if (!id) return;
  const map = getLocalAuthMap();
  map[id] = { ...(map[id] || {}), ...(record || {}), updatedAt: new Date().toISOString() };
  try { localStorage.setItem(STORAGE_KEYS.localAuth, JSON.stringify(map)); } catch (error) {}
}

function clearLocalAuthRecord(email) {
  const id = (email || '').toString().trim().toLowerCase();
  if (!id) return;
  const map = getLocalAuthMap();
  if (!map[id]) return;
  delete map[id];
  try { localStorage.setItem(STORAGE_KEYS.localAuth, JSON.stringify(map)); } catch (error) {}
}

async function recordLocalAuthForPassword(email, password) {
  try {
    const hash = await computeLocalAuthHash(password);
    setLocalAuthRecord(email, { passwordHash: hash });
    return true;
  } catch (error) {
    return false;
  }
}

async function postAuthJson(path, body) {
  const response = await fetch(buildApiUrl(path), {
    method: 'POST',
    headers: withAuthHeader({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body || {}),
    cache: 'no-store'
  });
  let parsed = null;
  try { parsed = await response.json(); } catch (error) { parsed = null; }
  return { ok: response.ok, status: response.status, data: parsed };
}

function migrateLegacyLocalTeacherPasswords() {
  // One-time cleanup so localStorage no longer carries plaintext passwords from
  // previous app versions. We hash and stash them under STORAGE_KEYS.localAuth
  // so offline login still works for teachers that were already registered.
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEYS.teachers) || '{}');
    if (!raw || typeof raw !== 'object') return;
    let mutated = false;
    const next = {};
    Object.keys(raw).forEach((key) => {
      const record = raw[key];
      if (!record || typeof record !== 'object') { next[key] = record; return; }
      if (typeof record.password === 'string' && record.password) {
        const sanitized = { ...record };
        delete sanitized.password;
        next[key] = sanitized;
        mutated = true;
        // Fire-and-forget local hash so offline login keeps working.
        recordLocalAuthForPassword((record.email || record.teacherId || key), record.password)
          .catch(() => {});
      } else {
        next[key] = record;
      }
    });
    if (mutated) localStorage.setItem(STORAGE_KEYS.teachers, JSON.stringify(next));
  } catch (error) { /* ignore */ }
}

async function probeNetworkSyncHealth(apiBaseUrl, options = {}) {
  const previousApiBaseUrl = NETWORK_SYNC_CONFIG.apiBaseUrl;
  NETWORK_SYNC_CONFIG.apiBaseUrl = normalizeApiBaseUrl(apiBaseUrl);
  try {
    return await checkNetworkSyncHealth(options);
  } finally {
    if (options.persist !== true) {
      NETWORK_SYNC_CONFIG.apiBaseUrl = previousApiBaseUrl;
    }
  }
}

function getAppDeviceId() {
  try {
    let existing = localStorage.getItem(APP_DEVICE_ID_KEY) || '';
    existing = existing.toString().trim();
    if (existing) return existing;
    const generated = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `device-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(APP_DEVICE_ID_KEY, generated);
    return generated;
  } catch (error) {
    return `device-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function getTeacherId() {
  const session = load(STORAGE_KEYS.teacherSession);
  return session && session.teacherId ? session.teacherId : '';
}

const state = {
  view: 'home',
  currentQuiz: null,
  currentSubmission: null,
  inFullscreen: false,
  screenshotDetected: false,
  teacherId: getTeacherId(),
  prefillQuizCode: '',
  pendingResultLookup: null,
  resultLinkUi: null,
  teacherGuideTopic: '',
  classFilters: {},
  pdfBootstrap: null,
  printRoute: null,
  pendingResultsFocus: null
};
let _didCompactSubmissions = false;
let _didReclaimOrphanQuizzes = false;
let _didFlushSubmissionOutbox = false;
// Session-only safety net for devices whose localStorage is too full to hold a
// quiz's submissions: pullQuizSubmissionsFromCloud() parks that quiz's cloud
// copy here (keyed by quizId) so the Results view still renders it. Empty in the
// normal case, so getAllStoredSubmissions() does no extra work then.
const _cloudSubmissionsFallback = new Map();
let networkSyncReady = false;
let networkSyncTimer = null;
let networkSyncInFlight = null;
let networkSyncFailed = false;
let networkSyncFailureMessage = '';
const pendingNetworkWrites = new Set();
const pendingNetworkWritePromises = new Map();
const dirtyNetworkKeys = new Set();
let networkSyncRetryTimer = null;
let networkSyncEventsBound = false;
const STORAGE_QUOTA_NOTICE_COOLDOWN_MS = 30000;
let lastStorageQuotaNoticeAt = 0;
let skipAppStateStorageWritesForSession = false;
let lastNetworkPullAt = 0;
// Sync is strictly manual now. `userInitiatedSync` is true only for the
// duration of a click on a Sync button, so error toasts/banners surface ONLY
// when the user actually asked for a sync. `lastSyncFailedForUser` persists
// between renders so the "shared sync is not active" card appears only after a
// user-initiated sync exhausted its retries — never because of a background read.
let userInitiatedSync = false;
let lastSyncFailedForUser = false;
let serverPdfExportUnavailable = false;
let _clientTrackingContextCache = null;
let _clientTrackingContextPromise = null;
let _historyApplying = false;
let _lastHistoryView = '';
let _lastRenderedView = '';
// Throttle for the pull that runs when the teacher navigates into a dashboard
// page (so new student attempts show up). Not a timer — fires on navigation
// only — and at most once a minute so it never becomes the old polling loop.
let _lastTeacherNavPullAt = 0;
// Which quiz the results view has already pulled submissions for this session.
// Stops the per-quiz pull from re-firing on every re-render of the results page.
let _resultsPulledForQuizId = '';
let _pendingScrollRestore = null;
let _overlayBodyLockObserver = null;
let _pendingNewTeacherProfilePrompt = false;
let deferredInstallPrompt = null;
let installPromptEventsBound = false;
let _startupSplashHidden = false;

function getPdfBootstrapPayload() {
  if (typeof window === 'undefined') return null;
  const payload = window.__OPE_PDF_BOOTSTRAP__;
  return payload && typeof payload === 'object' ? payload : null;
}

function hideStartupSplash() {
  if (_startupSplashHidden || typeof document === 'undefined') return;
  const splash = document.getElementById('startupSplash');
  if (!splash) {
    _startupSplashHidden = true;
    return;
  }
  _startupSplashHidden = true;
  splash.classList.add('hidden');
  setTimeout(() => {
    try { splash.remove(); } catch (error) {}
  }, 260);
}
const _viewScrollState = {};
let _calculatorMemory = 0;
let _calculatorMode = 'DEG';
let _calculatorExpression = '';

function canUseNetworkSync() {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return false;
  // Honour the 503/quota cooldown set by fetchWithRetry — while the backend
  // is paused, nothing should attempt sync (polling, save() auto-push, the
  // explicit Sync button all check this gate).
  if (typeof isNetworkSyncPaused === 'function' && isNetworkSyncPaused()) return false;
  if (NETWORK_SYNC_CONFIG.apiBaseUrl) return /^https?:\/\//i.test(NETWORK_SYNC_CONFIG.apiBaseUrl);
  return /^https?:$/i.test(window.location.protocol || '');
}

function resolveNetworkSyncKeys(keys = []) {
  return [...new Set((Array.isArray(keys) ? keys : []).filter((key) => NETWORK_SYNC_KEYS.includes(key)))];
}

function markNetworkKeyDirty(key) {
  if (!NETWORK_SYNC_KEYS.includes(key)) return;
  dirtyNetworkKeys.add(key);
}

function clearNetworkKeyDirty(key) {
  dirtyNetworkKeys.delete(key);
}

// Manual-only sync: there are no background retry timers. Dirty keys just sit
// in `dirtyNetworkKeys` and get flushed on the next explicit "Sync Now" click.
// Kept as a no-op so the many existing call sites stay harmless.
function schedulePendingNetworkFlush() {
  if (networkSyncRetryTimer) { clearTimeout(networkSyncRetryTimer); networkSyncRetryTimer = null; }
}

function isQuotaExceededError(error) {
  if (!error) return false;
  const name = (error.name || '').toString().trim();
  const message = (error.message || '').toString().trim();
  const code = Number(error.code || 0);
  return name === 'QuotaExceededError' || code === 22 || /quota/i.test(message);
}

function getAppStateStorage() {
  if (typeof sessionStorage !== 'undefined') return sessionStorage;
  if (typeof localStorage !== 'undefined') return localStorage;
  return null;
}

function notifyStorageQuotaExceeded() {
  const now = Date.now();
  if ((now - lastStorageQuotaNoticeAt) < STORAGE_QUOTA_NOTICE_COOLDOWN_MS) return;
  lastStorageQuotaNoticeAt = now;
  showNotification('This device is low on storage — some data could not be saved. Clear old browsing data or use a different browser.', 'error', 9000);
}

async function flushPendingNetworkWrites(keys = [], options = {}) {
  if (!canUseNetworkSync()) return false;
  const explicitKeys = resolveNetworkSyncKeys(keys);
  const targetKeys = explicitKeys.length ? explicitKeys : resolveNetworkSyncKeys(Array.from(dirtyNetworkKeys));
  if (!targetKeys.length) return true;
  // Push every dirty key in parallel. Previously this loop awaited each PUT
  // serially, so saving a quiz on a 5-key dirty state stacked five round-trips
  // back-to-back. With parallel writes, total wall-time is bounded by the
  // slowest key, not the sum.
  const results = await Promise.all(targetKeys.map(async (key) => {
    if (pendingNetworkWritePromises.has(key)) {
      const completed = await pendingNetworkWritePromises.get(key).catch(() => false);
      if (completed && !dirtyNetworkKeys.has(key)) return true;
    }
    return pushNetworkValue(key, readLocalStorageValue(key), { skipRetrySchedule: true });
  }));
  const ok = results.every(Boolean);
  if (ok && options.pullAfter) await pullNetworkState(true);
  if (!ok && options.retryOnFailure !== false) schedulePendingNetworkFlush();
  return ok;
}

function writeLocalStorageValue(key, value) {
  if (key === STORAGE_KEYS.appState && skipAppStateStorageWritesForSession) return false;
  if (key === STORAGE_KEYS.appState) {
    const storage = getAppStateStorage();
    if (!storage) return false;
    try { storage[key] = JSON.stringify(value); return true; }
    catch(e) {
      if (isQuotaExceededError(e)) {
        skipAppStateStorageWritesForSession = true;
      }
      return false;
    }
  }
  try { localStorage[key] = JSON.stringify(value); return true; }
  catch(e) {
    if (isQuotaExceededError(e)) {
      console.warn(`Local storage write skipped for ${key} because the browser quota is full.`);
    }
    return false;
  }
}

function readLocalStorageValue(key) {
  if (key === STORAGE_KEYS.appState) {
    const storage = getAppStateStorage();
    if (!storage) return null;
    try { return JSON.parse(storage[key] || 'null'); }
    catch(e) { return null; }
  }
  try { return JSON.parse(localStorage[key] || 'null'); }
  catch(e) { return null; }
}

function getTeacherDisplayName(teacher = getCurrentTeacher(), options = {}) {
  const record = teacher && typeof teacher === 'object' ? teacher : {};
  const explicitName = (record.name || record.fullName || '').toString().trim();
  if (explicitName) return explicitName;
  if (options.preferPlaceholder) return 'Not set yet';
  const email = (record.email || record.teacherId || '').toString().trim();
  if (!email) return options.fallback || 'Teacher';
  const stem = email.split('@')[0].replace(/[._-]+/g, ' ').trim();
  if (!stem) return email;
  return stem.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getTeacherPhoneLabel(teacher = getCurrentTeacher(), options = {}) {
  const phone = (teacher?.phone || teacher?.phoneNumber || '').toString().trim();
  return phone || options.fallback || 'Not set yet';
}

function getTeacherAdminAccessSummary(teacher = {}) {
  const status = getTeacherLicenseStatus(teacher);
  if (status.pending) return 'Request pending';
  if (status.unlimited && status.active && !status.wrongDevice) return 'Unlimited active';
  if (status.unlimited && status.wrongDevice) return 'Unlimited on another device';
  if ((status.tokenBalance || 0) >= 1) return 'Tokens available';
  if (status.expired) return 'Unlimited ended';
  return status.label || 'No access';
}

function getTeacherUserBadgeLabel() {
  if (isSuperAdmin()) return `Admin: ${SUPER_ADMIN_EMAIL}`;
  if (!isTeacherLoggedIn()) return 'Guest';
  return `Teacher: ${getTeacherDisplayName(getCurrentTeacher())}`;
}

function getTeacherSignatureLabel(teacherId = state.teacherId) {
  const teacher = getTeacherById(teacherId) || getCurrentTeacher();
  return getTeacherDisplayName(teacher, { fallback: (teacher?.email || teacher?.teacherId || 'Teacher') });
}

function getQuizSubjectSummaries(quiz = {}) {
  return (quiz.subjects || []).map((subject, index) => ({
    name: (subject?.name || `Subject ${index + 1}`).toString().trim() || `Subject ${index + 1}`,
    questionCount: getQuestionCountForSubject(subject),
    totalMarks: getSubjectTotalMarks(subject)
  })).filter((item) => item.questionCount > 0 || item.totalMarks > 0 || item.name);
}

function captureViewScrollState(viewName = _lastRenderedView) {
  const key = (viewName || '').toString().trim();
  if (!key || typeof window === 'undefined' || typeof document === 'undefined') return null;
  const snapshot = {
    pageX: window.scrollX || 0,
    pageY: window.scrollY || window.pageYOffset || 0,
    containers: Array.from(document.querySelectorAll('[data-scroll-key]')).map((node) => ({
      key: node.dataset.scrollKey || '',
      left: node.scrollLeft || 0,
      top: node.scrollTop || 0
    })).filter((item) => item.key)
  };
  _viewScrollState[key] = snapshot;
  return snapshot;
}

function restoreViewScrollState(snapshot = null, options = {}) {
  const target = snapshot && typeof snapshot === 'object' ? snapshot : null;
  const forceTop = !!options.forceTop;
  const nextX = forceTop ? 0 : Number(target?.pageX || 0);
  const nextY = forceTop ? 0 : Number(target?.pageY || 0);
  requestAnimationFrame(() => {
    window.scrollTo({ left: nextX, top: nextY, behavior: 'auto' });
    if (!target || !Array.isArray(target.containers)) return;
    const currentContainers = Array.from(document.querySelectorAll('[data-scroll-key]'));
    target.containers.forEach((item) => {
      const node = currentContainers.find((entry) => (entry.dataset.scrollKey || '') === item.key);
      if (!node) return;
      node.scrollLeft = Number(item.left || 0);
      node.scrollTop = Number(item.top || 0);
    });
  });
}

function persistAppUiState() {
  if (typeof window === 'undefined' || state.view === 'take') return;
  const activeView = (_lastRenderedView || state.view || '').toString().trim();
  if (!activeView) return;
  const scroll = activeView === state.view
    ? (captureViewScrollState(activeView) || _viewScrollState[activeView] || null)
    : (_viewScrollState[state.view] || null);
  writeLocalStorageValue(STORAGE_KEYS.appState, {
    view: state.view,
    quizId: ['results', 'teacher.results'].includes(state.view) ? (state.currentQuiz?.id || '') : '',
    teacherGuideTopic: state.teacherGuideTopic || '',
    teacherId: state.teacherId || '',
    scroll,
    savedAt: new Date().toISOString()
  });
}

function hasStudentDeepLinkParams() {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search || '');
  return params.has('q') || params.has('import') || params.has('r') || (params.has('resultQuiz') && params.has('resultKey'));
}

function applyPersistedAppUiState() {
  const stored = readLocalStorageValue(STORAGE_KEYS.appState);
  if (!stored || typeof stored !== 'object') return false;
  const requestedView = stored.view && stored.view !== 'take' ? stored.view : state.view;
  if (requestedView) state.view = requestedView;
  state.teacherGuideTopic = stored.teacherGuideTopic || '';
  if (stored.quizId) {
    state.currentQuiz = getAllQuizzes()[stored.quizId] || null;
  }
  if (state.view === 'student' && !hasStudentDeepLinkParams() && !state.currentQuiz) {
    state.view = 'home';
  }
  if (state.view === 'student.result' && !hasStudentDeepLinkParams()) {
    state.view = 'home';
    state.pendingResultLookup = null;
    state.resultLinkUi = null;
  }
  if ((state.view || '').startsWith('teacher') && !isTeacherLoggedIn()) {
    state.currentQuiz = null;
    state.view = 'teacher.login';
  } else if (state.view === 'results' || state.view === 'teacher.results') {
    if (!state.currentQuiz) {
      state.view = isTeacherLoggedIn() ? 'teacher.quizzes' : 'home';
    } else if (!canCurrentTeacherAccessQuiz(state.currentQuiz)) {
      state.currentQuiz = null;
      state.view = isSuperAdmin() ? 'teacher' : 'teacher.quizzes';
    }
  }
  _pendingScrollRestore = requestedView === state.view ? (stored.scroll || null) : null;
  return true;
}

function syncOverlayBodyLock() {
  const locked = !!document.querySelector(
    '.student-result-modal,#createQuizModal,#analysisModal,#teacherAccess,#quizSetDetails,#licenseRequiredModal,#alertsPanel,#localNetGuide'
  );
  document.documentElement.style.overflow = locked ? 'hidden' : '';
  document.body.style.overflow = locked ? 'hidden' : '';
}

function startOverlayBodyLockObserver() {
  if (_overlayBodyLockObserver || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
  _overlayBodyLockObserver = new MutationObserver(() => syncOverlayBodyLock());
  _overlayBodyLockObserver.observe(document.body, { childList: true, subtree: true });
  syncOverlayBodyLock();
}

function refreshCurrentQuizReference() {
  if (!state.currentQuiz?.id) return;
  const refreshedQuiz = getAllStoredQuizzes()[state.currentQuiz.id] || null;
  state.currentQuiz = refreshedQuiz && !isDeletedQuiz(refreshedQuiz) ? refreshedQuiz : null;
}

function shouldDeferStudentSyncRerender() {
  if (state.view !== 'student' || typeof document === 'undefined') return false;
  const active = document.activeElement;
  if (!active) return false;
  if (['stuName', 'stuIdentity', 'stuAccess'].includes(active.id || '')) return true;
  return !!active.closest('.student-page');
}

function hydratePrefilledQuizFromAccess() {
  if (state.currentQuiz || !state.prefillQuizCode) return false;
  const quiz = resolveQuizFromAccess(parseQuizAccessInput(state.prefillQuizCode));
  if (!quiz) return false;
  state.currentQuiz = quiz;
  if (!state.view || state.view === 'home') state.view = 'student';
  return true;
}

function queueExamSubmissionFromSync(message) {
  if (state.view !== 'take' || !state.currentSubmission?.examStarted) return false;
  if (state.currentSubmission._networkSubmitQueued) return true;
  state.currentSubmission._networkSubmitQueued = true;
  showNotification(message, 'warning', 7000);
  setTimeout(() => collectAndSubmit(), 800);
  return true;
}

function handleActiveExamSyncState() {
  if (state.view !== 'take' || !state.currentSubmission?.examStarted) return false;
  const quizId = state.currentSubmission?.quizId || state.currentQuiz?.id || '';
  if (!quizId) return false;
  const latestQuiz = getAllStoredQuizzes()[quizId] || null;
  if (!latestQuiz || isDeletedQuiz(latestQuiz)) {
    return queueExamSubmissionFromSync('This quiz is no longer available. Your current attempt is being submitted now.');
  }
  state.currentQuiz = latestQuiz;
  const schedule = getQuizScheduleStatus(latestQuiz);
  if (!schedule.ok) {
    return queueExamSubmissionFromSync(`${schedule.message} Your current attempt is being submitted now.`);
  }
  return false;
}

function applySharedStateUiRefresh(changed = false, options = {}) {
  const hydratedPrefill = hydratePrefilledQuizFromAccess();
  if (changed || hydratedPrefill) refreshCurrentQuizReference();
  const examHandled = handleActiveExamSyncState();
  if (examHandled) return changed || hydratedPrefill;
  if (shouldDeferStudentSyncRerender()) return changed || hydratedPrefill;
  if (state.view !== 'take' && (changed || hydratedPrefill || options.forceRender) && !options.suppressRender) render();
  return changed || hydratedPrefill;
}

function buildHistoryUrlForState() {
  if (typeof window === 'undefined') return '';
  const url = new URL(window.location.href);
  if (!['student', 'take', 'student.result'].includes(state.view)) {
    return `${url.pathname}${url.hash || ''}`;
  }
  return `${url.pathname}${url.search}${url.hash || ''}`;
}

function clearStudentEntryContext() {
  state.currentQuiz = null;
  state.prefillQuizCode = '';
  state.pendingResultLookup = null;
  state.resultLinkUi = null;
}

function normalizeResultLinkRequest(request = {}) {
  if (!request || typeof request !== 'object') return null;
  return {
    shareKey: (request.shareKey || '').toString().trim(),
    quizId: (request.quizId || '').toString().trim(),
    submissionId: (request.submissionId || '').toString().trim(),
    downloadCorrection: !!request.downloadCorrection,
    correctionSubject: (request.correctionSubject || '').toString().trim()
  };
}

function buildResultLinkUiState(request = {}, overrides = {}) {
  const normalizedRequest = normalizeResultLinkRequest(request) || {
    shareKey: '',
    quizId: '',
    submissionId: '',
    downloadCorrection: false,
    correctionSubject: ''
  };
  const preparingCorrection = !!normalizedRequest.downloadCorrection;
  return {
    request: normalizedRequest,
    phase: 'loading',
    showSpinner: true,
    badge: preparingCorrection ? 'Preparing Correction PDF' : 'Opening Verified Result',
    title: preparingCorrection ? 'Your correction PDF is being prepared.' : 'Your verified result is loading.',
    copy: preparingCorrection
      ? 'Please wait. OPE Assessor is locating your submission and will start the correction PDF download automatically.'
      : 'Please wait. OPE Assessor is locating your verified result summary now.',
    subjectName: normalizedRequest.correctionSubject || '',
    ...overrides
  };
}

function setResultLinkUiState(request = {}, overrides = {}) {
  state.resultLinkUi = buildResultLinkUiState(request, overrides);
  return state.resultLinkUi;
}

function getActiveResultLinkRequest() {
  return normalizeResultLinkRequest(
    (state.resultLinkUi && state.resultLinkUi.request)
      || state.pendingResultLookup
      || null
  );
}

function closeStudentResultLanding(targetView = 'home') {
  clearStudentEntryContext();
  state.view = targetView;
  render();
}

function dismissStudentResultLanding() {
  try { window.close(); } catch (error) {}
  setTimeout(() => {
    if (state.view === 'student.result') closeStudentResultLanding('home');
  }, 160);
}

async function processPendingResultLinkRequest(request = {}) {
  const activeRequest = normalizeResultLinkRequest(request);
  if (!activeRequest) return null;
  setResultLinkUiState(activeRequest);
  if (canUseNetworkSync()) await pullSharedStateSilently({ forcePull: true, timeoutMs: 5000 });
  const openOptions = {
    autoDownloadCorrection: activeRequest.downloadCorrection,
    correctionSubject: activeRequest.correctionSubject || ''
  };
  if (activeRequest.downloadCorrection) {
    const submission = activeRequest.shareKey
      ? await openStudentCorrectionByShareKey(activeRequest.shareKey, openOptions)
      : await openStudentCorrectionBySubmissionKey(activeRequest.quizId, activeRequest.submissionId, openOptions);
    setResultLinkUiState(activeRequest, submission ? {
      phase: 'success',
      showSpinner: false,
      badge: 'Correction PDF Ready',
      title: 'Your correction PDF is ready.',
      copy: 'The correction PDF has been opened or downloaded. You can close this page now or open the verified result summary below.'
    } : {
      phase: 'error',
      showSpinner: false,
      badge: 'Correction Link Issue',
      title: 'We could not open this correction PDF yet.',
      copy: 'Please retry in a moment or close this page.'
    });
    if (state.view === 'student.result') render();
    return submission;
  }
  const submission = activeRequest.shareKey
    ? await showStudentResultModalByShareKey(activeRequest.shareKey, true, openOptions)
    : await showStudentResultModalBySubmissionKey(activeRequest.quizId, activeRequest.submissionId, true, openOptions);
  if (submission) {
    setResultLinkUiState(activeRequest, {
      phase: 'success',
      showSpinner: false,
      badge: 'Verified Result Ready',
      title: 'Your verified result is ready.',
      copy: 'You can review the verified result summary on this page and return home when you are done.'
    });
    if (state.view === 'student.result') render();
  } else {
    setResultLinkUiState(activeRequest, {
      phase: 'error',
      showSpinner: false,
      badge: 'Result Link Issue',
      title: 'We could not open this verified result yet.',
      copy: 'Please retry in a moment or close this page.'
    });
    if (state.view === 'student.result') render();
  }
  return submission;
}

async function runSharedSyncCycle(options = {}) {
  if (!canUseNetworkSync()) return false;
  await flushPendingNetworkWrites([], { pullAfter: false });
  const changed = await pullNetworkState(!!options.forcePull);
  return applySharedStateUiRefresh(changed, options);
}

function withTimeout(promise, timeoutMs = DEFAULT_STARTUP_SYNC_TIMEOUT_MS, fallbackValue = false) {
  const waitMs = Math.max(500, Number(timeoutMs) || DEFAULT_STARTUP_SYNC_TIMEOUT_MS);
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallbackValue), waitMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function explainNetworkSyncFailureMessage(message = '') {
  const text = (message || '').toString().trim();
  const lower = text.toLowerCase();
  const target = getCurrentSyncServerLabel();
  if (!text) return `Could not reach the shared sync server at ${target}.`;
  if (lower.includes('failed to fetch')) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return `Could not reach the shared sync server at ${target}. This device appears to be offline.`;
    }
    if (typeof window !== 'undefined' && window.location.protocol === 'https:' && /^http:\/\//i.test(NETWORK_SYNC_CONFIG.apiBaseUrl || '')) {
      return `Could not reach the shared sync server at ${target} because this page is HTTPS and the sync server URL is HTTP. Use an HTTPS sync server URL or open the full app from the same HTTP server.`;
    }
    return `Could not reach the shared sync server at ${target}. Open Settings > Cloud Sync, confirm the server URL, make sure the OPE Assessor Node server is running, and test ${buildApiUrl('/api/health')}.`;
  }
  if (lower.includes('unexpected token') || lower.includes('json')) {
    return `The address ${target} did not return the expected OPE Assessor API response. Point Cloud Sync to the Node server, not a static file host.`;
  }
  if (lower.includes('cors')) {
    return `The shared sync server at ${target} blocked this browser request. Allow the frontend origin on the server or use the same server URL for both app and API.`;
  }
  return text;
}

async function checkNetworkSyncHealth(options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 5000);
  if (!canUseNetworkSync()) {
    return {
      ok: false,
      target: getCurrentSyncServerLabel(),
      message: 'Cloud sync is not available in this browser session.'
    };
  }
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(buildApiUrl('/api/health'), {
      cache: 'no-store',
      signal: controller ? controller.signal : undefined
    });
    if (!response.ok) throw new Error(await readApiErrorMessage(response, 'Shared sync server is unavailable'));
    const payload = await response.json();
    if (!payload || payload.ok !== true) throw new Error('Shared sync server returned an invalid health response');
    // On serverless deployments, the file backend is impossible — only Supabase
    // (or another shared backend) can persist data across invocations. When the
    // health endpoint reports the backend isn't configured, fail loudly with
    // exactly what's missing so the user can fix their env vars.
    if (payload.runtime && payload.runtime !== 'node' && payload.supabaseConfigured === false) {
      throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your hosting env vars (then redeploy).');
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'pdfExportSupported')) {
      markServerPdfExportAvailability(payload.pdfExportSupported !== false);
    }
    if (options.captureFailure !== false) {
      networkSyncFailed = false;
      networkSyncFailureMessage = '';
      // Health-check success is enough to consider sync live — otherwise the UI
      // sits on "not active yet" until the first state PUT/GET, which can
      // confuse the user when no state op has been triggered yet.
      networkSyncReady = true;
    }
    return {
      ok: true,
      target: getCurrentSyncServerLabel(),
      payload,
      message: `Connected to ${getCurrentSyncServerLabel()}`
    };
  } catch (error) {
    const message = explainNetworkSyncFailureMessage(error && error.message ? error.message : 'Network sync unavailable');
    if (options.captureFailure !== false) {
      networkSyncFailed = true;
      networkSyncFailureMessage = message;
    }
    return {
      ok: false,
      target: getCurrentSyncServerLabel(),
      error,
      message
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function shouldHydrateSharedStateOnStartup(params = new URLSearchParams()) {
  if (!canUseNetworkSync()) return false;
  if (params.has('q') || params.has('import') || params.has('r') || (params.has('resultQuiz') && params.has('resultKey'))) return true;
  if (normalizeEmail(state.teacherId || getTeacherId())) return true;
  if (!Object.keys(getAllQuizzes()).length) return true;
  return Object.keys(getAllTeachers()).length <= 1;
}

async function pullSharedStateSilently(options = {}) {
  if (!canUseNetworkSync()) return false;
  await flushPendingNetworkWrites([], { pullAfter: false });
  const pullPromise = Promise.resolve(pullNetworkState(options.forcePull !== false));
  const timeoutToken = {};
  const result = await withTimeout(
    pullPromise,
    options.timeoutMs || DEFAULT_STARTUP_SYNC_TIMEOUT_MS,
    timeoutToken
  );
  if (result === timeoutToken) {
    if (options.forceRenderOnLate) {
      pullPromise
        .then((changed) => {
          if (changed) applySharedStateUiRefresh(true, { forceRender: true });
        })
        .catch(() => {});
    }
    return false;
  }
  return result;
}

async function hydrateSharedStateBeforeFirstRender(params = new URLSearchParams()) {
  if (!shouldHydrateSharedStateOnStartup(params)) return false;
  return pullSharedStateSilently({
    forcePull: true,
    timeoutMs: DEFAULT_STARTUP_SYNC_TIMEOUT_MS,
    forceRenderOnLate: !!normalizeEmail(state.teacherId || getTeacherId())
  });
}

async function openTeacherWorkspace(targetView = 'teacher', options = {}) {
  const sessionTeacherId = normalizeEmail(state.teacherId || getTeacherId());
  const shouldPullSharedState = options.pullSharedState !== false;
  if (sessionTeacherId && canUseNetworkSync() && shouldPullSharedState) {
    await pullSharedStateSilently({
      forcePull: options.forcePull !== false,
      timeoutMs: options.timeoutMs || DEFAULT_WORKSPACE_SYNC_TIMEOUT_MS,
      forceRenderOnLate: true
    });
  }
  state.view = isTeacherLoggedIn() ? targetView : 'teacher.login';
  render();
}

function bindNetworkSyncWindowEvents() {
  if (networkSyncEventsBound || typeof window === 'undefined') return;
  networkSyncEventsBound = true;
  // No focus / online / visibilitychange auto-sync — sync is manual-only.
  // We keep only the cross-tab `storage` listener so edits made in another tab
  // of THIS browser refresh the UI; that's a local read, not a network call.
  window.addEventListener('storage', (event) => {
    const changedKey = (event && event.key) || '';
    if (!changedKey || event.oldValue === event.newValue) return;
    if (changedKey === STORAGE_KEYS.appState) return;
    if (!NETWORK_SYNC_KEYS.includes(changedKey)) return;
    applySharedStateUiRefresh(true, { forceRender: true });
  });
}

function copyTextToClipboard(text, successMessage = 'Copied') {
  const value = (text || '').toString();
  const fallbackCopy = () => {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    Object.assign(ta.style, { position: 'fixed', left: '-10000px', top: '0' });
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('Copy command failed');
  };
  const done = () => { showNotification(successMessage, 'success'); return true; };
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(value).then(done).catch(() => {
      try { fallbackCopy(); return done(); } catch(e) { showNotification('Copy failed. Select and copy manually.', 'error'); return false; }
    });
  }
  try { fallbackCopy(); return Promise.resolve(done()); }
  catch(e) { showNotification('Copy failed. Select and copy manually.', 'error'); return Promise.resolve(false); }
}

function enhancePasswordFields(root = document) {
  root.querySelectorAll('input[type="password"]:not([data-password-toggle-ready])').forEach((input) => {
    input.dataset.passwordToggleReady = 'true';
    const wrapper = document.createElement('div');
    wrapper.className = 'password-field';
    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'password-toggle';
    btn.setAttribute('aria-label', 'Show password');
    btn.textContent = 'Show';
    btn.onclick = () => {
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.textContent = showing ? 'Show' : 'Hide';
      btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    };
    wrapper.appendChild(btn);
  });
}

function isMeaningfulQuestion(question) {
  if (!question || typeof question !== 'object') return false;
  const text = getRichTextPlainText(question.question || '').trim();
  if (!text) return false;
  const type = (question.type || 'mcq').toString().toLowerCase();
  if (type === 'mcq') {
    const options = Array.isArray(question.options)
      ? question.options.filter((opt) => getRichTextPlainText(opt || '').trim())
      : [];
    const answer = (question.answer || '').toString().trim();
    return options.length >= 2 && !!answer;
  }
  if (type === 'yesno') {
    return /^(yes|no)$/i.test((question.answer || '').toString().trim());
  }
  if (type === 'short') {
    const accepted = Array.isArray(question.acceptedAnswers) ? question.acceptedAnswers : [];
    return accepted.some((a) => (a || '').toString().trim());
  }
  if (type === 'essay') {
    // Essay needs only the question text — no answer required at authoring time.
    return true;
  }
  return false;
}

function isEmptySharedValue(value) {
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === 'object') return Object.keys(value).length === 0;
  return value == null;
}

function getRecordStamp(item) {
  const raw = item && (item.deletedAt || item.updatedAt || item.editedAt || item.shareKeyUpdatedAt || item.submittedAt || item.uploadedAt || item.tokenUpdatedAt || item.tokenRequestedAt || item.licenseUpdatedAt || item.licenseRequestedAt || item.idChangedAt || item.createdAt || item.startedAt);
  const stamp = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(stamp) ? stamp : 0;
}

function getTeacherAccessStamp(item = {}) {
  return Math.max(
    item?.licenseUpdatedAt ? new Date(item.licenseUpdatedAt).getTime() : 0,
    item?.tokenUpdatedAt ? new Date(item.tokenUpdatedAt).getTime() : 0,
    item?.tokenRequestedAt ? new Date(item.tokenRequestedAt).getTime() : 0
  );
}

function buildSubmissionIdentity(item, index = 0) {
  const quizId = item?.quizId || '';
  const email = (item?.email || '').toString().trim().toLowerCase();
  const stamp = item?.submittedAt || item?.startedAt || item?.createdAt || `idx-${index}`;
  return item?.submissionId || `${quizId}::${email}::${stamp}`;
}

function hashText(value = '') {
  let hash = 2166136261;
  const text = (value || '').toString();
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildSubmissionShareKeyCandidate(submission, salt = 0) {
  const identity = submission?.submissionId || buildSubmissionIdentity(submission);
  const hashPart = hashText(`${identity}|${salt}`).toString(36).slice(0, 6);
  const stampPart = (getRecordStamp(submission) || Date.now()).toString(36).slice(-4);
  return `${hashPart}${stampPart}`.toLowerCase();
}

function getSubmissionShareKey(submission, options = {}) {
  const persist = options.persist !== false;
  if (!submission || typeof submission !== 'object') return '';
  if (submission.shareKey) return submission.shareKey;
  const identity = submission.submissionId || buildSubmissionIdentity(submission);
  const existingKeys = new Set(
    getAllSubmissions({ includeDeleted: true })
      .filter((item) => (item.submissionId || buildSubmissionIdentity(item)) !== identity)
      .map((item) => item.shareKey)
      .filter(Boolean)
  );
  let attempt = 0;
  let shareKey = buildSubmissionShareKeyCandidate(submission, attempt);
  while (existingKeys.has(shareKey) && attempt < 64) {
    attempt += 1;
    shareKey = buildSubmissionShareKeyCandidate(submission, attempt);
  }
  submission.shareKey = shareKey;
  submission.shareKeyUpdatedAt = new Date().toISOString();
  if (!persist) return shareKey;
  const all = getAllSubmissions({ includeDeleted: true });
  const index = all.findIndex((item) => (item.submissionId || buildSubmissionIdentity(item)) === identity);
  if (index >= 0) {
    all[index] = {
      ...all[index],
      shareKey,
      shareKeyUpdatedAt: submission.shareKeyUpdatedAt
    };
    save(STORAGE_KEYS.submissions, all);
  }
  return shareKey;
}

function isDeletedSubmission(item) {
  return !!(item && item.deletedAt);
}

function isDeletedStudent(item) {
  return !!(item && item.deletedAt);
}

function isDeletedQuiz(item) {
  return !!(item && item.deletedAt);
}

function sortSubmissionRecords(left, right) {
  const leftStamp = new Date(left?.submittedAt || left?.updatedAt || left?.startedAt || 0).getTime();
  const rightStamp = new Date(right?.submittedAt || right?.updatedAt || right?.startedAt || 0).getTime();
  return leftStamp - rightStamp;
}

function mergeSubmissionRecordsForSync(primaryList = [], secondaryList = []) {
  const merged = new Map();
  const add = (item, index) => {
    if (!item || typeof item !== 'object') return;
    const normalized = item.submissionId ? item : { ...item, submissionId: buildSubmissionIdentity(item, index) };
    const key = normalized.submissionId || buildSubmissionIdentity(normalized, index);
    const current = merged.get(key);
    if (!current || getRecordStamp(normalized) >= getRecordStamp(current)) merged.set(key, normalized);
  };
  primaryList.forEach(add);
  secondaryList.forEach(add);
  return Array.from(merged.values()).sort(sortSubmissionRecords);
}

function sortTokenTransactions(left, right) {
  const leftStamp = new Date(left?.createdAt || left?.updatedAt || 0).getTime();
  const rightStamp = new Date(right?.createdAt || right?.updatedAt || 0).getTime();
  return leftStamp - rightStamp;
}

function mergeTokenTransactionsForSync(primaryList = [], secondaryList = []) {
  const merged = new Map();
  const add = (item, index) => {
    if (!item || typeof item !== 'object') return;
    const normalized = item.id ? item : { ...item, id: `txn_${Date.now().toString(36)}_${index}` };
    const key = normalized.id;
    const current = merged.get(key);
    if (!current || getRecordStamp(normalized) >= getRecordStamp(current)) merged.set(key, normalized);
  };
  primaryList.forEach(add);
  secondaryList.forEach(add);
  return Array.from(merged.values()).sort(sortTokenTransactions);
}

function confirmTeacherAction(message) {
  return window.confirm(message);
}

function normalizeClassName(value) {
  return (value || '').toString().trim();
}

function getTeacherClassNames(teacherId = state.teacherId) {
  const key = normalizeEmail(teacherId);
  const classes = new Set();
  getStudentsForTeacher(key).forEach((student) => {
    const className = normalizeClassName(student.className || student.class || '');
    if (className) classes.add(className);
  });
  return Array.from(classes).sort((left, right) => left.localeCompare(right));
}

function getQuizCalculatorType(quiz) {
  const raw = (quiz && quiz.calculatorType ? quiz.calculatorType : '').toString().trim().toLowerCase();
  if (raw === 'none' || raw === 'basic' || raw === 'scientific') return raw;
  return 'basic';
}

function getSupportSettings() {
  const admin = getAllTeachers()[normalizeEmail(SUPER_ADMIN_EMAIL)] || {};
  return {
    email: (admin.supportEmail || DEFAULT_SUPPORT_SETTINGS.email || ADMIN_CONTACT_EMAIL || '').toString().trim(),
    whatsapp: (admin.supportWhatsapp || DEFAULT_SUPPORT_SETTINGS.whatsapp || '').toString().trim()
  };
}

function formatNaira(value = 0) {
  const amount = Math.max(0, Number(value) || 0);
  return `₦${amount.toLocaleString('en-NG')}`;
}

function getTokenPackageCatalog() {
  return Object.values(TOKEN_PACKAGE_DEFINITIONS).map((item) => ({
    ...item,
    effectivePrice: item.tokens > 0 ? Math.round(item.price / item.tokens) : 0
  }));
}

function getTokenPackageByKey(packageKey = '') {
  return TOKEN_PACKAGE_DEFINITIONS[(packageKey || '').toString().trim().toLowerCase()] || null;
}

function formatLicensePlanLabel(planKey = '') {
  const tokenPackage = getTokenPackageByKey(planKey);
  return tokenPackage ? tokenPackage.label : 'Token Package';
}

function buildLicensePricingListMarkup() {
  return getTokenPackageCatalog().map((tokenPackage) => {
    if (tokenPackage.unlimitedDays) {
      return `<li><strong>${escapeHtml(tokenPackage.label)}</strong>: ${formatNaira(tokenPackage.price)} for ${tokenPackage.unlimitedDays} days on one registered device</li>`;
    }
    return `<li><strong>${escapeHtml(tokenPackage.label)}</strong>: ${tokenPackage.tokens} Token${tokenPackage.tokens === 1 ? '' : 's'} • ${formatNaira(tokenPackage.price)} • ${formatNaira(tokenPackage.effectivePrice)} per quiz</li>`;
  }).join('');
}

function getLicensePlanDurationDays(planKey = '') {
  const tokenPackage = getTokenPackageByKey(planKey);
  return tokenPackage && tokenPackage.unlimitedDays ? tokenPackage.unlimitedDays : 0;
}

function getTeacherTokenBalance(teacher = getCurrentTeacher()) {
  return Math.max(0, parseInt(teacher?.tokenBalance || 0, 10) || 0);
}

function getUnlimitedDaysLeft(teacher = getCurrentTeacher()) {
  const stamp = teacher?.unlimitedExpiresAt ? new Date(teacher.unlimitedExpiresAt).getTime() : 0;
  if (!stamp || Number.isNaN(stamp) || stamp <= Date.now()) return 0;
  return Math.max(1, Math.ceil((stamp - Date.now()) / (24 * 60 * 60 * 1000)));
}

function isUnlimitedActiveForTeacher(teacher = getCurrentTeacher()) {
  return getUnlimitedDaysLeft(teacher) > 0;
}

function isUnlimitedActiveOnCurrentDevice(teacher = getCurrentTeacher()) {
  if (!isUnlimitedActiveForTeacher(teacher)) return false;
  const expectedDeviceId = (teacher?.unlimitedDeviceId || '').toString().trim();
  return !expectedDeviceId || expectedDeviceId === getAppDeviceId();
}

function getTeacherPurchaseSummary(teacher = getCurrentTeacher()) {
  const tokenBalance = getTeacherTokenBalance(teacher);
  const unlimitedDays = getUnlimitedDaysLeft(teacher);
  if (unlimitedDays > 0 && isUnlimitedActiveOnCurrentDevice(teacher)) {
    return `Tokens: ${tokenBalance} | Unlimited: ${unlimitedDays} day${unlimitedDays === 1 ? '' : 's'} left`;
  }
  if (unlimitedDays > 0) {
    return `Tokens: ${tokenBalance} | Unlimited: active on another device`;
  }
  return `Tokens: ${tokenBalance}`;
}

function buildTokenTransaction(type, amount, description, extra = {}) {
  const userId = normalizeEmail(extra.userId || state.teacherId || '');
  const createdAt = extra.createdAt || new Date().toISOString();
  return {
    id: extra.id || `txn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    userId,
    type,
    amount,
    description,
    createdAt,
    updatedAt: extra.updatedAt || createdAt,
    packageKey: extra.packageKey || '',
    nairaAmount: Number(extra.nairaAmount || 0) || 0,
    quizId: extra.quizId || '',
    quizTitle: extra.quizTitle || '',
    deviceId: extra.deviceId || '',
    metadata: extra.metadata && typeof extra.metadata === 'object' ? { ...extra.metadata } : {}
  };
}

function appendTokenTransaction(transaction) {
  const current = getAllTokenTransactions();
  current.push(transaction);
  saveAllTokenTransactions(current);
  return transaction;
}

function getTeacherTokenTransactions(teacherId = state.teacherId) {
  const normalizedTeacherId = normalizeEmail(teacherId);
  return getAllTokenTransactions().filter((item) => normalizeEmail(item.userId) === normalizedTeacherId);
}

function buildTokenInsufficientMessage(teacher = getCurrentTeacher()) {
  const status = getTeacherLicenseStatus(teacher);
  return status.wrongDevice
    ? `Your unlimited plan is on another device. Use 1 Token ${formatNaira(TOKEN_PRICE_PER_QUIZ)} to continue here.`
    : `Insufficient Tokens. 1 Token = ${formatNaira(TOKEN_PRICE_PER_QUIZ)}. Buy Tokens.`;
}

function consumeTeacherAccessForQuizSave({ teacherId = state.teacherId, quizId = '', quizTitle = '', isEditingExisting = false } = {}) {
  const normalizedTeacherId = normalizeEmail(teacherId);
  if (!normalizedTeacherId) return { ok: false, message: 'Teacher account not found.' };
  if (normalizedTeacherId === SUPER_ADMIN_EMAIL) return { ok: true, mode: 'admin', remainingTokens: Number.MAX_SAFE_INTEGER };
  if (isEditingExisting) return { ok: true, mode: 'edit-existing', remainingTokens: getTeacherTokenBalance(getTeacherById(normalizedTeacherId)) };

  const teachers = getAllTeachers();
  const teacher = teachers[normalizedTeacherId];
  if (!teacher) return { ok: false, message: 'Teacher account not found.' };
  const now = new Date().toISOString();
  const deviceId = getAppDeviceId();

  if (isUnlimitedActiveOnCurrentDevice(teacher)) {
    teachers[normalizedTeacherId] = {
      ...teacher,
      tokenUpdatedAt: now,
      updatedAt: now
    };
    saveAllTeachers(teachers);
    appendTokenTransaction(buildTokenTransaction('unlimited_usage', 0, `Saved quiz "${quizTitle || quizId || 'Untitled Quiz'}" using active unlimited access.`, {
      userId: normalizedTeacherId,
      quizId,
      quizTitle,
      deviceId,
      createdAt: now
    }));
    return { ok: true, mode: 'unlimited', remainingTokens: getTeacherTokenBalance(teachers[normalizedTeacherId]) };
  }

  const currentBalance = getTeacherTokenBalance(teacher);
  if (currentBalance >= 1) {
    teachers[normalizedTeacherId] = {
      ...teacher,
      tokenBalance: currentBalance - 1,
      tokenUpdatedAt: now,
      updatedAt: now
    };
    saveAllTeachers(teachers);
    appendTokenTransaction(buildTokenTransaction('quiz_usage', -1, `Saved quiz "${quizTitle || quizId || 'Untitled Quiz'}".`, {
      userId: normalizedTeacherId,
      quizId,
      quizTitle,
      nairaAmount: TOKEN_PRICE_PER_QUIZ,
      deviceId,
      createdAt: now
    }));
    return { ok: true, mode: 'token', remainingTokens: currentBalance - 1 };
  }

  return { ok: false, message: buildTokenInsufficientMessage(teacher) };
}

function getTeacherOwnedQuizCount(teacherId = state.teacherId) {
  const ownerId = normalizeEmail(teacherId);
  return Object.values(getAllQuizzes() || {}).filter((quiz) => normalizeEmail(quiz.teacherId) === ownerId).length;
}

function getTeacherTrialStatus(teacher = getCurrentTeacher()) {
  if (!teacher) return { available: false, used: false, label: 'No teacher session' };
  return {
    available: false,
    used: true,
    usedAt: teacher.trialQuizUsedAt || '',
    label: 'No free tokens by default'
  };
}

function getTeacherLicenseGraceDeadline(teacher = getCurrentTeacher()) {
  return 0;
}

function getTeacherById(teacherId = '') {
  return getAllTeachers()[normalizeEmail(teacherId)] || null;
}

function canCurrentTeacherAccessQuiz(quiz = state.currentQuiz) {
  if (!quiz || typeof quiz !== 'object') return false;
  if (isSuperAdmin()) return true;
  return !!state.teacherId && normalizeEmail(quiz.teacherId) === normalizeEmail(state.teacherId);
}

function getQuizEffectiveEndTime(quiz) {
  if (!quiz) return 0;
  return quiz.scheduleEnd ? new Date(quiz.scheduleEnd).getTime() : 0;
}

function normalizeWhatsappNumber(value = '') {
  const digits = (value || '').toString().replace(/[^\d]/g, '');
  if (!digits) return '';
  return digits.startsWith('0') && digits.length > 10 ? `234${digits.slice(1)}` : digits;
}

function detectCorrectionContactChannel(value = '') {
  const raw = (value || '').toString().trim();
  if (!raw) return '';
  if (raw.includes('@')) return 'email';
  if (normalizeWhatsappNumber(raw)) return 'whatsapp';
  return '';
}

function getSubmissionCorrectionContact(submission = {}) {
  const storedValue = (submission.correctionContact || submission.contactValue || '').toString().trim();
  const storedChannel = (submission.correctionContactChannel || '').toString().trim();
  const fallbackEmail = (submission.email || '').includes('@') ? (submission.email || '').toString().trim() : '';
  const fallbackWhatsapp = normalizeWhatsappNumber(submission.whatsappNumber || '');
  const channel = storedChannel || detectCorrectionContactChannel(storedValue) || (fallbackWhatsapp ? 'whatsapp' : fallbackEmail ? 'email' : '');
  const email = channel === 'email'
    ? (storedValue || fallbackEmail)
    : fallbackEmail;
  const whatsapp = channel === 'whatsapp'
    ? normalizeWhatsappNumber(storedValue || fallbackWhatsapp)
    : fallbackWhatsapp;
  return {
    channel,
    email: (email || '').toString().trim(),
    whatsapp,
    label: channel === 'whatsapp' ? (whatsapp || 'No WhatsApp number') : (email || 'No email address')
  };
}

function getSubmissionIpAddress(submission = {}) {
  return (
    (submission?.monitoring && submission.monitoring.ipAddress)
    || submission?.ipAddress
    || ''
  ).toString().trim();
}

function normalizeSubjectName(value = '') {
  return (value || '').toString().trim().toLowerCase();
}

function getQuestionSubjectLabel(question = {}) {
  return (question._subject || question.subject || 'General').toString().trim() || 'General';
}

function buildCorrectionShareLinksText(quiz, submission) {
  const resultUrl = buildCertificateVerificationUrl(quiz, submission);
  // If the submission spans multiple subjects, provide one correction link per subject.
  try {
    const breakdown = (typeof computeSubmissionSubjectBreakdown === 'function')
      ? computeSubmissionSubjectBreakdown(quiz, submission || {})
      : [];
    if (Array.isArray(breakdown) && breakdown.length > 1) {
      const parts = ['Result Summary', resultUrl, '', 'Correction PDF'];
      breakdown.forEach((subject) => {
        const name = (subject && subject.name) ? subject.name.toString().trim() : '';
        if (!name) return;
        const normalized = normalizeSubjectName(name) || name.toLowerCase();
        const link = buildCertificateVerificationUrl(quiz, submission, { downloadCorrection: true, correctionSubject: normalized });
        parts.push(name);
        parts.push(link);
        parts.push('');
      });
      // remove trailing blank line
      if (parts[parts.length - 1] === '') parts.pop();
      return parts.join('\n');
    }
  } catch (e) {
    // fall back to single-link behavior on error
    console.warn('Could not build per-subject correction links', e);
  }
  const correctionUrl = buildCertificateVerificationUrl(quiz, submission, { downloadCorrection: true });
  return [
    'Result Summary',
    resultUrl,
    '',
    'Correction PDF',
    correctionUrl
  ].join('\n');
}

function buildCorrectionShareMessage(submission, quiz) {
  const requestLine = submission.correctionRequested
    ? `Requested at: ${submission.correctionRequestedAt ? new Date(submission.correctionRequestedAt).toLocaleString() : 'N/A'}`
    : '';
  // If multiple subjects exist, use pluralized message and include per-subject links.
  try {
    const breakdown = (typeof computeSubmissionSubjectBreakdown === 'function')
      ? computeSubmissionSubjectBreakdown(quiz, submission || {})
      : [];
    if (Array.isArray(breakdown) && breakdown.length > 1) {
      return [
        `Hi ${submission.name || 'Student'},`,
        '',
        'Your corrections are ready.',
        requestLine,
        '',
        buildCorrectionShareLinksText(quiz, submission),
        '',
        'Regards,',
        getTeacherSignatureLabel(quiz?.teacherId || state.teacherId)
      ].filter(Boolean).join('\n');
    }
  } catch (e) {
    console.warn('Could not determine subject breakdown for correction message', e);
  }
  return [
    `Hi ${submission.name || 'Student'},`,
    '',
    `Your correction for ${quiz.title || submission.quizId} is ready.`,
    requestLine,
    '',
    buildCorrectionShareLinksText(quiz, submission),
    '',
    'Regards,',
    getTeacherSignatureLabel(quiz?.teacherId || state.teacherId)
  ].filter(Boolean).join('\n');
}

function formatCorrectionActivityStamp(timestamp = '') {
  const time = timestamp ? new Date(timestamp).getTime() : 0;
  if (!time || Number.isNaN(time)) return '';
  return new Date(time).toLocaleString();
}

function getSubmissionCorrectionShareMeta(submission = {}) {
  const status = (submission.correctionStatus || '').toString().trim();
  if (status === 'whatsapp-shared') {
    return { label: 'WhatsApp sent', timestamp: submission.correctionWhatsappAt || '' };
  }
  if (status === 'whatsapp-opened') {
    return { label: 'WhatsApp opened', timestamp: submission.correctionWhatsappAt || '' };
  }
  if (status === 'emailed') {
    return { label: 'Email opened', timestamp: submission.correctionEmailedAt || '' };
  }
  if (status === 'downloaded') {
    return { label: 'PDF downloaded', timestamp: submission.correctionDownloadedAt || '' };
  }
  if (status === 'pending' || submission.correctionRequested) {
    return { label: 'Requested', timestamp: submission.correctionRequestedAt || '' };
  }
  if (submission.correctionDownloadedAt || submission._correctionDownloaded) {
    return { label: 'PDF downloaded', timestamp: submission.correctionDownloadedAt || '' };
  }
  return { label: 'No correction activity', timestamp: '' };
}

function isLikelyMobileDevice() {
  const ua = (navigator.userAgent || '').toLowerCase();
  return /android|iphone|ipad|ipod|mobile|windows phone/.test(ua);
}

function isStandaloneAppMode() {
  if (typeof window === 'undefined') return false;
  try {
    return !!(
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || window.navigator.standalone
    );
  } catch (error) {
    return false;
  }
}

function shouldShowInstallAppButton() {
  return typeof window !== 'undefined' && !isStandaloneAppMode();
}

function updateInstallAppButtons() {
  if (typeof document === 'undefined') return;
  const shouldShow = shouldShowInstallAppButton();
  document.querySelectorAll('[data-install-app-button]').forEach((button) => {
    button.onclick = () => { promptInstallApp(); };
    button.hidden = !shouldShow;
    button.style.display = shouldShow ? '' : 'none';
  });
}

function bindInstallPromptEvents() {
  if (installPromptEventsBound || typeof window === 'undefined') return;
  installPromptEventsBound = true;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    updateInstallAppButtons();
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    updateInstallAppButtons();
    showNotification('OPE Assessor installed on this device.', 'success', 5000);
  });
  if (window.matchMedia) {
    const media = window.matchMedia('(display-mode: standalone)');
    if (media && typeof media.addEventListener === 'function') {
      media.addEventListener('change', () => updateInstallAppButtons());
    }
  }
}

async function promptInstallApp() {
  if (isStandaloneAppMode()) {
    showNotification('OPE Assessor is already installed on this device.', 'info', 5000);
    return true;
  }
  const promptEvent = deferredInstallPrompt;
  if (!promptEvent) {
    showNotification(APP_INSTALL_HELP_MESSAGE, 'info', 9000);
    return false;
  }
  deferredInstallPrompt = null;
  try {
    await promptEvent.prompt();
    if (promptEvent.userChoice) await promptEvent.userChoice.catch(() => null);
  } catch (error) {
    showNotification(APP_INSTALL_HELP_MESSAGE, 'info', 9000);
    return false;
  } finally {
    updateInstallAppButtons();
  }
  return true;
}

function openWhatsappChat(phone, message = '') {
  const normalizedPhone = normalizeWhatsappNumber(phone);
  if (!normalizedPhone) return false;
  const encodedMessage = encodeURIComponent((message || '').toString());
  const nativeUrl = `whatsapp://send?phone=${normalizedPhone}&text=${encodedMessage}`;
  const webUrl = `https://wa.me/${normalizedPhone}?text=${encodedMessage}`;
  if (isLikelyMobileDevice()) {
    window.location.href = nativeUrl;
    setTimeout(() => {
      if (document.visibilityState !== 'hidden') window.open(webUrl, '_blank', 'noopener');
    }, 900);
    return true;
  }
  window.open(webUrl, '_blank', 'noopener');
  return true;
}

function openWhatsappShareIntent(message = '') {
  const encodedMessage = encodeURIComponent((message || '').toString());
  const nativeUrl = `whatsapp://send?text=${encodedMessage}`;
  const webUrl = `https://wa.me/?text=${encodedMessage}`;
  if (isLikelyMobileDevice()) {
    window.location.href = nativeUrl;
    setTimeout(() => {
      if (document.visibilityState !== 'hidden') window.open(webUrl, '_blank', 'noopener');
    }, 900);
    return true;
  }
  window.open(webUrl, '_blank', 'noopener');
  return true;
}

function saveSupportSettings(nextSettings = {}) {
  const teachers = getAllTeachers();
  const adminId = normalizeEmail(SUPER_ADMIN_EMAIL);
  teachers[adminId] = {
    ...(teachers[adminId] || {}),
    teacherId: adminId,
    email: adminId,
    role: 'super_admin',
    supportEmail: (nextSettings.email || '').toString().trim(),
    supportWhatsapp: (nextSettings.whatsapp || '').toString().trim(),
    createdAt: teachers[adminId]?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  saveAllTeachers(teachers);
}

function getStudentRecordKey(item, index = 0) {
  return normalizeEmail(item?.email || item?.registrationNo || item?.id || item?.name || `student-${index}`);
}

function mergeStudentListsForSync(localList = [], remoteList = []) {
  const merged = new Map();
  const add = (item, index) => {
    if (!item || typeof item !== 'object') return;
    const key = getStudentRecordKey(item, index);
    const current = merged.get(key);
    if (!current || getRecordStamp(item) >= getRecordStamp(current)) merged.set(key, item);
  };
  remoteList.forEach(add);
  localList.forEach(add);
  return Array.from(merged.values()).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

function mergeRecordMapForSync(localValue = {}, remoteValue = {}) {
  const merged = { ...(remoteValue || {}) };
  Object.keys(localValue || {}).forEach((key) => {
    const localItem = localValue[key];
    const remoteItem = remoteValue ? remoteValue[key] : undefined;
    if (Array.isArray(localItem) || Array.isArray(remoteItem)) {
      merged[key] = mergeStudentListsForSync(localItem || [], remoteItem || []);
      return;
    }
    if (!remoteItem || getRecordStamp(localItem) >= getRecordStamp(remoteItem)) merged[key] = localItem;
  });
  return merged;
}

function mergeTeacherRecord(localItem = {}, remoteItem = {}) {
  const localStamp = getRecordStamp(localItem);
  const remoteStamp = getRecordStamp(remoteItem);
  const base = remoteStamp >= localStamp ? { ...(localItem || {}), ...(remoteItem || {}) } : { ...(remoteItem || {}), ...(localItem || {}) };
  const localAccessStamp = getTeacherAccessStamp(localItem);
  const remoteAccessStamp = getTeacherAccessStamp(remoteItem);
  const accessSource = remoteAccessStamp >= localAccessStamp ? remoteItem : localItem;
  ['licenseEndsAt', 'licenseStopped', 'licenseRequestStatus', 'licenseUpdatedAt', 'tokenBalance', 'unlimitedExpiresAt', 'unlimitedDeviceId', 'tokenRequestStatus', 'tokenRequestedAt', 'tokenRequestedPackageKey', 'tokenRequestedAmount', 'tokenRequestedTokens', 'tokenRequestedDeviceId', 'lastUnlimitedDeviceTransferAt', 'tokenUpdatedAt'].forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(accessSource || {}, field)) base[field] = accessSource[field];
  });
  if (!base.role && normalizeEmail(base.teacherId || base.email) === SUPER_ADMIN_EMAIL) base.role = 'super_admin';
  return base;
}

function mergeTeacherMapForSync(localValue = {}, remoteValue = {}) {
  const merged = {};
  const keys = new Set([...Object.keys(remoteValue || {}), ...Object.keys(localValue || {})]);
  keys.forEach((key) => {
    merged[key] = mergeTeacherRecord(localValue ? localValue[key] : {}, remoteValue ? remoteValue[key] : {});
  });
  return merged;
}

function mergeSubmissionListsForSync(localList, remoteList) {
  return mergeSubmissionRecordsForSync(remoteList || [], localList || []);
}

function mergeSharedValue(storageKey, localValue, remoteValue) {
  if (storageKey === STORAGE_KEYS.submissions) {
    return mergeSubmissionListsForSync(localValue || [], remoteValue || []);
  }
  if (storageKey === STORAGE_KEYS.tokenTransactions) {
    return mergeTokenTransactionsForSync(remoteValue || [], localValue || []);
  }
  if (storageKey === STORAGE_KEYS.teachers) {
    return mergeTeacherMapForSync(localValue || {}, remoteValue || {});
  }
  if (storageKey === STORAGE_KEYS.quizzes || storageKey === STORAGE_KEYS.students) {
    return mergeRecordMapForSync(localValue || {}, remoteValue || {});
  }
  if (localValue && typeof localValue === 'object' && remoteValue && typeof remoteValue === 'object' && !Array.isArray(localValue) && !Array.isArray(remoteValue)) {
    return { ...remoteValue, ...localValue };
  }
  return isEmptySharedValue(remoteValue) && !isEmptySharedValue(localValue) ? localValue : remoteValue;
}

async function readApiErrorMessage(response, fallbackMessage = 'Request failed') {
  try {
    const payload = await response.json();
    if (payload && payload.error) return payload.error;
  } catch (error) {}
  try {
    const text = await response.text();
    if (text && text.trim()) return text.trim();
  } catch (error) {}
  return fallbackMessage;
}

function applyNetworkSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  let changed = false;
  const cloudSyncedQuizIds = [];
  NETWORK_SYNC_KEYS.forEach((storageKey) => {
    const stateKey = NETWORK_STATE_KEY_MAP[storageKey];
    if (!stateKey || pendingNetworkWrites.has(storageKey)) return;
    const localValue = readLocalStorageValue(storageKey);
    const remoteValue = snapshot[stateKey];
    const mergedValue = mergeSharedValue(storageKey, localValue, remoteValue);
    const localText = JSON.stringify(localValue);
    const mergedText = JSON.stringify(mergedValue);
    const remoteText = JSON.stringify(remoteValue);
    if (mergedText !== localText) changed = true;
    writeLocalStorageValue(storageKey, mergedValue);
    if (mergedText !== remoteText) {
      markNetworkKeyDirty(storageKey);
      pushNetworkValue(storageKey, mergedValue);
    }
    // Per-quiz "Cloud synced" marker. Any quiz the cloud already has, and whose
    // local copy isn't newer than the cloud's, is by definition up to date — so
    // it should read "Cloud synced", not "Sync to Cloud". Only quizzes the
    // teacher actually edited locally (local copy newer than the cloud's) stay
    // "Pending cloud sync". Without this, a quiz pulled fresh from the cloud has
    // no cloudSyncedAt locally and wrongly shows "Sync to Cloud" forever.
    if (storageKey === STORAGE_KEYS.quizzes && remoteValue && typeof remoteValue === 'object' && mergedValue && typeof mergedValue === 'object') {
      Object.keys(remoteValue).forEach((quizId) => {
        const remoteQuiz = remoteValue[quizId];
        const mergedQuiz = mergedValue[quizId];
        if (!remoteQuiz || !mergedQuiz) return;
        if (getRecordStamp(mergedQuiz) <= getRecordStamp(remoteQuiz)) cloudSyncedQuizIds.push(quizId);
      });
    }
  });
  if (cloudSyncedQuizIds.length && markQuizzesCloudSynced(cloudSyncedQuizIds)) changed = true;
  return changed;
}

// Hard cap on a single sync HTTP call so a stuck serverless cold-start or a
// silently-dropped TLS connection can't hang forever. Generous enough for a
// fat quiz upload (embedded images, gzipped) or a full /api/state pull over a
// slow mobile connection — 12s was tripping the abort mid-upload.
const NETWORK_SYNC_REQUEST_TIMEOUT_MS = 30000;
// Upper bound for a single PUT body. Cloudflare Pages Functions accept much
// larger bodies than Vercel's old ~4.5 MB cap, and Supabase's jsonb columns can
// hold far more, so 8 MB gives image-heavy quizzes (after the on-sync image
// shrink pass) plenty of room. Anything past this returns a clear "too large"
// message telling the teacher to trim embedded images.
const NETWORK_SYNC_MAX_BODY_BYTES = 8 * 1024 * 1024;

// Gzip a JSON string with the browser's native CompressionStream so the
// per-quiz PUT bodies (often 1–2 MB of JSON with embedded base64 images)
// upload at ~30–60% of their wire size. Returns the original string on
// browsers without CompressionStream (Safari < 16.4) so the call site can
// always fall through to an uncompressed PUT.
async function gzipBodyIfPossible(jsonText) {
  if (typeof jsonText !== 'string' || !jsonText.length) {
    return { body: jsonText, encoding: '' };
  }
  if (typeof window === 'undefined' || typeof window.CompressionStream !== 'function' || typeof Blob !== 'function' || typeof Response !== 'function') {
    return { body: jsonText, encoding: '' };
  }
  try {
    const stream = new Blob([jsonText]).stream().pipeThrough(new window.CompressionStream('gzip'));
    const compressed = await new Response(stream).arrayBuffer();
    // Skip the encoded body if it's somehow larger than the source — only
    // happens on tiny payloads where the gzip header dominates.
    if (compressed.byteLength >= jsonText.length) {
      return { body: jsonText, encoding: '' };
    }
    return { body: compressed, encoding: 'gzip' };
  } catch (err) {
    return { body: jsonText, encoding: '' };
  }
}

function makeAbortableSyncFetch(url, options = {}, timeoutMs = NETWORK_SYNC_REQUEST_TIMEOUT_MS) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), Math.max(2000, timeoutMs)) : null;
  const finalOptions = controller ? { ...options, signal: controller.signal } : options;
  const fetchPromise = fetch(url, finalOptions);
  if (timer) {
    // Clear the timeout when the fetch settles. Use a then() with BOTH handlers
    // (success + failure) so this cleanup branch handles its own rejection — a
    // bare .finally() here left a dangling rejected promise on abort, which
    // surfaced as "Uncaught (in promise) AbortError". The real rejection is
    // still delivered to the caller through the returned `fetchPromise`.
    fetchPromise.then(() => clearTimeout(timer), () => clearTimeout(timer));
  }
  return fetchPromise;
}

// Sync is manual-only now, so there is no automatic "cooldown" — after a sync
// fails its bounded retries we simply wait for the next "Sync Now" click. These
// constants are kept (NETWORK_SYNC_MAX_RETRIES drives fetchWithRetry's cap) and
// networkSyncPausedUntil stays 0 so the remaining isNetworkSyncPaused() call
// sites are harmless no-ops.
const NETWORK_SYNC_PAUSE_DURATION_MS = 5 * 60 * 1000;
const NETWORK_SYNC_RETRY_DELAY_MS = 20000;
const NETWORK_SYNC_MAX_RETRIES = 4;
let networkSyncPausedUntil = 0;

function isNetworkSyncPaused() {
  return networkSyncPausedUntil > Date.now();
}

function setNetworkSyncPaused(reason) {
  // No automatic cooldown anymore — sync is manual, so after a failure we just
  // record it and wait for the next "Sync Now" click. (networkSyncPausedUntil
  // is left at 0 so the remaining isNetworkSyncPaused() call sites are inert.)
  networkSyncFailed = true;
  networkSyncFailureMessage = reason || 'Cloud sync is paused.';
  // Only toast when the teacher explicitly asked for a sync. A background read
  // hitting a 503 must stay silent.
  if (userInitiatedSync && typeof showNotification === 'function') {
    showNotification(`${networkSyncFailureMessage} Click Sync Now to try again.`, 'warning', 9000);
  }
}

// Retry wrapper for a single sync request. One immediate try, then up to
// NETWORK_SYNC_MAX_RETRIES (4) retries with exponential backoff: 2s, 4s, 8s,
// 16s. After the cap we STOP — no cooldown, no background retry — and throw so
// the caller can surface the error once and wait for the next "Sync Now" click.
//   - AbortError (timeout): don't retry (caller moved on / request truly hung).
//   - 402 / 429 / 5xx: transient backend — retry with backoff, then give up.
//   - Other non-OK: retry with backoff, then return the response to the caller.
function syncRetryDelayMs(attempt) {
  return Math.pow(2, attempt) * 1000; // attempt 0 -> 2s, 1 -> 4s, 2 -> 8s, 3 -> 16s
}

async function fetchWithRetry(url, options = {}, attempt = 0) {
  const MAX_RETRIES = NETWORK_SYNC_MAX_RETRIES;
  let res;
  try {
    res = await makeAbortableSyncFetch(url, options);
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    if (attempt < MAX_RETRIES) {
      const delay = syncRetryDelayMs(attempt);
      console.log(`Sync request failed (${err && err.message ? err.message : 'network error'}). Retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw err;
  }
  if (res.status === 402 || res.status === 429 || res.status >= 500) {
    if (attempt < MAX_RETRIES) {
      const delay = syncRetryDelayMs(attempt);
      console.log(`Sync got ${res.status}. Retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return fetchWithRetry(url, options, attempt + 1);
    }
    setNetworkSyncPaused(`Cloud sync failed after ${MAX_RETRIES + 1} attempts (backend returned ${res.status}).`);
    const err = new Error(`Cloud sync failed (backend returned ${res.status}). Click Sync Now to try again.`);
    err.code = 'sync-paused';
    err.status = res.status;
    throw err;
  }
  if (!res.ok && attempt < MAX_RETRIES) {
    const delay = syncRetryDelayMs(attempt);
    console.log(`Sync got ${res.status}. Retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
    await new Promise((resolve) => setTimeout(resolve, delay));
    return fetchWithRetry(url, options, attempt + 1);
  }
  return res;
}

// Used by the automatic (non-button) sync paths — a student finishing a quiz,
// the per-quiz push after an edit. One immediate attempt, then ONE retry after
// 2s if the first fails (network error / timeout / 402 / 429 / 5xx). After that
// it gives up: the data stays local and the teacher's manual "Sync To Cloud" /
// "Force Sync Now" is the recovery path. No further retries, no cooldown, no
// background timer.
const AUTO_SYNC_RETRY_DELAY_MS = 2000;
async function autoSyncFetch(url, options) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, AUTO_SYNC_RETRY_DELAY_MS));
    try {
      const res = await makeAbortableSyncFetch(url, options);
      // Transient backend states are worth the one retry; anything else
      // (success, 4xx, etc.) is returned to the caller as-is.
      if ((res.status === 402 || res.status === 429 || res.status >= 500) && attempt === 0) {
        console.log(`Auto-sync got ${res.status}. Retrying once in ${AUTO_SYNC_RETRY_DELAY_MS}ms`);
        continue;
      }
      return res;
    } catch (err) {
      if (attempt === 1) throw err;
      console.log(`Auto-sync request failed (${err && err.message ? err.message : 'network error'}). Retrying once in ${AUTO_SYNC_RETRY_DELAY_MS}ms`);
    }
  }
}

async function pullNetworkState(force = false) {
  if (!canUseNetworkSync()) return false;
  // The bulk read returns password hashes, student PII, and quiz answer
  // keys, so the server now requires a valid session. Skip the request
  // entirely if we don't have a token rather than waste a round-trip on a
  // guaranteed 401 (e.g., the student-only print routes).
  if (!getAuthSessionToken()) return false;
  if (networkSyncInFlight && !force) return networkSyncInFlight;
  networkSyncInFlight = makeAbortableSyncFetch(buildApiUrl('/api/state'), {
    cache: 'no-store',
    headers: withAuthHeader({})
  })
    .then(async (res) => {
      if (res.status === 402 || res.status === 429 || res.status === 503) {
        // Backend paused — arm the cooldown so the 15s polling loop and any
        // pending writes stop hammering. The next teacher action will surface
        // the "paused" notification through fetchWithRetry.
        setNetworkSyncPaused(`Cloud sync is paused (backend returned ${res.status}).`);
        throw new Error('Cloud sync paused. Wait a few minutes, then try again.');
      }
      if (!res.ok) throw new Error(await readApiErrorMessage(res, 'Network sync unavailable'));
      const snapshot = await res.json();
      const changed = applyNetworkSnapshot(snapshot);
      networkSyncReady = true;
      networkSyncFailed = false;
      networkSyncFailureMessage = '';
      lastNetworkPullAt = Date.now();
      return changed;
    })
    .catch((error) => {
      networkSyncFailed = true;
      const reason = error && error.name === 'AbortError'
        ? `Cloud sync timed out after ${Math.round(NETWORK_SYNC_REQUEST_TIMEOUT_MS / 1000)}s. The server is slow or unreachable.`
        : (error && error.message ? error.message : 'Network sync unavailable');
      networkSyncFailureMessage = explainNetworkSyncFailureMessage(reason);
      return false;
    })
    .finally(() => { networkSyncInFlight = null; });
  return networkSyncInFlight;
}

// Bulk per-key state push (teachers / students / tokenTransactions, plus the
// anonymous-student `submissions` path). This is an automatic write driven by
// save() — so it makes exactly ONE attempt, no retry loop, no cooldown. If it
// fails the key stays in dirtyNetworkKeys and uploads on the next manual
// "Force Sync Now" click. Skips entirely when the browser reports it's offline.
async function pushNetworkValue(key, value, options = {}) {
  if (!canUseNetworkSync() || !NETWORK_STATE_KEY_MAP[key]) return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) { markNetworkKeyDirty(key); return false; }
  // The server requires an auth session for every state key except `submissions`.
  // If we have no token yet (anonymous page load, student-only flow, etc.), mark
  // the key dirty so it'll be re-attempted after a successful login, and skip
  // the actual PUT to avoid noisy 401 responses on the wire.
  const stateKey = NETWORK_STATE_KEY_MAP[key];
  if (stateKey !== 'submissions' && !getAuthSessionToken()) {
    markNetworkKeyDirty(key);
    networkSyncFailed = true;
    networkSyncFailureMessage = 'Cloud sync paused: your teacher session expired. Log out and log back in to push your saved changes.';
    return false;
  }
  if (stateKey === 'teachers' && !isSuperAdmin()) {
    const selfPayload = buildTeacherSelfSyncPayload(value);
    if (!selfPayload) {
      clearNetworkKeyDirty(key);
      return true;
    }
    value = selfPayload;
  }
  // Quizzes are exclusively per-quiz synced through /api/quizzes/<id> now.
  // Bulk PUT /api/state/quizzes was uploading the entire quizzes map
  // (1.5–2 MB with embedded images) on every save() auto-push, every poll
  // cycle catch-up, every applyNetworkSnapshot drift push, and every Force
  // Sync Now click — that was the 15GB-egress culprit. Treat the bulk PUT
  // as a no-op so legacy callers don't fire it; clear the dirty flag so the
  // polling loop doesn't keep re-scheduling. Anything that genuinely needs
  // the cloud updated calls pushSingleQuizToCloud(quiz) explicitly.
  if (stateKey === 'quizzes') {
    clearNetworkKeyDirty(key);
    return true;
  }
  // Submissions on a TEACHER session also go per-quiz now via
  // PUT /api/quizzes/<id> with { submissions: [...] }. Regrade and
  // delete-submission flows call pushSingleQuizSubmissionsToCloud
  // explicitly. Anonymous student-submit still uses the bulk PUT below
  // because the public endpoint is the only path students have.
  if (stateKey === 'submissions' && getAuthSessionToken()) {
    clearNetworkKeyDirty(key);
    return true;
  }
  if (pendingNetworkWrites.has(key)) {
    markNetworkKeyDirty(key);
    if (!options.skipRetrySchedule) schedulePendingNetworkFlush();
    return false;
  }
  // Pre-flight body-size check. A single oversized PUT (e.g. all quizzes
  // including base64 images) hits Vercel's 4.5 MB JSON limit and the server
  // either drops the connection or returns 413. Without this check the user
  // sees a generic "Saved locally, will upload" banner that never clears.
  let body;
  try { body = JSON.stringify({ value }); }
  catch (err) {
    networkSyncFailed = true;
    networkSyncFailureMessage = `Could not serialize ${key} for upload: ${err && err.message ? err.message : 'unknown error'}`;
    markNetworkKeyDirty(key);
    return false;
  }
  if (body.length > NETWORK_SYNC_MAX_BODY_BYTES) {
    networkSyncFailed = true;
    networkSyncFailureMessage = `Cannot upload ${key}: payload is ${(body.length / 1024 / 1024).toFixed(2)} MB which exceeds the ${(NETWORK_SYNC_MAX_BODY_BYTES / 1024 / 1024).toFixed(0)} MB cloud limit. Remove embedded images or split the data, then try again.`;
    markNetworkKeyDirty(key);
    console.error('Network sync skipped — payload too large for', key, body.length);
    return false;
  }
  pendingNetworkWrites.add(key);
  const writePromise = (async () => {
    try {
      // One attempt + one retry after 2s (autoSyncFetch). Important for the
      // anonymous student-submit path: their answers ride this PUT, so a single
      // flaky request shouldn't strand the result. If both attempts fail the
      // key stays dirty for the next manual "Force Sync Now".
      const res = await autoSyncFetch(buildApiUrl(`/api/state/${encodeURIComponent(NETWORK_STATE_KEY_MAP[key])}`), {
        method: 'PUT',
        headers: withAuthHeader({ 'Content-Type': 'application/json' }),
        body
      });
      if (res.status === 401) {
        networkSyncFailed = true;
        networkSyncFailureMessage = 'Cloud sync rejected: your teacher session is no longer valid. Log out and log back in to retry.';
        markNetworkKeyDirty(key);
        return false;
      }
      if (res.status === 402 || res.status === 429 || res.status >= 500) {
        // Backend paused / throttled — leave it dirty, no toast (this is an
        // automatic write; setNetworkSyncPaused only toasts on a user click).
        setNetworkSyncPaused(`Cloud sync is paused (backend returned ${res.status}).`);
        markNetworkKeyDirty(key);
        return false;
      }
      if (!res.ok) throw new Error(await readApiErrorMessage(res, 'Failed to save shared state'));
      networkSyncReady = true;
      networkSyncFailed = false;
      networkSyncFailureMessage = '';
      const latestValue = (stateKey === 'teachers' && !isSuperAdmin())
        ? buildTeacherSelfSyncPayload(readLocalStorageValue(key) || {})
        : readLocalStorageValue(key);
      if (JSON.stringify(latestValue) === JSON.stringify(value)) {
        clearNetworkKeyDirty(key);
      } else {
        markNetworkKeyDirty(key);
        schedulePendingNetworkFlush(300);
      }
      return true;
    } catch (err) {
      networkSyncFailed = true;
      const reason = err && err.name === 'AbortError'
        ? `Upload of ${key} timed out after ${Math.round(NETWORK_SYNC_REQUEST_TIMEOUT_MS / 1000)}s. The cloud server is slow or unreachable — try Force Sync Now in Settings.`
        : (err && err.message ? err.message : 'Failed to save shared state');
      networkSyncFailureMessage = explainNetworkSyncFailureMessage(reason);
      markNetworkKeyDirty(key);
      console.error('Network sync save failed for', key, err);
      if (!options.skipRetrySchedule) schedulePendingNetworkFlush();
      return false;
    } finally {
      pendingNetworkWrites.delete(key);
      pendingNetworkWritePromises.delete(key);
    }
  })();
  pendingNetworkWritePromises.set(key, writePromise);
  return writePromise;
}

function isSharedSyncAvailable() {
  return canUseNetworkSync() && networkSyncReady;
}

function getSharedSyncWarningMessage() {
  if (!canUseNetworkSync()) {
    return 'Not connected to the OPE Assessor server. Open Settings > Cloud Sync to set the server URL.';
  }
  if (networkSyncFailureMessage) {
    return networkSyncFailureMessage;
  }
  if (!getAuthSessionToken()) {
    return 'Log in as a teacher first — cloud upload requires an active session.';
  }
  // Sync hasn't completed yet but no error was captured. Tell the user it's in
  // progress instead of leaving them with a vague "not active" message.
  return `Syncing with ${getCurrentSyncServerLabel()}… your changes are saved locally and will upload momentarily.`;
}

async function syncSharedKeys(keys = []) {
  if (!canUseNetworkSync()) return false;
  const targetKeys = resolveNetworkSyncKeys(keys);
  if (!targetKeys.length) return isSharedSyncAvailable();
  targetKeys.forEach(markNetworkKeyDirty);
  return flushPendingNetworkWrites(targetKeys, { pullAfter: true });
}

// Per-quiz cloud save. Writes a single row through /api/quizzes/<id> so a single
// edited quiz never triggers a full /api/state/quizzes upload (which can blow
// past Vercel's 4.5 MB JSON limit when quizzes embed images). The bulk path is
// still the reconciler-of-last-resort and continues to run on the polling loop.
// options.auto: this is an automatic per-quiz push fired right after an edit /
// submit (not a user clicking a Sync button). In that mode we make exactly ONE
// attempt — no fetchWithRetry backoff loop — and we skip entirely when the
// browser reports it's offline. On failure the quiz simply stays "Pending cloud
// sync" so the per-quiz "Sync To Cloud" button is the recovery path; no banner.
async function pushSingleQuizToCloud(quiz, options = {}) {
  if (!quiz || !quiz.id) return false;
  if (!canUseNetworkSync()) return false;
  if (options.auto && typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  if (!getAuthSessionToken()) {
    if (!options.auto) {
      networkSyncFailed = true;
      networkSyncFailureMessage = 'Cloud sync paused: log out and log back in to push your saved changes.';
    }
    return false;
  }
  // Stamp the current teacher as the owner if the quiz doesn't already carry
  // one. Without this, an imported quiz (or one created under an older flow)
  // lands in Supabase with an empty teacher_id column — and the bulk
  // /api/state read filters submissions by the teacher's owned quiz_ids, so the
  // teacher would never see that quiz's results. Persist the owner locally too
  // so subsequent reads / pushes keep it.
  const sessionEmail = normalizeEmail(state.teacherId || getTeacherId());
  if (!normalizeEmail(quiz.teacherId || '') && sessionEmail) {
    quiz = { ...quiz, teacherId: sessionEmail };
    try {
      const storedQuizzes = getAllStoredQuizzes();
      if (storedQuizzes && storedQuizzes[quiz.id]) {
        storedQuizzes[quiz.id] = { ...storedQuizzes[quiz.id], teacherId: sessionEmail };
        saveAllQuizzes(storedQuizzes, { skipNetworkSync: true });
      }
      if (state.currentQuiz && state.currentQuiz.id === quiz.id) state.currentQuiz = { ...state.currentQuiz, teacherId: sessionEmail };
    } catch (e) {}
  }
  // Shrink any oversized embedded images first so an image-heavy quiz uploads
  // fast and stays under the body limit. If anything actually shrank, persist
  // the slimmer copy locally too (no updatedAt bump — same content, smaller
  // pixels) so we don't re-do this work on every sync and localStorage stays
  // lean. Best-effort: on any failure we just push what we have.
  try {
    const slimmed = await shrinkQuizMediaForSync(quiz);
    if (slimmed && slimmed !== quiz) {
      quiz = slimmed;
      const storedQuizzes = getAllStoredQuizzes();
      if (storedQuizzes && storedQuizzes[quiz.id]) {
        storedQuizzes[quiz.id] = { ...storedQuizzes[quiz.id], subjects: quiz.subjects };
        saveAllQuizzes(storedQuizzes, { skipNetworkSync: true });
      }
      if (state.currentQuiz && state.currentQuiz.id === quiz.id) state.currentQuiz = { ...state.currentQuiz, subjects: quiz.subjects };
    }
  } catch (e) { /* push the original quiz if shrinking failed */ }
  let body;
  try { body = JSON.stringify(quiz); }
  catch (err) {
    networkSyncFailed = true;
    networkSyncFailureMessage = `Could not serialize quiz ${quiz.id} for upload: ${err && err.message ? err.message : 'unknown error'}`;
    return false;
  }
  if (body.length > NETWORK_SYNC_MAX_BODY_BYTES) {
    networkSyncFailed = true;
    networkSyncFailureMessage = `Cannot upload quiz ${quiz.id}: payload is ${(body.length / 1024 / 1024).toFixed(2)} MB which exceeds the ${(NETWORK_SYNC_MAX_BODY_BYTES / 1024 / 1024).toFixed(0)} MB cloud limit. Remove embedded images, then try again.`;
    return false;
  }
  try {
    const compressed = await gzipBodyIfPossible(body);
    const headers = withAuthHeader({ 'Content-Type': 'application/json' });
    if (compressed.encoding) headers['Content-Encoding'] = compressed.encoding;
    const requestOptions = { method: 'PUT', headers, body: compressed.body };
    const url = buildApiUrl(`/api/quizzes/${encodeURIComponent(quiz.id)}`);
    // auto = one shot (makeAbortableSyncFetch); manual = fetchWithRetry's
    // 1+4 attempts with 2s/4s/8s/16s backoff.
    const res = options.auto
      ? await autoSyncFetch(url, requestOptions)
      : await fetchWithRetry(url, requestOptions);
    if (res.status === 401) {
      if (!options.auto) {
        networkSyncFailed = true;
        networkSyncFailureMessage = 'Cloud sync rejected: your teacher session is no longer valid. Log out and log back in to retry.';
      }
      return false;
    }
    if (!res.ok) {
      if (options.auto) {
        console.warn('Auto-sync of quiz', quiz.id, 'failed:', res.status);
      } else {
        networkSyncFailed = true;
        networkSyncFailureMessage = explainNetworkSyncFailureMessage(await readApiErrorMessage(res, 'Failed to save quiz'));
      }
      return false;
    }
    let payload = null;
    try { payload = await res.json(); } catch (error) {}
    networkSyncReady = true;
    networkSyncFailed = false;
    networkSyncFailureMessage = '';
    const syncedAt = (payload && payload.syncedAt) || new Date().toISOString();
    markQuizzesCloudSynced([quiz.id], syncedAt);
    return true;
  } catch (err) {
    if (options.auto) {
      console.warn('Auto-sync of quiz', quiz.id, 'failed:', err && err.message ? err.message : err);
      return false;
    }
    networkSyncFailed = true;
    let reason;
    if (err && err.code === 'sync-paused') {
      reason = err.message || 'Cloud sync paused.';
    } else if (err && err.name === 'AbortError') {
      reason = `Upload of quiz ${quiz.id} timed out after ${Math.round(NETWORK_SYNC_REQUEST_TIMEOUT_MS / 1000)}s. The cloud server is slow or unreachable.`;
    } else {
      reason = (err && err.message) ? err.message : 'Failed to save quiz';
    }
    networkSyncFailureMessage = explainNetworkSyncFailureMessage(reason);
    console.error('Per-quiz sync failed for', quiz.id, err);
    return false;
  }
}

// Push the submissions for a single quiz through PUT /api/quizzes/<id>.
// Replaces the old bulk PUT /api/state/submissions for teacher-side regrade
// and delete-submission flows (the bulk path uploaded every submission in
// localStorage, not just the affected quiz's). Returns true on success.
async function pushSingleQuizSubmissionsToCloud(quizId, submissions, options = {}) {
  const id = (quizId || '').toString().trim();
  if (!id) return false;
  if (!canUseNetworkSync()) return false;
  if (options.auto && typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  if (!getAuthSessionToken()) {
    if (!options.auto) {
      networkSyncFailed = true;
      networkSyncFailureMessage = 'Cloud sync paused: log out and log back in to push your saved changes.';
    }
    return false;
  }
  const list = slimSubmissionListForStorage(
    (Array.isArray(submissions) ? submissions : [])
      .filter((item) => item && typeof item === 'object' && (!item.quizId || item.quizId === id))
  );
  if (!list.length) return true; // nothing to push, treat as success
  let body;
  try { body = JSON.stringify({ submissions: list }); }
  catch (err) {
    if (!options.auto) {
      networkSyncFailed = true;
      networkSyncFailureMessage = `Could not serialize submissions for quiz ${id}: ${err && err.message ? err.message : 'unknown error'}`;
    }
    return false;
  }
  if (body.length > NETWORK_SYNC_MAX_BODY_BYTES) {
    if (!options.auto) {
      networkSyncFailed = true;
      networkSyncFailureMessage = `Cannot upload submissions for quiz ${id}: payload is ${(body.length / 1024 / 1024).toFixed(2)} MB which exceeds the ${(NETWORK_SYNC_MAX_BODY_BYTES / 1024 / 1024).toFixed(0)} MB cloud limit.`;
    }
    return false;
  }
  try {
    const compressed = await gzipBodyIfPossible(body);
    const headers = withAuthHeader({ 'Content-Type': 'application/json' });
    if (compressed.encoding) headers['Content-Encoding'] = compressed.encoding;
    const url = buildApiUrl(`/api/quizzes/${encodeURIComponent(id)}`);
    const requestOptions = { method: 'PUT', headers, body: compressed.body };
    const res = options.auto
      ? await autoSyncFetch(url, requestOptions)
      : await fetchWithRetry(url, requestOptions);
    if (res.status === 401) {
      if (!options.auto) {
        networkSyncFailed = true;
        networkSyncFailureMessage = 'Cloud sync rejected: your teacher session is no longer valid. Log out and log back in to retry.';
      }
      return false;
    }
    if (!res.ok) {
      if (options.auto) {
        console.warn('Auto-sync of submissions for quiz', id, 'failed:', res.status);
      } else {
        networkSyncFailed = true;
        networkSyncFailureMessage = explainNetworkSyncFailureMessage(await readApiErrorMessage(res, 'Failed to save submissions'));
      }
      return false;
    }
    networkSyncReady = true;
    networkSyncFailed = false;
    networkSyncFailureMessage = '';
    return true;
  } catch (err) {
    if (options.auto) {
      console.warn('Auto-sync of submissions for quiz', id, 'failed:', err && err.message ? err.message : err);
      return false;
    }
    networkSyncFailed = true;
    let reason;
    if (err && err.code === 'sync-paused') reason = err.message || 'Cloud sync paused.';
    else if (err && err.name === 'AbortError') reason = `Upload of submissions for quiz ${id} timed out after ${Math.round(NETWORK_SYNC_REQUEST_TIMEOUT_MS / 1000)}s.`;
    else reason = (err && err.message) ? err.message : 'Failed to save submissions';
    networkSyncFailureMessage = explainNetworkSyncFailureMessage(reason);
    console.error('Per-quiz submissions sync failed for', id, err);
    return false;
  }
}

// Two-way per-quiz sync: PUT the local quiz, then GET /api/quizzes/<id> to pull
// back the merged cloud copy + that quiz's submissions. Used by the per-quiz
// "Sync To Cloud" action in the Test Manager so teachers can refresh one quiz
// without triggering a full /api/state pull.
async function syncSingleQuizWithCloud(quiz) {
  if (!quiz || !quiz.id) {
    return { ok: false, message: 'No quiz selected.' };
  }
  if (!canUseNetworkSync()) {
    return { ok: false, message: 'Cloud sync is not available on this deployment.' };
  }
  if (!getAuthSessionToken()) {
    return { ok: false, message: 'Log out and log back in to sync your changes to the cloud.' };
  }
  const pushed = await pushSingleQuizToCloud(quiz);
  if (!pushed) {
    return { ok: false, message: networkSyncFailureMessage || `Failed to upload quiz ${quiz.id}.` };
  }
  let cloudPayload = null;
  try {
    const res = await fetchWithRetry(buildApiUrl(`/api/quizzes/${encodeURIComponent(quiz.id)}`), {
      cache: 'no-store',
      headers: withAuthHeader({})
    });
    if (res.status === 401) {
      return { ok: false, message: 'Your teacher session expired. Log out and log back in, then retry.' };
    }
    if (res.status === 404) {
      // Push succeeded but cloud GET 404'd — most likely a transient race or a
      // backend that doesn't yet expose the per-quiz GET. Treat the upload as the
      // success and skip the merge.
      return { ok: true, pulled: false, message: `Quiz ${quiz.id} uploaded.` };
    }
    if (!res.ok) {
      const reason = await readApiErrorMessage(res, 'Failed to refresh quiz from cloud');
      return { ok: true, pulled: false, message: `Quiz ${quiz.id} uploaded, but cloud refresh failed: ${reason}` };
    }
    cloudPayload = await res.json();
  } catch (err) {
    let reason;
    if (err && err.code === 'sync-paused') reason = err.message || 'Cloud sync paused';
    else if (err && err.name === 'AbortError') reason = `Cloud refresh timed out after ${Math.round(NETWORK_SYNC_REQUEST_TIMEOUT_MS / 1000)}s`;
    else reason = (err && err.message) ? err.message : 'unknown error';
    return { ok: true, pulled: false, message: `Quiz ${quiz.id} uploaded, but cloud refresh failed: ${reason}` };
  }
  const cloudQuiz = cloudPayload && cloudPayload.quiz && typeof cloudPayload.quiz === 'object' ? cloudPayload.quiz : null;
  const cloudSubs = Array.isArray(cloudPayload && cloudPayload.submissions) ? cloudPayload.submissions : [];
  // Persist the merged cloud copy locally WITHOUT triggering save()'s bulk
  // PUT to /api/state/quizzes or /api/state/submissions. The cloud was just
  // updated by the per-quiz PUT above, so re-uploading the entire map/array
  // is exactly the 12s-timeout / canceled-request pattern this flow exists
  // to prevent.
  if (cloudQuiz) {
    const localQuizzes = getAllQuizzes();
    const merged = mergeRecordMapForSync(localQuizzes || {}, { [quiz.id]: cloudQuiz });
    saveAllQuizzes(merged, { skipNetworkSync: true });
  }
  if (cloudSubs.length) {
    const localSubs = getAllSubmissions({ includeDeleted: true });
    const mergedSubs = mergeSubmissionListsForSync(localSubs || [], cloudSubs);
    saveAllSubmissions(mergedSubs, { includeDeleted: true, skipNetworkSync: true });
  }
  markQuizzesCloudSynced([quiz.id]);
  return { ok: true, pulled: true, submissionCount: cloudSubs.length, message: `Quiz ${quiz.id} synced. ${cloudSubs.length} submission(s) on cloud.` };
}

function encodeTextToBase64(value) {
  try {
    const bytes = new TextEncoder().encode((value || '').toString());
    let binary = '';
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  } catch (error) {
    return btoa(unescape(encodeURIComponent((value || '').toString())));
  }
}

function decodeTextFromBase64(value) {
  try {
    const binary = atob((value || '').toString());
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch (error) {
    return decodeURIComponent(escape(atob((value || '').toString())));
  }
}

function buildPortableQuizSnapshot(quiz) {
  if (!quiz || typeof quiz !== 'object') return {};
  return {
    id: quiz.id,
    examName: quiz.examName || '',
    title: quiz.title || '',
    timeLimit: quiz.timeLimit || 0,
    maxGrade: getQuizTotalMarks(quiz),
    attemptLimit: quiz.attemptLimit || 1,
    passMark: quiz.passMark || 50,
    negativeMarkEnabled: !!quiz.negativeMarkEnabled,
    negativeMarkValue: quiz.negativeMarkValue || 0,
    showInstantResult: quiz.showInstantResult !== false,
    showTopicsAfterSubmission: !!quiz.showTopicsAfterSubmission,
    shuffleQs: quiz.shuffleQs !== false,
    shuffleOpts: quiz.shuffleOpts !== false,
    verticalLayout: !!quiz.verticalLayout,
    rankingEnabled: !!quiz.rankingEnabled,
    webcamRequired: !!quiz.webcamRequired,
    calculatorType: getQuizCalculatorType(quiz),
    audienceMode: quiz.audienceMode || 'public',
    assignedClassName: quiz.assignedClassName || '',
    whitelist: Array.isArray(quiz.whitelist) ? quiz.whitelist : [],
    certificateSignatories: Array.isArray(quiz.certificateSignatories) ? quiz.certificateSignatories : [],
    scheduleStart: quiz.scheduleStart || '',
    scheduleEnd: quiz.scheduleEnd || '',
    subjects: (quiz.subjects || []).map((subject) => ({
      name: subject && subject.name ? subject.name : 'General',
      questionCount: subject && subject.questionCount != null ? subject.questionCount : null,
      totalMarks: getSubjectTotalMarks(subject),
      questions: ((subject && Array.isArray(subject.bankQuestions) && subject.bankQuestions.length ? subject.bankQuestions : subject && subject.questions) || []).map((question) => ({ ...question }))
    }))
  };
}

function encodeQuizToPortablePayload(quiz) {
  return encodeURIComponent(encodeTextToBase64(JSON.stringify(buildPortableQuizSnapshot(quiz))));
}

function encodeQuizToPortableCode(quiz) {
  return `${PORTABLE_QUIZ_CODE_PREFIX}${encodeQuizToPortablePayload(quiz)}`;
}

function buildPortableQuizAccessTransport(quiz) {
  const portableUrl = encodeQuizToLink(quiz, { portable: true });
  const portableCode = encodeQuizToPortableCode(quiz);
  const canUsePortableLink = portableUrl.length <= MAX_PORTABLE_LINK_LENGTH;
  return {
    portable: true,
    url: canUsePortableLink ? portableUrl : '',
    code: portableCode,
    mode: canUsePortableLink ? 'portable-link' : 'portable-code'
  };
}

async function prepareQuizAccessTransport(quiz) {
  if (!quiz || !quiz.id) return null;
  // Push only this one quiz to the cloud through the per-quiz endpoint —
  // bulk syncSharedKeys here was the source of the long links: when the
  // bulk PUT to /api/state/quizzes timed out (15GB-egress era), this fell
  // back to encoding the entire quiz as base64 in the URL. Per-quiz push is
  // small + reliable, so the short cloud-keyed link wins almost every time.
  const cloudOk = await pushSingleQuizToCloud(quiz);
  if (cloudOk) {
    markQuizzesCloudSynced([quiz.id]);
    return {
      portable: false,
      url: encodeQuizToLink(quiz),
      code: quiz.id,
      mode: 'cloud',
      sharedSyncOk: true,
      warningMessage: ''
    };
  }
  return {
    ...buildPortableQuizAccessTransport(quiz),
    sharedSyncOk: false,
    warningMessage: getSharedSyncWarningMessage()
  };
}

async function copyQuizAccessLink(quiz) {
  if (!quiz || !quiz.id) return false;
  const transport = await prepareQuizAccessTransport(quiz);
  if (!transport) return false;
  const copiedValue = transport.url || transport.code;
  const successMessage = transport.sharedSyncOk
    ? 'Quiz link copied'
    : transport.url
      ? 'Portable quiz link copied'
      : 'Portable quiz code copied';
  await copyTextToClipboard(copiedValue, successMessage);
  if (!transport.sharedSyncOk) {
    showNotification(`Cloud sync is unavailable. A portable ${transport.url ? 'link' : 'code'} was copied so this quiz can still open on another device. ${transport.warningMessage}`, 'warning', 9000);
  }
  return true;
}

async function copyQuizAccessCode(quiz) {
  if (!quiz || !quiz.id) return false;
  const transport = await prepareQuizAccessTransport(quiz);
  if (!transport) return false;
  await copyTextToClipboard(transport.code, transport.sharedSyncOk ? 'Student code copied' : 'Portable quiz code copied');
  if (!transport.sharedSyncOk) {
    showNotification(`Cloud sync is unavailable. A portable quiz code was copied so this quiz can still be opened on another device. ${transport.warningMessage}`, 'warning', 9000);
  }
  return true;
}

function buildQuizSharePayload(quiz, transport = {}) {
  const url = transport.url || encodeQuizToLink(quiz);
  const subjectSummaries = getQuizSubjectSummaries(quiz);
  const totalQuestions = subjectSummaries.reduce((sum, item) => sum + (Number(item.questionCount) || 0), 0);
  const subjectBreakdown = subjectSummaries.length
    ? subjectSummaries.map((item) => `- ${item.name}: ${item.questionCount} question(s)`).join('\n')
    : '- General: 0 question(s)';
  const teacherLabel = getTeacherSignatureLabel(quiz?.teacherId || state.teacherId);
  const accessLines = transport.portable
    ? (transport.url
      ? [
          `Portable access link: ${transport.url}`,
          `If the regular quiz ID does not open immediately on another device, use this portable link instead.`
        ]
      : [
          `Portable Quiz Code:`,
          transport.code
        ])
    : [`Open quiz: ${url}`];
  const detailedMessage = [
    `Hello Student,`,
    ``,
    `You are invited to attempt ${quiz?.title || 'this quiz'} on OPE Assessor.`,
    `Quiz Code: ${quiz?.id || ''}`,
    `Subjects: ${subjectSummaries.length || 1}`,
    `Total Questions: ${totalQuestions || 0}`,
    `Question Breakdown:`,
    subjectBreakdown,
    ``,
    ...accessLines,
    ``,
    `Important rules:`,
    `- Full screen is required throughout the quiz.`,
    `- Screenshots and screen recording are not allowed.`,
    `- Copy, paste, or similar shortcuts are restricted.`,
    `- Minimizing, closing the tab, or leaving full screen can lead to the quiz being flagged or auto-submitted.`,
    ``,
    `${teacherLabel}`
  ].join('\n');
  return {
    url,
    title: quiz?.title || 'OPE Assessor Quiz',
    text: detailedMessage
  };
}

async function shareQuizAccessLink(quiz) {
  if (!quiz || !quiz.id) return false;
  const transport = await prepareQuizAccessTransport(quiz);
  if (!transport) return false;
  const sharePayload = buildQuizSharePayload(quiz, transport);
  openWhatsappShareIntent(sharePayload.text);
  if (transport.sharedSyncOk) {
    showNotification('WhatsApp opened with the quiz invite message', 'success', 7000);
  } else {
    showNotification(`WhatsApp opened with portable quiz access because cloud sync is unavailable. ${transport.warningMessage}`, 'warning', 9000);
  }
  return true;
}

async function deleteQuizById(quizId, options = {}) {
  const quizzes = getAllQuizzes({ includeDeleted: true });
  const quiz = quizzes[quizId];
  if (!quiz) {
    showNotification('Quiz not found', 'error');
    return false;
  }
  const visibleSubmissionCount = getAllSubmissions().filter((item) => item.quizId === quizId).length;
  const message = visibleSubmissionCount
    ? `Delete "${quiz.title || quiz.id}" and remove its ${visibleSubmissionCount} submission(s)? This cannot be undone.`
    : `Delete "${quiz.title || quiz.id}" now? This cannot be undone.`;
  if (!confirmTeacherAction(message)) return false;
  const deletedAt = new Date().toISOString();
  const tombstone = {
    ...quiz,
    deletedAt,
    deletedBy: state.teacherId || 'teacher',
    updatedAt: deletedAt
  };
  quizzes[quizId] = tombstone;
  saveAllQuizzes(quizzes, { skipNetworkSync: true });

  const submissions = getAllSubmissions({ includeDeleted: true });
  let changedSubmissions = false;
  submissions.forEach((item) => {
    if (item.quizId !== quizId || isDeletedSubmission(item)) return;
    item.deletedAt = deletedAt;
    item.deletedBy = state.teacherId || 'teacher';
    item.updatedAt = deletedAt;
    changedSubmissions = true;
  });
  if (changedSubmissions) save(STORAGE_KEYS.submissions, submissions);

  if (state.currentQuiz && state.currentQuiz.id === quizId) state.currentQuiz = null;
  // Per-quiz push for both the quiz tombstone AND its submission tombstones —
  // bulk PUTs to /api/state/quizzes and /api/state/submissions are both
  // blocked for teacher sessions, so propagation rides /api/quizzes/<id>.
  const quizPushed = await pushSingleQuizToCloud(tombstone);
  let submissionsPushed = true;
  if (changedSubmissions) {
    const quizSubs = getAllSubmissions({ includeDeleted: true }).filter((s) => s && s.quizId === quizId);
    submissionsPushed = await pushSingleQuizSubmissionsToCloud(quizId, quizSubs);
  }
  const synced = quizPushed && submissionsPushed;
  if (options.onDeleted) options.onDeleted();
  if (synced) {
    showNotification('Quiz deleted', 'success');
  } else {
    showNotification(`Quiz deleted on this device. ${getSharedSyncWarningMessage()}`, 'warning', 8000);
  }
  render();
  return true;
}

function startNetworkSyncLoop() {
  if (!canUseNetworkSync()) return;
  // Manual-only sync — no polling interval. We still bind the cross-tab
  // `storage` listener so multi-tab edits in this browser refresh the UI.
  bindNetworkSyncWindowEvents();
}

async function initializeApp() {
  const pdfBootstrap = getPdfBootstrapPayload();
  if (pdfBootstrap) {
    state.pdfBootstrap = pdfBootstrap;
    state.view = 'pdf.render';
    render();
    return;
  }
  // Detect the user-facing print routes (/student-correction/:id and
  // /facility-index/:id). The source tab writes a one-shot payload to
  // localStorage before opening the new tab, so the destination renders the
  // full A4-styled report instantly. No spinner, no network round-trip.
  const printRoute = parsePrintRouteFromLocation();
  if (printRoute) {
    ensureSuperAdminAccount();
    migrateAndNormalizeSubmissions();
    state.printRoute = printRoute;
    state.view = printRoute.type === 'facility-index' ? 'print.facility' : 'print.correction';
    render();
    // If the destination opened the URL directly (no payload), pull shared
    // state in the background and re-render once it arrives. Doesn't block
    // the first paint.
    if (canUseNetworkSync()) {
      pullSharedStateSilently({ forcePull: true, timeoutMs: 8000 })
        .then((didChange) => { if (didChange !== false) render(); })
        .catch(() => {});
    }
    return;
  }
  ensureSuperAdminAccount();
  migrateLegacyLocalTeacherPasswords();
  migrateAndNormalizeSubmissions();
  startOverlayBodyLockObserver();
  bindInstallPromptEvents();
  const params = new URLSearchParams(window.location.search);
  const querySyncApiBaseUrl = normalizeApiBaseUrl(params.get('syncApiBaseUrl') || params.get('apiBaseUrl') || '');
  if (querySyncApiBaseUrl) setNetworkSyncApiBaseUrl(querySyncApiBaseUrl);
  const startupSharedChanged = await hydrateSharedStateBeforeFirstRender(params);
  applyPersistedAppUiState();
  if (params.has('q')) {
    const id = params.get('q');
    state.prefillQuizCode = id;
    state.view = 'student';
    hydratePrefilledQuizFromAccess();
    // Warm the quiz from the public per-quiz endpoint in the background so it's
    // already in localStorage by the time the student taps Start Exam. Fire and
    // forget — no re-render (it would clobber whatever the student is typing);
    // resolveQuizFromAccessWithSync re-fetches anyway if this hasn't landed yet.
    if (!state.currentQuiz && canUseNetworkSync()) {
      fetchQuizFromCloudByAccess({ code: (id || '').toString().trim() }).catch(() => {});
    }
  }
  if (params.has('import')) {
    const quiz = stampImportedQuizOwner(decodeQuizFromString(params.get('import')));
    if (quiz) {
      const quizzes = getAllQuizzes();
      quizzes[quiz.id] = quiz;
      saveAllQuizzes(quizzes);
      state.currentQuiz = quiz;
      state.view = 'take';
    }
  }
  if (params.has('r') || (params.has('resultQuiz') && params.has('resultKey'))) {
    state.pendingResultLookup = {
      shareKey: params.get('r') || '',
      quizId: params.get('resultQuiz') || '',
      submissionId: params.get('resultKey') || '',
      downloadCorrection: ['1', 'true', 'yes'].includes(((params.get('c') || params.get('downloadCorrection') || '')).toLowerCase()),
      correctionSubject: params.get('s') || params.get('correctionSubject') || ''
    };
    state.view = 'student.result';
  }
  applySharedStateUiRefresh(startupSharedChanged, { suppressRender: true });
  render();
  startNetworkSyncLoop();
  // No automatic post-render sync. The one-shot startup pull above
  // (hydrateSharedStateBeforeFirstRender) is the only load-time network read;
  // anything else waits for the teacher to click Sync Now.
}

function save(key, value, options = {}) {
  if (!writeLocalStorageValue(key, value)) return;
  // skipNetworkSync is for paths that have already pushed to the cloud
  // through a per-resource endpoint (e.g. the per-quiz Sync To Cloud flow
  // PUTs through /api/quizzes/<id> and merges the cloud response back in).
  // Without this flag, save() would also fire a bulk PUT to /api/state/<key>,
  // re-uploading the whole map/array and recreating the 12s-timeout pattern
  // the per-quiz endpoint exists to avoid.
  if (options.skipNetworkSync) return;
  if (NETWORK_SYNC_KEYS.includes(key)) {
    markNetworkKeyDirty(key);
    // Single best-effort PUT — no retry timer (schedulePendingNetworkFlush is a
    // no-op now). This is also the path a student's submission takes to the
    // cloud when they tap Submit, so it must stay; on failure the key just
    // remains dirty and uploads on the next "Sync Now" click.
    pushNetworkValue(key, value);
  }
}

function load(key) {
  return readLocalStorageValue(key);
}

function getAllStoredQuizzes() { return load(STORAGE_KEYS.quizzes) || {}; }
function getAllQuizzes(options = {}) {
  const includeDeleted = !!options.includeDeleted;
  const quizzes = getAllStoredQuizzes();
  if (includeDeleted) return quizzes;
  return Object.keys(quizzes).reduce((visible, key) => {
    if (!isDeletedQuiz(quizzes[key])) visible[key] = quizzes[key];
    return visible;
  }, {});
}
function getAllStoredSubmissions() {
  const stored = load(STORAGE_KEYS.submissions) || [];
  if (_cloudSubmissionsFallback.size === 0) return stored;
  let overlay = [];
  _cloudSubmissionsFallback.forEach((list) => { if (Array.isArray(list) && list.length) overlay = overlay.concat(list); });
  if (!overlay.length) return stored;
  // Overlay (the fresh cloud copy) wins over the stale local rows of the same id.
  return mergeSubmissionRecordsForSync(overlay, Array.isArray(stored) ? stored : []);
}
function getAllSubmissions(options = {}) {
  const includeDeleted = !!options.includeDeleted;
  const submissions = getAllStoredSubmissions();
  return includeDeleted ? submissions : submissions.filter((item) => !isDeletedSubmission(item));
}
function getAllTeachers() { return load(STORAGE_KEYS.teachers) || {}; }
function getAllTokenTransactions() { return load(STORAGE_KEYS.tokenTransactions) || []; }
function getAllTeacherStudents() { return load(STORAGE_KEYS.students) || {}; }
function saveAllQuizzes(q, options = {}) {
  const keepDeleted = options.keepDeleted !== false;
  const saveOptions = options.skipNetworkSync ? { skipNetworkSync: true } : undefined;
  const nextVisible = (q && typeof q === 'object' && !Array.isArray(q)) ? { ...q } : {};
  if (!keepDeleted) {
    save(STORAGE_KEYS.quizzes, nextVisible, saveOptions);
    return;
  }
  const deletedRecords = {};
  const stored = getAllStoredQuizzes();
  Object.keys(stored).forEach((key) => {
    if (isDeletedQuiz(stored[key]) && !Object.prototype.hasOwnProperty.call(nextVisible, key)) deletedRecords[key] = stored[key];
  });
  save(STORAGE_KEYS.quizzes, { ...deletedRecords, ...nextVisible }, saveOptions);
}
// A submission's allQuestions/snapshots carry the FULL question objects the
// student saw — including each question's embedded image (mediaAssets[].src,
// base64). For an image-heavy quiz that bloats a single submission to several
// MB, which (a) can blow the localStorage quota so the result never even saves
// and (b) is far too big to upload, so the teacher never sees it. The images
// belong to the quiz, not the submission — the correction view already re-merges
// live question content (incl. mediaAssets) from the quiz by _sourceId — so we
// strip them here. We also drop the base64 webcam proctoring frame
// (snapshots[].data): nothing in the app ever renders it, yet dozens of them
// (a JPEG every ~30s, several per submission) are by far the heaviest thing in
// a quiz's submissions and are exactly what overflowed the 5 MB localStorage
// quota in the field. Only the frame timestamps (snapshots[].at) are kept.
// Idempotent; returns the same reference when there's nothing to strip.
function slimSubmissionForStorage(submission) {
  if (!submission || typeof submission !== 'object') return submission;
  let changed = false;
  const stripQuestion = (q) => {
    if (!q || typeof q !== 'object' || !Array.isArray(q.mediaAssets) || !q.mediaAssets.length) return q;
    changed = true;
    return { ...q, mediaAssets: [] };
  };
  let allQuestions = submission.allQuestions;
  if (Array.isArray(allQuestions)) allQuestions = allQuestions.map(stripQuestion);
  let snapshots = submission.snapshots;
  if (Array.isArray(snapshots)) {
    snapshots = snapshots.map((snap) => {
      if (!snap || typeof snap !== 'object') return snap;
      let next = snap;
      if (next.data) { changed = true; next = { ...next }; delete next.data; }
      if (next.question) {
        const slimQ = stripQuestion(next.question);
        if (slimQ !== next.question) next = { ...next, question: slimQ };
      }
      return next;
    });
  }
  if (!changed) return submission;
  return { ...submission, allQuestions, snapshots };
}
function slimSubmissionListForStorage(list) {
  if (!Array.isArray(list)) return list;
  let changed = false;
  const out = list.map((sub) => {
    const slim = slimSubmissionForStorage(sub);
    if (slim !== sub) changed = true;
    return slim;
  });
  return changed ? out : list;
}

// Defence in depth against legacy data: webcam proctoring frames
// (snapshots[].data — a base64 JPEG) are no longer captured or persisted
// (slimSubmissionForStorage strips them, startWebcam stores timestamps only),
// but a device may still hold old submissions that carry them, and they're by
// far the heaviest thing in a submission. This drops them as a quota fallback.
// `keepFramesFor` is retained for call-site compatibility; in practice slim has
// already removed every frame before this runs.
function dropSubmissionWebcamFrames(list, keepFramesFor = null) {
  return (Array.isArray(list) ? list : []).map((s) => {
    if (!s || typeof s !== 'object' || !Array.isArray(s.snapshots) || !s.snapshots.length) return s;
    if (keepFramesFor != null && String(s.quizId) === String(keepFramesFor)) return s;
    if (!s.snapshots.some((sn) => sn && sn.data)) return s;
    return { ...s, snapshots: s.snapshots.map((sn) => (sn && sn.data ? { at: sn.at } : sn)) };
  });
}

// Write the submissions list to localStorage, surviving a near-full quota by
// progressively shedding the bulkiest dispensable data (webcam frames). Returns
// true if it managed to write something.
function writeSubmissionsToStorage(list, keepFramesFor = null) {
  const attempts = [
    () => list,
    () => dropSubmissionWebcamFrames(list, keepFramesFor),
    () => dropSubmissionWebcamFrames(list, null)
  ];
  for (let i = 0; i < attempts.length; i += 1) {
    try {
      localStorage[STORAGE_KEYS.submissions] = JSON.stringify(attempts[i]());
      if (i === 1) console.warn('Submissions storage was full — dropped webcam proctoring frames for other quizzes locally (still on the cloud).');
      if (i === 2) console.warn('Submissions storage was very full — dropped ALL webcam proctoring frames locally (still on the cloud).');
      return true;
    } catch (e) { /* try the next, lighter attempt */ }
  }
  console.error('Submissions storage write failed even after dropping all webcam frames.');
  if (typeof showNotification === 'function') notifyStorageQuotaExceeded();
  return false;
}

function saveAllSubmissions(submissions, options = {}) {
  const keepDeleted = options.keepDeleted !== false;
  const nextVisible = slimSubmissionListForStorage(Array.isArray(submissions) ? submissions : []);
  const nextValue = keepDeleted
    ? mergeSubmissionRecordsForSync(nextVisible, getAllStoredSubmissions().filter(isDeletedSubmission))
    : mergeSubmissionRecordsForSync(nextVisible, []);
  const wrote = writeSubmissionsToStorage(nextValue, options.keepFramesFor);
  // Push the FULL value (with frames) to the cloud even if the local copy had
  // to be trimmed — the cloud keeps the canonical, complete record. (For a
  // logged-in teacher the bulk submissions push is a no-op anyway; this matters
  // for the anonymous student-submit path.)
  if (wrote && !options.skipNetworkSync && NETWORK_SYNC_KEYS.includes(STORAGE_KEYS.submissions)) {
    markNetworkKeyDirty(STORAGE_KEYS.submissions);
    pushNetworkValue(STORAGE_KEYS.submissions, nextValue);
  }
}
function saveAllTeachers(t) { save(STORAGE_KEYS.teachers, t); }
function saveAllTokenTransactions(transactions) { save(STORAGE_KEYS.tokenTransactions, Array.isArray(transactions) ? transactions : []); }
function saveAllTeacherStudents(s) { save(STORAGE_KEYS.students, s); }

// ---- Per-submission cloud upload + offline outbox -------------------------
// A finished submission lives in three places until it's safely on the cloud:
//   1. localStorage[submissions] — so this device's hasSubmittedBefore() / the
//      instant-result modal / offline use still work.
//   2. localStorage[submissionOutbox] — the retry buffer below.
//   3. POST /api/submissions — the canonical write. On 200 we drop it from (2).
// The outbox is what makes a submit survive a network blip without the student
// having to do anything: it's drained again on the next app load / `online`.
function getSubmissionOutbox() {
  const list = load(STORAGE_KEYS.submissionOutbox);
  return Array.isArray(list) ? list.filter((s) => s && typeof s === 'object') : [];
}
function setSubmissionOutbox(list) {
  try { localStorage[STORAGE_KEYS.submissionOutbox] = JSON.stringify(Array.isArray(list) ? list : []); return true; }
  catch (e) { console.warn('Could not write submission outbox:', e && e.message ? e.message : e); return false; }
}
function submissionOutboxKey(sub) {
  if (!sub || typeof sub !== 'object') return '';
  return (sub.submissionId || `${sub.quizId || ''}::${normalizeEmail(sub.email || '')}::${sub.submittedAt || ''}`).toString();
}
function enqueueSubmissionToOutbox(sub) {
  if (!sub || typeof sub !== 'object' || !sub.quizId) return;
  const slim = slimSubmissionForStorage(sub);
  const key = submissionOutboxKey(slim);
  const next = getSubmissionOutbox().filter((item) => submissionOutboxKey(item) !== key);
  next.push(slim);
  // Bound it — the outbox should normally be empty/near-empty; if uploads keep
  // failing, cap to the most recent so a kiosk device can't accumulate forever.
  setSubmissionOutbox(next.slice(-50));
}
function dequeueSubmissionFromOutbox(sub) {
  const key = submissionOutboxKey(sub);
  if (!key) return;
  setSubmissionOutbox(getSubmissionOutbox().filter((item) => submissionOutboxKey(item) !== key));
}

// POST one submission to the cloud. Resolves true on a confirmed save, false on
// any failure (the caller leaves it in the outbox to retry later). One attempt
// plus one short retry — same philosophy as the other automatic student paths.
async function submitOneSubmissionToCloud(sub) {
  if (!sub || typeof sub !== 'object' || !sub.quizId) return false;
  if (!canUseNetworkSync()) return false;
  try {
    const res = await autoSyncFetch(buildApiUrl('/api/submissions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ submission: slimSubmissionForStorage(sub) })
    });
    if (res && res.ok) return true;
    console.warn('POST /api/submissions failed —', res ? `HTTP ${res.status}` : 'no response');
    return false;
  } catch (e) {
    console.warn('POST /api/submissions errored:', e && e.message ? e.message : e);
    return false;
  }
}

let _flushingSubmissionOutbox = false;
// Drain the outbox: try each queued submission, drop the ones that land. Safe to
// call often — it no-ops if already running, if offline, or if the queue is empty.
async function flushSubmissionOutbox() {
  if (_flushingSubmissionOutbox) return;
  const queue = getSubmissionOutbox();
  if (!queue.length || !canUseNetworkSync()) return;
  _flushingSubmissionOutbox = true;
  try {
    for (const sub of queue) {
      const ok = await submitOneSubmissionToCloud(sub);
      if (ok) dequeueSubmissionFromOutbox(sub);
    }
  } finally {
    _flushingSubmissionOutbox = false;
  }
}
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  // The one place we DO listen for `online`: a retry buffer is exactly what that
  // event is for, and it never triggers a heavy pull — just re-POSTs tiny rows.
  window.addEventListener('online', () => { flushSubmissionOutbox().catch(() => {}); });
}

function compactStoredSubmissions() {
  const submissions = getAllSubmissions({ includeDeleted: true });
  let changed = false;
  submissions.forEach((sub) => {
    if (!sub || !Array.isArray(sub.snapshots)) return;
    if (sub.snapshots.length > 6) {
      sub.snapshots = sub.snapshots.slice(-6);
      changed = true;
    }
  });
  // Also strip any embedded question images that older submissions still carry,
  // so they shrink in localStorage and become small enough to upload. saveAllSubmissions
  // slims unconditionally, so if there's anything to strip we just need to trigger a save.
  if (!changed && slimSubmissionListForStorage(submissions) !== submissions) changed = true;
  if (changed) saveAllSubmissions(submissions);
}

function updateLatestSubmissionByQuizAndEmail(quizId, email, updater) {
  const submissions = getAllSubmissions({ includeDeleted: true });
  let index = -1;
  for (let i = submissions.length - 1; i >= 0; i--) {
    const item = submissions[i];
    if (isDeletedSubmission(item)) continue;
    if (item.quizId === quizId && normalizeEmail(item.email) === normalizeEmail(email)) {
      index = i;
      break;
    }
  }
  if (index < 0) return null;
  const next = { ...submissions[index] };
  updater(next);
  next.updatedAt = new Date().toISOString();
  next.submissionId = next.submissionId || buildSubmissionIdentity(next, index);
  submissions[index] = next;
  save(STORAGE_KEYS.submissions, submissions);
  return next;
}

function findSubmissionIndexByIdentity(submissions, quizId, email, submittedAt = '') {
  return (submissions || []).findIndex((item) =>
    item.quizId === quizId &&
    normalizeEmail(item.email) === normalizeEmail(email) &&
    (item.submittedAt || '') === (submittedAt || '')
  );
}

function getCurrentTeacher() {
  if (!state.teacherId) return null;
  const id = normalizeEmail(state.teacherId);
  const local = getAllTeachers()[id];
  if (local) return local;
  // No local teacher record yet — e.g. a freshly-wiped device (or one that just
  // cleared site data) that authenticated against the cloud before the teachers
  // table has been pulled. Synthesize a minimal record from the active auth
  // session so the teacher isn't bounced straight back to the login screen;
  // the full record (tokens, license, name…) replaces this once it's pulled.
  const session = getStoredAuthSession();
  if (session && session.token && normalizeEmail(session.email) === id) {
    return { teacherId: id, email: id, role: session.role || 'teacher', _synthesized: true };
  }
  return null;
}

function buildTeacherSelfSyncPayload(teacherMap = {}) {
  const teacherId = normalizeEmail(state.teacherId || getTeacherId());
  if (!teacherId) return null;
  const record = (teacherMap && teacherMap[teacherId]) || getTeacherById(teacherId) || getCurrentTeacher();
  if (!record) return null;
  const payload = {
    teacherId,
    email: teacherId,
    name: (record.name || '').toString().trim(),
    phone: (record.phone || record.phoneNumber || '').toString().trim(),
    updatedAt: (record.updatedAt || new Date().toISOString()).toString()
  };
  const hasTokenRequestData = !!(
    (record.tokenRequestStatus || '').toString().trim()
    || (record.tokenRequestedAt || '').toString().trim()
    || (record.tokenRequestedPackageKey || '').toString().trim()
    || Number(record.tokenRequestedAmount || 0)
    || Number(record.tokenRequestedTokens || 0)
    || (record.tokenRequestedDeviceId || '').toString().trim()
  );
  if (hasTokenRequestData) {
    payload.tokenRequestStatus = (record.tokenRequestStatus || '').toString().trim();
    payload.tokenRequestedAt = (record.tokenRequestedAt || '').toString().trim();
    payload.tokenRequestedPackageKey = (record.tokenRequestedPackageKey || '').toString().trim();
    payload.tokenRequestedAmount = Number(record.tokenRequestedAmount || 0) || 0;
    payload.tokenRequestedTokens = Number(record.tokenRequestedTokens || 0) || 0;
    payload.tokenRequestedDeviceId = (record.tokenRequestedDeviceId || '').toString().trim();
  }
  return {
    [teacherId]: payload
  };
}

function updateTeacherProfileRecord(existingTeacherId, nextProfile = {}, options = {}) {
  const oldId = normalizeEmail(existingTeacherId);
  const teachers = getAllTeachers();
  const current = teachers[oldId] || (normalizeEmail(state.teacherId) === oldId
    ? {
        teacherId: oldId,
        email: oldId,
        role: oldId === SUPER_ADMIN_EMAIL ? 'super_admin' : 'teacher',
        createdAt: new Date().toISOString()
      }
    : null);
  if (!current) return { ok: false, message: 'Teacher account not found' };
  const emailLocked = !!options.lockEmail || normalizeEmail(current.teacherId || current.email) === SUPER_ADMIN_EMAIL;
  const nextId = emailLocked
    ? oldId
    : normalizeEmail(nextProfile.email || current.email || current.teacherId);
  if (!nextId) return { ok: false, message: 'Enter a valid teacher email ID' };
  if (nextId !== oldId && teachers[nextId]) return { ok: false, message: 'That teacher email ID already exists' };
  const now = new Date().toISOString();
  const nextTeacher = {
    ...current,
    teacherId: nextId,
    email: nextId,
    name: (nextProfile.name ?? current.name ?? '').toString().trim(),
    phone: (nextProfile.phone ?? current.phone ?? current.phoneNumber ?? '').toString().trim(),
    updatedAt: now
  };

  if (nextId !== oldId) {
    teachers[nextId] = nextTeacher;
    delete teachers[oldId];
  } else {
    teachers[oldId] = nextTeacher;
  }
  saveAllTeachers(teachers);

  if (nextId !== oldId) {
    const quizzes = getAllStoredQuizzes();
    const reassigned = [];
    Object.keys(quizzes).forEach((quizId) => {
      if (normalizeEmail(quizzes[quizId]?.teacherId) === oldId) {
        quizzes[quizId].teacherId = nextId;
        reassigned.push(quizzes[quizId]);
      }
    });
    saveAllQuizzes(quizzes, { skipNetworkSync: true });
    // Bulk PUT /api/state/quizzes is now a no-op; fan out per-quiz pushes for
    // each reassigned quiz so the cloud's teacher_id catches up. Fire and
    // forget — this admin flow is rare and a per-quiz Sync from the dashboard
    // can repair anything that fails.
    if (reassigned.length && typeof pushSingleQuizToCloud === 'function') {
      Promise.all(reassigned.map((quiz) => pushSingleQuizToCloud(quiz, { auto: true }).catch(() => false))).catch(() => {});
    }

    const allStudents = getAllTeacherStudents();
    if (allStudents[oldId]) {
      allStudents[nextId] = allStudents[oldId];
      delete allStudents[oldId];
      saveAllTeacherStudents(allStudents);
    }

    const nextFilters = {};
    Object.keys(state.classFilters || {}).forEach((key) => {
      const parts = key.split(':');
      const scope = parts[0] || 'teacher';
      const teacherKey = parts.slice(1).join(':');
      if (teacherKey === oldId) nextFilters[`${scope}:${nextId}`] = state.classFilters[key];
      else nextFilters[key] = state.classFilters[key];
    });
    state.classFilters = nextFilters;
  }

  if (normalizeEmail(state.teacherId) === oldId) {
    state.teacherId = nextId;
    const session = load(STORAGE_KEYS.teacherSession) || {};
    save(STORAGE_KEYS.teacherSession, {
      ...session,
      teacherId: nextId,
      updatedAt: now
    });
    localStorage.setItem(STORAGE_KEYS.teacherId, nextId);
  }
  if (state.currentQuiz && normalizeEmail(state.currentQuiz.teacherId) === oldId) {
    state.currentQuiz = { ...state.currentQuiz, teacherId: nextId };
  }
  persistAppUiState();
  return { ok: true, teacher: nextTeacher, changedId: nextId !== oldId, teacherId: nextId };
}

function isTeacherLoggedIn() { return !!getCurrentTeacher(); }
function isSuperAdmin() { return normalizeEmail(state.teacherId) === SUPER_ADMIN_EMAIL; }

function getTeacherLicenseStatus(teacher = getCurrentTeacher()) {
  if (!teacher) return { active: false, label: 'Not logged in', detail: 'Login required', endsAt: '' };
  if (teacher.role === 'super_admin' || normalizeEmail(teacher.teacherId || teacher.email) === SUPER_ADMIN_EMAIL) {
    return {
      active: true,
      unlimited: true,
      canSaveQuiz: true,
      tokenBalance: Number.MAX_SAFE_INTEGER,
      label: 'Unlimited admin access',
      detail: 'Admin accounts can create, update, and transfer unlimited access without token deductions.',
      summary: 'Tokens: Unlimited | Unlimited: Always active',
      endsAt: ''
    };
  }
  const tokenBalance = getTeacherTokenBalance(teacher);
  const unlimitedDays = getUnlimitedDaysLeft(teacher);
  const unlimitedActive = unlimitedDays > 0;
  const unlimitedHere = unlimitedActive && isUnlimitedActiveOnCurrentDevice(teacher);
  const unlimitedWrongDevice = unlimitedActive && !unlimitedHere;
  const requestedPackageKey = (teacher.tokenRequestedPackageKey || '').toString().trim().toLowerCase();
  const requestedPackage = getTokenPackageByKey(requestedPackageKey);
  const requestedAmount = Number(teacher.tokenRequestedAmount || requestedPackage?.price || 0) || 0;
  const requestedTokens = Number(teacher.tokenRequestedTokens || requestedPackage?.tokens || 0) || 0;
  const endsAt = teacher.unlimitedExpiresAt || '';
  const baseSummary = unlimitedHere
    ? `Tokens: ${tokenBalance} | Unlimited: ${unlimitedDays} day${unlimitedDays === 1 ? '' : 's'} left`
    : unlimitedWrongDevice
      ? `Tokens: ${tokenBalance} | Unlimited: active on another device`
      : `Tokens: ${tokenBalance}`;

  if (teacher.tokenRequestStatus === 'pending') {
    const packageLabel = requestedPackage ? requestedPackage.label : 'purchase';
    return {
      active: false,
      pending: true,
      label: `${packageLabel} request pending`,
      detail: requestedPackage?.unlimitedDays
        ? `Awaiting admin approval for ${packageLabel} (${formatNaira(requestedAmount)}).`
        : `Awaiting admin approval for ${packageLabel}${requestedTokens ? ` • ${requestedTokens} Token${requestedTokens === 1 ? '' : 's'}` : ''} (${formatNaira(requestedAmount)}).`,
      summary: baseSummary,
      tokenBalance,
      endsAt
    };
  }

  if (unlimitedHere) {
    return {
      active: true,
      unlimited: true,
      canSaveQuiz: true,
      tokenBalance,
      daysLeft: unlimitedDays,
      label: 'Unlimited active',
      detail: `Tokens: ${tokenBalance} • Unlimited: ${unlimitedDays} day${unlimitedDays === 1 ? '' : 's'} left on this device. Saving a new quiz will not deduct any token until ${new Date(teacher.unlimitedExpiresAt).toLocaleString()}.`,
      summary: baseSummary,
      endsAt
    };
  }

  if (unlimitedWrongDevice && tokenBalance >= 1) {
    return {
      active: true,
      canSaveQuiz: true,
      tokenBalance,
      unlimited: true,
      wrongDevice: true,
      daysLeft: unlimitedDays,
      label: `Tokens: ${tokenBalance}`,
      detail: `Your unlimited plan is on another device. Use 1 Token ${formatNaira(TOKEN_PRICE_PER_QUIZ)} to continue here.`,
      summary: baseSummary,
      endsAt
    };
  }

  if (tokenBalance >= 1) {
    const hadUnlimited = teacher.unlimitedExpiresAt && !unlimitedActive;
    return {
      active: true,
      canSaveQuiz: true,
      tokenBalance,
      expired: hadUnlimited,
      label: `Tokens: ${tokenBalance}`,
      detail: hadUnlimited
        ? `Unlimited ended. You still have ${tokenBalance} Token${tokenBalance === 1 ? '' : 's'}. Saving a new quiz will deduct 1 Token ${formatNaira(TOKEN_PRICE_PER_QUIZ)}.`
        : `1 Token = 1 Quiz = ${formatNaira(TOKEN_PRICE_PER_QUIZ)}. Saving a new quiz will deduct 1 Token.`,
      summary: baseSummary,
      endsAt
    };
  }

  if (unlimitedWrongDevice) {
    return {
      active: false,
      canSaveQuiz: false,
      tokenBalance,
      unlimited: true,
      wrongDevice: true,
      daysLeft: unlimitedDays,
      label: 'Unlimited locked to another device',
      detail: `Your unlimited plan is on another device. Use 1 Token ${formatNaira(TOKEN_PRICE_PER_QUIZ)} to continue here.`,
      summary: baseSummary,
      endsAt
    };
  }

  if (teacher.unlimitedExpiresAt && !unlimitedActive) {
    return {
      active: false,
      canSaveQuiz: false,
      tokenBalance,
      expired: true,
      label: 'Unlimited ended',
      detail: `Unlimited ended. You have ${tokenBalance} Token${tokenBalance === 1 ? '' : 's'}. Top up to keep saving new quizzes.`,
      summary: baseSummary,
      endsAt
    };
  }

  return {
    active: false,
    canSaveQuiz: false,
    tokenBalance,
    label: 'Insufficient Tokens',
    detail: `Insufficient Tokens. 1 Token = ${formatNaira(TOKEN_PRICE_PER_QUIZ)}. Buy Tokens.`,
    summary: baseSummary,
    endsAt
  };
}

function showAdminTeacherAccountDetails(teacherId) {
  if (!isSuperAdmin()) return showNotification('Admin access required', 'error');
  const id = normalizeEmail(teacherId);
  const teacher = getAllTeachers()[id];
  if (!teacher) return showNotification('Teacher not found', 'error');
  const status = getTeacherLicenseStatus(teacher);
  const tokenBalance = teacher.role === 'super_admin' || id === SUPER_ADMIN_EMAIL
    ? 'Unlimited'
    : String(getTeacherTokenBalance(teacher));
  const pendingPackageLabel = teacher.tokenRequestedPackageKey
    ? getTokenPackageLabel(teacher.tokenRequestedPackageKey)
    : 'None';
  let modal = document.getElementById('adminTeacherAccountModal');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'adminTeacherAccountModal';
  modal.className = 'student-result-modal';
  const inner = document.createElement('div');
  inner.className = 'card-beautiful admin-modal-card';
  inner.style.width = 'min(680px, 94vw)';
  inner.innerHTML = `
    <div class="page-heading">
      <div>
        <div class="h2">Teacher Account Details</div>
        <div class="small">${escapeHtml(id)}</div>
      </div>
      <button id="closeAdminTeacherAccount" class="btn btn-ghost">Close</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
      <div class="card" style="padding:14px;border:1px solid #DBEAFE;box-shadow:none">
        <div class="small">Name</div>
        <div style="font-weight:800;margin-top:6px">${escapeHtml(getTeacherDisplayName(teacher, { preferPlaceholder: true }))}</div>
      </div>
      <div class="card" style="padding:14px;border:1px solid #DBEAFE;box-shadow:none">
        <div class="small">Teacher ID</div>
        <div style="font-weight:800;margin-top:6px;word-break:break-word">${escapeHtml(id)}</div>
      </div>
      <div class="card" style="padding:14px;border:1px solid #DBEAFE;box-shadow:none">
        <div class="small">Phone Number</div>
        <div style="font-weight:800;margin-top:6px">${escapeHtml(getTeacherPhoneLabel(teacher))}</div>
      </div>
      <div class="card" style="padding:14px;border:1px solid #DBEAFE;box-shadow:none">
        <div class="small">Available Tokens</div>
        <div style="font-weight:800;margin-top:6px">${escapeHtml(tokenBalance)}</div>
      </div>
      <div class="card" style="padding:14px;border:1px solid #DBEAFE;box-shadow:none">
        <div class="small">Access Status</div>
        <div style="font-weight:800;margin-top:6px">${escapeHtml(status.label || 'Unknown')}</div>
      </div>
      <div class="card" style="padding:14px;border:1px solid #DBEAFE;box-shadow:none">
        <div class="small">Pending Request</div>
        <div style="font-weight:800;margin-top:6px">${escapeHtml(pendingPackageLabel)}</div>
      </div>
    </div>
    <div class="small" style="margin-top:14px;line-height:1.7">${escapeHtml(status.detail || status.summary || 'No additional account detail available.')}</div>
  `;
  modal.appendChild(inner);
  document.body.appendChild(modal);
  modal.onclick = (event) => { if (event.target === modal) modal.remove(); };
  document.getElementById('closeAdminTeacherAccount').onclick = () => modal.remove();
}

function canSetQuestions() {
  return isTeacherLoggedIn();
}

async function requestTeacherLicense(selectedPlanKey = 'starter', contactChannel = '') {
  const teacher = getCurrentTeacher();
  if (!teacher) { state.view = 'teacher.login'; render(); return; }
  const selectedPackage = getTokenPackageByKey(selectedPlanKey) || getTokenPackageByKey('starter');
  const teachers = getAllTeachers();
  const id = normalizeEmail(teacher.teacherId || teacher.email);
  teachers[id] = {
    ...teachers[id],
    tokenRequestStatus: 'pending',
    tokenRequestedAt: new Date().toISOString(),
    tokenRequestedPackageKey: selectedPackage.key,
    tokenRequestedTokens: selectedPackage.tokens || 0,
    tokenRequestedAmount: selectedPackage.price || 0,
    tokenRequestedDeviceId: selectedPackage.unlimitedDays ? getAppDeviceId() : '',
    updatedAt: new Date().toISOString()
  };
  saveAllTeachers(teachers);
  const sharedSyncOk = await syncSharedKeys([STORAGE_KEYS.teachers]);
  showNotification(sharedSyncOk ? 'Token purchase request saved.' : `Token purchase request saved locally. ${getSharedSyncWarningMessage()}`, sharedSyncOk ? 'success' : 'warning', 6000);
  const support = getSupportSettings();
  const teacherName = getTeacherDisplayName(teacher, { fallback: id });
  const teacherPhone = getTeacherPhoneLabel(teacher, { fallback: '' });
  const subject = encodeURIComponent('OPE Assessor Token Purchase Request');
  const packageDescription = selectedPackage.unlimitedDays
    ? `${selectedPackage.label} (${selectedPackage.unlimitedDays} days, ${formatNaira(selectedPackage.price)})`
    : `${selectedPackage.label} (${selectedPackage.tokens} Token${selectedPackage.tokens === 1 ? '' : 's'}, ${formatNaira(selectedPackage.price)})`;
  const body = encodeURIComponent(`Hello Admin,\n\nI want to request a paid OPE Assessor token package.\n\nTeacher Name: ${teacherName}\nTeacher ID: ${id}${teacherPhone ? `\nPhone Number: ${teacherPhone}` : ''}\nRequested package: ${packageDescription}\nCurrent device ID: ${getAppDeviceId()}\nRequest time: ${new Date().toLocaleString()}\n\nRegards,\n${teacherName}`);
  if (contactChannel === 'email') {
    if (!support.email) return showNotification('Support email has not been set yet', 'error');
    window.location.href = `mailto:${encodeURIComponent(support.email)}?subject=${subject}&body=${body}`;
  } else if (contactChannel === 'whatsapp') {
    const phone = normalizeWhatsappNumber(support.whatsapp || '');
    if (!phone) return showNotification('Support WhatsApp number has not been set yet', 'error');
    window.open(`https://wa.me/${phone}?text=${body}`, '_blank', 'noopener');
  }
  render();
}

function showLicenseRequired() {
  const status = getTeacherLicenseStatus();
  const teacher = getCurrentTeacher() || {};
  const pricingList = buildLicensePricingListMarkup();
  const selectedPlan = (teacher.tokenRequestedPackageKey || 'starter').toString().trim().toLowerCase();
  let modal = document.getElementById('licenseRequiredModal'); if (modal) modal.remove();
  modal = document.createElement('div'); modal.id='licenseRequiredModal'; modal.style.position='fixed'; modal.style.inset='0'; modal.style.background='rgba(15,23,42,.45)'; modal.style.zIndex=30000; modal.style.display='flex'; modal.style.alignItems='center'; modal.style.justifyContent='center';
  const inner = document.createElement('div'); inner.className='card-beautiful p-6'; inner.style.width='min(520px,94%)';
  inner.innerHTML = `
    <div class="h2">${escapeHtml(status.label)}</div>
    <p class="small">${escapeHtml(status.detail)}</p>
    <p class="small">${escapeHtml(getTeacherPurchaseSummary(teacher))}</p>
    <p class="small">1 Token = 1 Quiz = ${formatNaira(TOKEN_PRICE_PER_QUIZ)}. Token deductions happen only when you save a brand-new quiz. Editing an existing quiz will not deduct a token.</p>
    <div class="small" style="margin-top:10px"><strong>Token bundles and unlimited</strong></div>
    <ul class="small" style="margin:8px 0 0 18px;line-height:1.8">${pricingList}</ul>
    <label class="small" style="display:block;margin-top:14px">Select package</label>
    <select id="licensePlanSelect" class="input-beautiful" style="margin-top:6px">
      ${getTokenPackageCatalog().map((tokenPackage) => `<option value="${tokenPackage.key}" ${selectedPlan === tokenPackage.key ? 'selected' : ''}>${escapeHtml(tokenPackage.label)}</option>`).join('')}
    </select>
    <div class="small" style="margin-top:12px;line-height:1.6">Current device ID: <strong>${escapeHtml(getAppDeviceId())}</strong>${status.wrongDevice ? '<br>Your unlimited plan is on another device. Copy this device ID and ask admin to transfer it if you want unlimited here.' : ''}</div>
    <div style="display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin-top:18px">
      <button id="closeLicenseRequired" class="btn btn-ghost">Close</button>
      <button id="requestLicenseEmailBtn" class="btn btn-ghost">Request by Email</button>
      <button id="requestLicenseWhatsappBtn" class="btn btn-primary">Request by WhatsApp</button>
    </div>
  `;
  modal.appendChild(inner); document.body.appendChild(modal);
  document.getElementById('closeLicenseRequired').onclick = () => modal.remove();
  document.getElementById('requestLicenseEmailBtn').onclick = () => {
    modal.remove();
    requestTeacherLicense(document.getElementById('licensePlanSelect')?.value || 'starter', 'email');
  };
  document.getElementById('requestLicenseWhatsappBtn').onclick = () => {
    modal.remove();
    requestTeacherLicense(document.getElementById('licensePlanSelect')?.value || 'starter', 'whatsapp');
  };
}

function requireTeacher() {
  if (isTeacherLoggedIn()) return true;
  state.view = 'teacher.login';
  return false;
}

function logoutTeacher() {
  localStorage.removeItem(STORAGE_KEYS.teacherSession);
  // Best-effort server logout — fire and forget so the UI never blocks on it.
  if (canUseNetworkSync() && getAuthSessionToken()) {
    fetch(buildApiUrl('/api/auth/logout'), {
      method: 'POST',
      headers: withAuthHeader({ 'Content-Type': 'application/json' }),
      body: '{}',
      cache: 'no-store'
    }).catch(() => {});
  }
  clearStoredAuthSession();
  state.teacherId = '';
  state.currentQuiz = null;
  state.view = 'teacher.login';
  render();
}

function addStudentsToTeacher(list, sourceQuizId = '') {
  if (!state.teacherId || !Array.isArray(list) || !list.length) return;
  const all = getAllTeacherStudents();
  const key = normalizeEmail(state.teacherId);
  const existing = all[key] || [];
  const byKey = {};
  existing.forEach(s => {
    byKey[normalizeEmail(s.email || s.id || s.registrationNo || s.name)] = s;
  });
  list.forEach(item => {
    const student = {
      name: (item.name || '').toString().trim(),
      email: (item.email || '').toString().trim(),
      id: (item.id || item.registrationNo || '').toString().trim(),
      registrationNo: (item.registrationNo || item.id || '').toString().trim(),
      className: normalizeClassName(item.className || item.class || ''),
      sourceQuizId,
      uploadedAt: item.uploadedAt || new Date().toISOString(),
      updatedAt: item.updatedAt || new Date().toISOString()
    };
    const studentKey = normalizeEmail(student.email || student.id || student.registrationNo || student.name);
    if (studentKey) {
      byKey[studentKey] = { ...(byKey[studentKey] || {}), ...student };
      delete byKey[studentKey].deletedAt;
      delete byKey[studentKey].deletedBy;
    }
  });
  all[key] = Object.values(byKey);
  saveAllTeacherStudents(all);
}

function getTeacherStudents(options = {}) {
  return getStudentsForTeacher(state.teacherId, options);
}

function getStudentsForTeacher(teacherId = state.teacherId, options = {}) {
  const includeDeleted = !!options.includeDeleted;
  const list = getAllTeacherStudents()[normalizeEmail(teacherId)] || [];
  return includeDeleted ? list : list.filter((student) => !isDeletedStudent(student));
}

function saveStudentsForTeacher(teacherId, students = [], options = {}) {
  const all = getAllTeacherStudents();
  const teacherKey = normalizeEmail(teacherId);
  const nextStudents = Array.isArray(students) ? students.slice() : [];
  const existingDeleted = options.keepDeleted === false
    ? []
    : (all[teacherKey] || []).filter(isDeletedStudent);
  all[teacherKey] = mergeStudentListsForSync(nextStudents, existingDeleted);
  saveAllTeacherStudents(all);
}

function getStudentClassGroups(teacherId = state.teacherId) {
  const grouped = {};
  getStudentsForTeacher(teacherId).forEach((student) => {
    const className = normalizeClassName(student.className || student.class || '') || 'Unassigned';
    if (!grouped[className]) grouped[className] = [];
    grouped[className].push(student);
  });
  Object.keys(grouped).forEach((className) => {
    grouped[className] = grouped[className].slice().sort((left, right) => (left.name || '').localeCompare(right.name || ''));
  });
  return grouped;
}

function getClassFilterKey(teacherId, scope = 'teacher') {
  return `${scope}:${normalizeEmail(teacherId)}`;
}

function getSelectedClassFilter(teacherId, scope = 'teacher') {
  return state.classFilters[getClassFilterKey(teacherId, scope)] || '';
}

function setSelectedClassFilter(teacherId, value, scope = 'teacher') {
  state.classFilters[getClassFilterKey(teacherId, scope)] = normalizeClassName(value);
}

function upsertStudentForTeacher(teacherId, incomingStudent, sourceQuizId = '') {
  const students = getStudentsForTeacher(teacherId, { includeDeleted: true }).slice();
  const student = {
    name: (incomingStudent.name || '').toString().trim(),
    email: (incomingStudent.email || '').toString().trim(),
    id: (incomingStudent.id || incomingStudent.registrationNo || '').toString().trim(),
    registrationNo: (incomingStudent.registrationNo || incomingStudent.id || '').toString().trim(),
    className: normalizeClassName(incomingStudent.className || incomingStudent.class || ''),
    sourceQuizId: incomingStudent.sourceQuizId || sourceQuizId || '',
    uploadedAt: incomingStudent.uploadedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const key = normalizeEmail(student.email || student.id || student.registrationNo || student.name);
  if (!key) return false;
  const index = students.findIndex((item) => normalizeEmail(item.email || item.id || item.registrationNo || item.name) === key);
  if (index >= 0) {
    students[index] = { ...students[index], ...student };
    delete students[index].deletedAt;
    delete students[index].deletedBy;
  }
  else students.push(student);
  saveStudentsForTeacher(teacherId, students);
  return true;
}

function removeStudentForTeacher(teacherId, student) {
  const students = getStudentsForTeacher(teacherId, { includeDeleted: true }).slice();
  const targetKey = normalizeEmail(student?.email || student?.id || student?.registrationNo || student?.name);
  const index = students.findIndex((item) => normalizeEmail(item.email || item.id || item.registrationNo || item.name) === targetKey);
  if (index < 0) return false;
  const deletedAt = new Date().toISOString();
  students[index] = {
    ...students[index],
    deletedAt,
    deletedBy: normalizeEmail(state.teacherId || teacherId || 'teacher'),
    updatedAt: deletedAt
  };
  saveStudentsForTeacher(teacherId, students);
  return true;
}

function ensureSuperAdminAccount() {
  const teachers = getAllTeachers();
  const id = normalizeEmail(SUPER_ADMIN_EMAIL);
  const existing = teachers[id] || {};
  // The super-admin record never carries password material — auth happens via
  // server env vars (POST /api/auth/super-admin/login). Strip any legacy field
  // that may have been written by older client builds.
  const sanitized = { ...existing };
  delete sanitized.password;
  delete sanitized.passwordHash;
  teachers[id] = {
    ...sanitized,
    teacherId: id,
    email: id,
    role: 'super_admin',
    name: existing.name || '',
    phone: existing.phone || '',
    supportEmail: existing.supportEmail || DEFAULT_SUPPORT_SETTINGS.email,
    supportWhatsapp: existing.supportWhatsapp || DEFAULT_SUPPORT_SETTINGS.whatsapp,
    tokenBalance: existing.tokenBalance ?? Number.MAX_SAFE_INTEGER,
    tokenUpdatedAt: existing.tokenUpdatedAt || new Date().toISOString(),
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  saveAllTeachers(teachers);
}

// Normalize email helper
function normalizeEmail(email) {
  try { return (email || '').toString().trim().toLowerCase(); } catch(e) { return ''; }
}

// Migrate existing submissions: normalize emails and deduplicate by quizId+email (keep latest)
function migrateAndNormalizeSubmissions() {
  try {
    const subs = getAllSubmissions({ includeDeleted: true }) || [];
    const map = {};
    const usedShareKeys = new Set();
    let mutated = false;
    for (const rawSubmission of subs) {
      const s = rawSubmission && rawSubmission.submissionId ? { ...rawSubmission } : { ...rawSubmission, submissionId: buildSubmissionIdentity(rawSubmission) };
      if (!(rawSubmission && rawSubmission.submissionId)) mutated = true;
      let shareKey = (s.shareKey || '').toString().trim().toLowerCase();
      if (!shareKey || usedShareKeys.has(shareKey)) {
        let attempt = 0;
        do {
          shareKey = buildSubmissionShareKeyCandidate(s, attempt);
          attempt += 1;
        } while (usedShareKeys.has(shareKey) && attempt < 64);
        s.shareKey = shareKey;
        s.shareKeyUpdatedAt = s.shareKeyUpdatedAt || new Date().toISOString();
        mutated = true;
      }
      usedShareKeys.add(shareKey);
      const key = s.submissionId;
      if (!map[key]) map[key] = s;
      else {
        const a = map[key];
        const b = s;
        const at = getRecordStamp(a);
        const bt = getRecordStamp(b);
        if (bt >= at) map[key] = b; // keep latest
      }
    }
    const out = Object.values(map).sort(sortSubmissionRecords);
    if (mutated || JSON.stringify(out) !== JSON.stringify(subs)) save(STORAGE_KEYS.submissions, out);
  } catch (e) { console.warn('Migration error', e); }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function gen6Digit() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function makeQuestionId(question, index = 0) {
  const raw = [
    question._sourceId || question.id || '',
    question.subject || question._subject || '',
    question.question || '',
    (question.options || []).join('|'),
    question.answer || '',
    index
  ].join('::');
  let hash = 0;
  for (let i = 0; i < raw.length; i++) hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  return 'q_' + Math.abs(hash).toString(36);
}

function normalizeRichText(value) {
  return (value == null ? '' : String(value)).replace(/\r\n?/g, '\n');
}

function hasRichTextMarkup(value = '') {
  return /<(\/?)(b|strong|i|em|u|sub|sup|ul|ol|li|p|div|span|font|br)\b/i.test((value || '').toString());
}

function getRichTextStyleFlags(node) {
  const tagName = (node && node.tagName ? node.tagName : '').toUpperCase();
  const styleText = (node && typeof node.getAttribute === 'function' ? (node.getAttribute('style') || '') : '').toString().toLowerCase();
  const textDecoration = (styleText.match(/text-decoration(?:-line)?\s*:\s*([^;]+)/i) || [])[1] || '';
  const fontWeight = (styleText.match(/font-weight\s*:\s*([^;]+)/i) || [])[1] || '';
  const fontStyle = (styleText.match(/font-style\s*:\s*([^;]+)/i) || [])[1] || '';
  const verticalAlign = (styleText.match(/vertical-align\s*:\s*([^;]+)/i) || [])[1] || '';
  return {
    bold: tagName === 'B' || tagName === 'STRONG' || /bold|bolder/.test(fontWeight) || /^[5-9]00$/.test(fontWeight.trim()),
    italic: tagName === 'I' || tagName === 'EM' || /italic|oblique/.test(fontStyle),
    underline: tagName === 'U' || /underline/.test(textDecoration),
    superscript: tagName === 'SUP' || /\bsuper\b/.test(verticalAlign),
    subscript: tagName === 'SUB' || /\bsub\b/.test(verticalAlign)
  };
}

function wrapRichTextNodeWithTag(node, tagName, doc) {
  const wrapper = doc.createElement(tagName);
  wrapper.appendChild(node);
  return wrapper;
}

function applyRichTextFormatting(node, flags, doc) {
  let formattedNode = node;
  if (flags.superscript && !flags.subscript) formattedNode = wrapRichTextNodeWithTag(formattedNode, 'sup', doc);
  if (flags.subscript && !flags.superscript) formattedNode = wrapRichTextNodeWithTag(formattedNode, 'sub', doc);
  if (flags.underline) formattedNode = wrapRichTextNodeWithTag(formattedNode, 'u', doc);
  if (flags.italic) formattedNode = wrapRichTextNodeWithTag(formattedNode, 'em', doc);
  if (flags.bold) formattedNode = wrapRichTextNodeWithTag(formattedNode, 'strong', doc);
  return formattedNode;
}

function cloneSafeRichTextNode(node, doc) {
  if (!node) return null;
  if (node.nodeType === Node.TEXT_NODE) {
    return doc.createTextNode(sanitizeScientificText(node.textContent || ''));
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return doc.createTextNode('');
  }
  const tagName = (node.tagName || '').toUpperCase();
  const blockTags = new Set(['UL', 'OL', 'LI', 'P', 'DIV']);
  if (tagName === 'BR') return doc.createElement('br');
  const safeChildren = doc.createDocumentFragment();
  Array.from(node.childNodes || []).forEach((child) => {
    const safeChild = cloneSafeRichTextNode(child, doc);
    if (safeChild) safeChildren.appendChild(safeChild);
  });
  const formattedChildren = applyRichTextFormatting(safeChildren, getRichTextStyleFlags(node), doc);
  if (blockTags.has(tagName)) {
    const safeBlock = doc.createElement(tagName.toLowerCase());
    safeBlock.appendChild(formattedChildren);
    return safeBlock;
  }
  return formattedChildren;
}

function renderRichTextHtml(value = '') {
  const raw = normalizeRichText(value);
  if (!raw) return '';
  if (!hasRichTextMarkup(raw)) {
    return escapeHtml(sanitizeScientificText(raw)).replace(/\n/g, '<br>');
  }
  const input = document.createElement('div');
  input.innerHTML = raw;
  const output = document.createElement('div');
  Array.from(input.childNodes || []).forEach((node) => {
    const safeNode = cloneSafeRichTextNode(node, output.ownerDocument);
    if (safeNode) output.appendChild(safeNode);
  });
  return output.innerHTML
    .replace(/(?:<br>\s*){3,}/g, '<br><br>')
    .replace(/(<(?:p|div)><br><\/(?:p|div)>)+/gi, '<br>');
}

function getRichTextPlainText(value = '') {
  const raw = normalizeRichText(value);
  if (!raw) return '';
  if (!hasRichTextMarkup(raw)) return sanitizeScientificText(raw);
  const host = document.createElement('div');
  host.innerHTML = renderRichTextHtml(raw);
  return normalizeRichText(host.innerText || host.textContent || '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getEditorFieldStorageValue(field) {
  if (!field) return '';
  if (field.dataset && field.dataset.richInput === 'true') {
    return renderRichTextHtml(field.innerHTML || '');
  }
  return normalizeRichText(field.value || field.textContent || '');
}

function buildRichEditorToolbarMarkup() {
  const actions = [
    { label: 'B', command: 'bold', title: 'Bold' },
    { label: 'I', command: 'italic', title: 'Italic' },
    { label: 'U', command: 'underline', title: 'Underline' },
    { label: 'Sup', command: 'superscript', title: 'Superscript' },
    { label: 'Sub', command: 'subscript', title: 'Subscript' },
    { label: '• List', command: 'insertUnorderedList', title: 'Bullet List' },
    { label: '1. List', command: 'insertOrderedList', title: 'Numbered List' },
    { label: 'Clear', command: 'removeFormat', title: 'Clear Formatting' }
  ];
  return `
    <div class="rich-editor-toolbar" data-rich-editor-toolbar="true">
      ${actions.map((action) => `
        <button type="button" class="rich-editor-btn" data-rich-command="${action.command}" title="${action.title}" aria-label="${action.title}">
          ${action.label}
        </button>
      `).join('')}
    </div>
  `;
}

function buildRichEditorFieldMarkup(label, className, value = '', options = {}) {
  const minHeight = options.minHeight || '88px';
  return `
    <div class="subject-field">
      <label class="small">${escapeHtml(label)}</label>
      <div class="rich-editor-shell" data-rich-editor-shell="true">
        ${buildRichEditorToolbarMarkup()}
        <div
          class="input-beautiful preserve-format rich-editor-input ${className}"
          data-rich-input="true"
          contenteditable="true"
          spellcheck="true"
          style="min-height:${minHeight}"
        >${renderRichTextHtml(value)}</div>
      </div>
    </div>
  `;
}

function wireRichTextEditors(root = document) {
  root.querySelectorAll('[data-rich-editor-shell="true"]').forEach((shell) => {
    if (shell.dataset.richEditorReady === 'true') return;
    shell.dataset.richEditorReady = 'true';
    const editor = shell.querySelector('[data-rich-input="true"]');
    if (!editor) return;

    const normalizeEditor = () => {
      const normalized = renderRichTextHtml(editor.innerHTML || '');
      editor.innerHTML = normalized;
      if (!getRichTextPlainText(normalized)) editor.innerHTML = '';
    };

    shell.querySelectorAll('[data-rich-command]').forEach((button) => {
      button.onclick = (event) => {
        event.preventDefault();
        editor.focus();
        const command = button.dataset.richCommand || '';
        if (!command || typeof document.execCommand !== 'function') return;
        document.execCommand(command, false, null);
        normalizeEditor();
      };
    });

    editor.addEventListener('paste', (event) => {
      event.preventDefault();
      const text = (event.clipboardData || window.clipboardData)?.getData('text/plain') || '';
      if (typeof document.execCommand === 'function') {
        document.execCommand('insertText', false, text);
      }
      normalizeEditor();
    });

    editor.addEventListener('blur', normalizeEditor);
    normalizeEditor();
  });
}

function parseQuestionNumberList(value = '', maxCount = 0) {
  const numbers = (value || '').toString().split(',')
    .map((item) => parseInt(item.trim(), 10))
    .filter((item) => Number.isFinite(item) && item > 0);
  const unique = [...new Set(numbers)];
  return maxCount > 0 ? unique.filter((item) => item <= maxCount) : unique;
}

function normalizeQuestionImagePlacement(value = '') {
  return (value || '').toString().trim().toLowerCase() === 'after' ? 'after' : 'before';
}

function sanitizeQuestionMediaAssets(assets = []) {
  return (Array.isArray(assets) ? assets : []).map((asset, index) => ({
    id: asset?.id || `asset_${index + 1}`,
    src: (asset?.src || '').toString().trim(),
    placement: normalizeQuestionImagePlacement(asset?.placement),
    fileName: (asset?.fileName || '').toString().trim(),
    altText: (asset?.altText || 'Question image').toString().trim()
  })).filter((asset) => !!asset.src);
}

function normalizeSubjectQuestionImages(groups = []) {
  return (Array.isArray(groups) ? groups : []).map((group, index) => ({
    id: group?.id || `group_${index + 1}`,
    src: (group?.src || '').toString().trim(),
    placement: normalizeQuestionImagePlacement(group?.placement),
    fileName: (group?.fileName || '').toString().trim(),
    altText: (group?.altText || 'Question image').toString().trim(),
    questionNumbers: parseQuestionNumberList(group?.questionNumbers || '')
  })).filter((group) => !!group.src && group.questionNumbers.length);
}

function createEditableSubjectQuestionImage(group = {}, index = 0) {
  const numbers = Array.isArray(group?.questionNumbers)
    ? group.questionNumbers
    : parseQuestionNumberList(group?.questionNumbers || '');
  return {
    id: group?.id || `group_${Date.now()}_${index + 1}_${Math.random().toString(36).slice(2, 8)}`,
    src: (group?.src || '').toString().trim(),
    placement: normalizeQuestionImagePlacement(group?.placement),
    fileName: (group?.fileName || '').toString().trim(),
    altText: (group?.altText || 'Question image').toString().trim(),
    questionNumbersText: numbers.join(', ')
  };
}

function serializeEditableSubjectQuestionImages(groups = [], maxCount = 0) {
  return (Array.isArray(groups) ? groups : []).map((group, index) => ({
    id: group?.id || `group_${index + 1}`,
    src: (group?.src || '').toString().trim(),
    placement: normalizeQuestionImagePlacement(group?.placement),
    fileName: (group?.fileName || '').toString().trim(),
    altText: (group?.altText || 'Question image').toString().trim(),
    questionNumbers: parseQuestionNumberList(group?.questionNumbersText || group?.questionNumbers || '', maxCount)
  })).filter((group) => !!group.src && group.questionNumbers.length);
}

function stripQuestionMediaAssets(questions = []) {
  return (Array.isArray(questions) ? questions : []).map((question) => ({
    ...question,
    mediaAssets: []
  }));
}

function buildQuestionsWithSubjectImages(sourceQuestions = [], subjectName = 'General', questionImages = [], options = {}) {
  const normalizedSubjectName = (subjectName || 'General').toString().trim() || 'General';
  const normalizedQuestions = (Array.isArray(sourceQuestions) ? sourceQuestions : [])
    .filter(isMeaningfulQuestion)
    .map((question, index) => normalizeQuestionForStorage({ ...question, subject: normalizedSubjectName }, index, normalizedSubjectName));
  const normalizedImages = normalizeSubjectQuestionImages(questionImages);
  const replaceExistingMedia = !!options.replaceExistingMedia;
  const baseQuestions = replaceExistingMedia ? stripQuestionMediaAssets(normalizedQuestions) : normalizedQuestions;
  if (!normalizedImages.length) return baseQuestions;
  return applySubjectQuestionImagesToQuestions(baseQuestions, normalizedImages);
}

function deriveSubjectQuestionImagesFromQuestions(questions = []) {
  const grouped = new Map();
  (Array.isArray(questions) ? questions : []).forEach((question, questionIndex) => {
    sanitizeQuestionMediaAssets(question?.mediaAssets || []).forEach((asset) => {
      const key = [asset.src, asset.placement, asset.fileName, asset.altText].join('||');
      if (!grouped.has(key)) {
        grouped.set(key, {
          id: asset.id || `group_${grouped.size + 1}`,
          src: asset.src,
          placement: asset.placement,
          fileName: asset.fileName,
          altText: asset.altText,
          questionNumbers: []
        });
      }
      grouped.get(key).questionNumbers.push(questionIndex + 1);
    });
  });
  return Array.from(grouped.values()).map((item) => ({
    ...item,
    questionNumbers: [...new Set(item.questionNumbers)].sort((left, right) => left - right)
  }));
}

function applySubjectQuestionImagesToQuestions(questions = [], questionImages = []) {
  const nextQuestions = (Array.isArray(questions) ? questions : []).map((question) => ({
    ...question,
    mediaAssets: sanitizeQuestionMediaAssets(question?.mediaAssets || [])
  }));
  normalizeSubjectQuestionImages(questionImages).forEach((group) => {
    group.questionNumbers.forEach((questionNumber) => {
      const question = nextQuestions[questionNumber - 1];
      if (!question) return;
      const mediaAssets = sanitizeQuestionMediaAssets(question.mediaAssets || []);
      const nextAsset = {
        id: `${group.id}_${questionNumber}`,
        src: group.src,
        placement: group.placement,
        fileName: group.fileName,
        altText: group.altText || 'Question image'
      };
      const alreadyExists = mediaAssets.some((asset) => (
        asset.src === nextAsset.src
        && normalizeQuestionImagePlacement(asset.placement) === nextAsset.placement
        && (asset.fileName || '') === (nextAsset.fileName || '')
        && (asset.altText || '') === (nextAsset.altText || '')
      ));
      if (!alreadyExists) mediaAssets.push(nextAsset);
      question.mediaAssets = mediaAssets;
    });
  });
  return nextQuestions;
}

function getQuestionMediaAssets(question = {}, placement = 'before') {
  const normalizedPlacement = normalizeQuestionImagePlacement(placement);
  return sanitizeQuestionMediaAssets(question?.mediaAssets || []).filter((asset) => asset.placement === normalizedPlacement);
}

function renderQuestionMediaAssets(question = {}, placement = 'before') {
  const assets = getQuestionMediaAssets(question, placement);
  if (!assets.length) return '';
  return `
    <div class="question-media-stack" style="display:grid;gap:12px;margin:12px 0">
      ${assets.map((asset) => `
        <figure class="question-media-card" style="margin:0;border:1px solid #BFDBFE;border-radius:16px;background:#EFF6FF;padding:12px">
          <img src="${asset.src.replace(/"/g, '&quot;')}" alt="${escapeHtml((asset.altText || 'Question image'))}" style="display:block;max-width:100%;height:auto;border-radius:12px;margin:0 auto" />
        </figure>
      `).join('')}
    </div>
  `;
}

// Downscale + re-encode a base64 image data-URL to keep quiz payloads small
// enough to sync quickly (a 1600px PNG screenshot can be 1–3 MB; the same image
// at 1200px JPEG ~0.8 is usually well under 200 KB and still perfectly readable
// for a quiz question). Flattens transparency onto white before encoding to
// JPEG. Returns the original string unchanged if it isn't an image data-URL, if
// there's no DOM, if the image fails to load, or if re-encoding wouldn't help.
async function recompressDataUrlImage(dataUrl, options = {}) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return dataUrl;
  if (typeof document === 'undefined' || typeof Image === 'undefined') return dataUrl;
  const maxDim = Number(options.maxDim) > 0 ? Number(options.maxDim) : 1200;
  const quality = Number(options.quality) > 0 ? Number(options.quality) : 0.82;
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = dataUrl;
    });
    const ratio = Math.min(maxDim / (image.width || maxDim), maxDim / (image.height || maxDim), 1);
    const w = Math.max(1, Math.round((image.width || maxDim) * ratio));
    const h = Math.max(1, Math.round((image.height || maxDim) * ratio));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return dataUrl;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(image, 0, 0, w, h);
    const out = canvas.toDataURL('image/jpeg', quality);
    return (typeof out === 'string' && out.length && out.length < dataUrl.length) ? out : dataUrl;
  } catch (e) {
    return dataUrl;
  }
}

// Recompress a base64 image stored in localStorage before we send it over the
// wire. The threshold is on the data-URL string length (~1.37× the byte size),
// so ~220 KB string ≈ ~160 KB image — anything bigger gets re-encoded, and if
// it's still large after that, dropped to a smaller size/quality.
const QUIZ_MEDIA_RECOMPRESS_THRESHOLD = 220 * 1024;
async function shrinkOversizedDataUrlImage(src) {
  if (typeof src !== 'string' || !src.startsWith('data:image/')) return src;
  if (src.length <= QUIZ_MEDIA_RECOMPRESS_THRESHOLD) return src;
  let out = await recompressDataUrlImage(src, { maxDim: 1200, quality: 0.78 });
  if (out.length > QUIZ_MEDIA_RECOMPRESS_THRESHOLD * 1.6) {
    out = await recompressDataUrlImage(src, { maxDim: 850, quality: 0.7 });
  }
  return out;
}

// Walk a quiz's questions and shrink any oversized embedded images. Returns the
// same object reference when nothing changed, or a fresh copy with slimmed
// mediaAssets. Used right before a per-quiz cloud PUT so an image-heavy quiz
// (e.g. a maths paper with diagram screenshots) doesn't blow past the body
// limit or take forever to upload. Best-effort — never throws.
async function shrinkQuizMediaForSync(quiz) {
  if (!quiz || typeof quiz !== 'object' || !Array.isArray(quiz.subjects)) return quiz;
  let changed = false;
  const shrinkQuestionList = async (questions) => {
    if (!Array.isArray(questions) || !questions.length) return questions;
    let listChanged = false;
    const next = await Promise.all(questions.map(async (q) => {
      const assets = q && Array.isArray(q.mediaAssets) ? q.mediaAssets : null;
      if (!assets || !assets.length) return q;
      let assetsChanged = false;
      const nextAssets = await Promise.all(assets.map(async (asset) => {
        const src = asset && typeof asset.src === 'string' ? asset.src : '';
        if (!src.startsWith('data:image/') || src.length <= QUIZ_MEDIA_RECOMPRESS_THRESHOLD) return asset;
        const slimmed = await shrinkOversizedDataUrlImage(src);
        if (slimmed && slimmed !== src) { assetsChanged = true; return { ...asset, src: slimmed }; }
        return asset;
      }));
      if (!assetsChanged) return q;
      listChanged = true;
      return { ...q, mediaAssets: nextAssets };
    }));
    if (listChanged) changed = true;
    return listChanged ? next : questions;
  };
  const subjects = await Promise.all(quiz.subjects.map(async (subject) => {
    if (!subject || typeof subject !== 'object') return subject;
    const questions = await shrinkQuestionList(subject.questions);
    const bankQuestions = await shrinkQuestionList(subject.bankQuestions);
    if (questions === subject.questions && bankQuestions === subject.bankQuestions) return subject;
    return { ...subject, questions, bankQuestions };
  }));
  return changed ? { ...quiz, subjects } : quiz;
}

function readImageFileAsDataUrl(file, options = {}) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('No image file selected'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Unable to read image file'));
    reader.onload = async () => {
      const source = reader.result;
      if (typeof source !== 'string' || !source.startsWith('data:image/')) return resolve(source);
      // Always normalise uploaded images to a sync-friendly size/quality rather
      // than only when they're huge — a 900px PNG screenshot is still megabytes.
      try {
        const maxDim = Number(options.maxWidth) > 0 ? Number(options.maxWidth) : 1200;
        const quality = Number(options.quality) > 0 ? Number(options.quality) : 0.82;
        resolve(await recompressDataUrlImage(source, { maxDim, quality }));
      } catch (e) {
        resolve(source);
      }
    };
    reader.readAsDataURL(file);
  });
}

// Supported question types. Default 'mcq' preserves backward compatibility
// for every quiz that already exists — no migration needed.
const QUESTION_TYPES = ['mcq', 'yesno', 'short', 'essay'];

function normalizeQuestionType(value) {
  const v = (value || 'mcq').toString().trim().toLowerCase();
  return QUESTION_TYPES.includes(v) ? v : 'mcq';
}

function inferQuizDefaultQuestionType(quiz) {
  if (!quiz || typeof quiz !== 'object') return 'mcq';
  if (quiz.defaultQuestionType) return normalizeQuestionType(quiz.defaultQuestionType);
  const counts = { mcq: 0, yesno: 0, short: 0, essay: 0 };
  (quiz.subjects || []).forEach((subject) => {
    const bank = (Array.isArray(subject?.bankQuestions) && subject.bankQuestions.length ? subject.bankQuestions : subject?.questions) || [];
    bank.forEach((question) => {
      const t = normalizeQuestionType(question && question.type);
      counts[t] = (counts[t] || 0) + 1;
    });
  });
  let topType = 'mcq';
  let topCount = -1;
  Object.keys(counts).forEach((type) => {
    if (counts[type] > topCount) { topType = type; topCount = counts[type]; }
  });
  return topType;
}

function normalizeAcceptedAnswers(value) {
  // Accept array, comma-separated string, or newline-separated string.
  let list = [];
  if (Array.isArray(value)) list = value;
  else if (typeof value === 'string') list = value.split(/\r?\n|,/);
  return list
    .map((entry) => (entry == null ? '' : entry.toString().trim()))
    .filter(Boolean);
}

function normalizeQuestionForStorage(question, index = 0, subjectName = 'General') {
  const type = normalizeQuestionType(question && question.type);
  const baseAnswer = (question && question.answer != null ? question.answer : '').toString().trim();
  const normalized = {
    ...question,
    type,
    question: normalizeRichText(question.question || ''),
    subject: question.subject || subjectName,
    topic: normalizeRichText(question.topic || ''),
    difficulty: question.difficulty || 'Medium',
    explanation: normalizeRichText(question.explanation || ''),
    learningPoint: normalizeRichText(question.learningPoint || ''),
    keyConcept: normalizeRichText(question.keyConcept || question.topic || ''),
    mediaAssets: sanitizeQuestionMediaAssets(question.mediaAssets || [])
  };
  if (type === 'mcq') {
    normalized.options = Array.isArray(question.options) ? question.options.map((option) => normalizeRichText(option)) : [];
    normalized.answer = baseAnswer.toUpperCase();
    delete normalized.acceptedAnswers;
  } else if (type === 'yesno') {
    // Store the canonical correct answer as 'Yes' or 'No'. Options are not used
    // — student renders two fixed radio buttons.
    const yesNoAnswer = /^(y(es)?|true|1)$/i.test(baseAnswer) ? 'Yes' : (/^(n(o)?|false|0)$/i.test(baseAnswer) ? 'No' : 'Yes');
    normalized.options = [];
    normalized.answer = yesNoAnswer;
    delete normalized.acceptedAnswers;
  } else if (type === 'short') {
    normalized.options = [];
    normalized.acceptedAnswers = normalizeAcceptedAnswers(question.acceptedAnswers || question.answer || '');
    // For convenience, keep `answer` as the first accepted spelling so legacy
    // displays still have something to show.
    normalized.answer = normalized.acceptedAnswers[0] || '';
  } else if (type === 'essay') {
    normalized.options = [];
    normalized.answer = '';
    delete normalized.acceptedAnswers;
  }
  normalized._sourceId = question._sourceId || question.id || makeQuestionId(normalized, index);
  return normalized;
}

function prepareQuestionForStudent(question, shuffleOptions) {
  const prepared = JSON.parse(JSON.stringify(question));
  prepared.options = Array.isArray(prepared.options) ? prepared.options.slice() : [];
  const correctLetter = (prepared.answer || '').toString().trim().toUpperCase();
  const correctIndex = correctLetter.charCodeAt(0) - 65;
  const correctText = prepared.options[correctIndex] || '';
  if (shuffleOptions && prepared.options.length) {
    shuffle(prepared.options);
    const newIndex = prepared.options.findIndex(opt => opt === correctText);
    if (newIndex >= 0) prepared.answer = String.fromCharCode(65 + newIndex);
  }
  prepared._correctText = correctText;
  return prepared;
}

function getQuestionCountForSubject(subject = {}) {
  const configuredCount = Number(subject?.questionCount);
  if (Number.isFinite(configuredCount) && configuredCount > 0) return configuredCount;
  const bankCount = Array.isArray(subject?.bankQuestions) ? subject.bankQuestions.length : 0;
  const questionCount = Array.isArray(subject?.questions) ? subject.questions.length : 0;
  return Math.max(bankCount, questionCount, 0);
}

function getSubjectTotalMarks(subject = {}) {
  const configured = Number(subject?.totalMarks ?? subject?.maxScore ?? subject?.maxGrade ?? 0);
  if (Number.isFinite(configured) && configured > 0) return Math.round(configured * 100) / 100;
  return getQuestionCountForSubject(subject);
}

function getQuizTotalMarks(quiz = {}, fallbackQuestions = []) {
  const subjectTotal = Array.isArray(quiz?.subjects)
    ? quiz.subjects.reduce((sum, subject) => sum + getSubjectTotalMarks(subject), 0)
    : 0;
  if (subjectTotal > 0) return Math.round(subjectTotal * 100) / 100;
  const configured = Number(quiz?.maxGrade);
  if (Number.isFinite(configured) && configured > 0) return Math.round(configured * 100) / 100;
  return Array.isArray(fallbackQuestions) ? fallbackQuestions.length : 0;
}

function getQuizSubjectMetaMap(quiz = {}) {
  const map = new Map();
  (quiz.subjects || []).forEach((subject, index) => {
    const name = (subject?.name || `Subject ${index + 1}`).toString().trim() || `Subject ${index + 1}`;
    map.set(normalizeSubjectName(name), {
      name,
      totalMarks: getSubjectTotalMarks(subject),
      questionCount: getQuestionCountForSubject(subject)
    });
  });
  return map;
}

function computeFacilityIndexFromQuizAndSubmissions(quiz = {}, submissions = []) {
  if (!quiz || typeof quiz !== 'object' || !quiz.id) return [];
  // Build a stable source-question map. This lets a 100-question bank with per-student
  // random 50-question draws analyze all 100 questions correctly.
  const quizQuestions = [];
  for (const subj of (quiz.subjects || [])) {
    const source = Array.isArray(subj.bankQuestions) && subj.bankQuestions.length ? subj.bankQuestions : subj.questions;
    const normalizedSource = buildQuestionsWithSubjectImages(source || [], subj.name || 'General', subj.questionImages || [], {
      replaceExistingMedia: Array.isArray(subj.questionImages)
    });
    for (let i = 0; i < normalizedSource.length; i++) {
      const q = normalizedSource[i];
      quizQuestions.push({
        _sourceId: q._sourceId,
        type: normalizeQuestionType(q.type),
        question: q.question || '',
        subject: subj.name || q.subject || 'General',
        topic: q.topic || '',
        explanation: q.explanation || '',
        learningPoint: q.learningPoint || '',
        keyConcept: q.keyConcept || q.topic || '',
        mediaAssets: sanitizeQuestionMediaAssets(q.mediaAssets || []),
        options: q.options || [],
        answer: q.answer || null,
        acceptedAnswers: Array.isArray(q.acceptedAnswers) ? q.acceptedAnswers : [],
        difficulty: q.difficulty || 'Medium'
      });
    }
  }

  const byId = {};
  quizQuestions.forEach((q, idx) => { byId[q._sourceId || makeQuestionId(q, idx)] = q; });

  const results = quizQuestions.map((qq, idx) => {
    const optionCounts = (qq.options || []).map((opt, optionIndex) => ({
      letter: String.fromCharCode(65 + optionIndex),
      option: opt,
      count: 0
    }));
    let seen = 0, attempted = 0, correct = 0, unanswered = 0;
    const liveQType = normalizeQuestionType(qq.type);
    const liveCorrectLetter = (qq.answer || '').toString().toUpperCase();
    const liveCorrectIndex = liveCorrectLetter.charCodeAt(0) - 65;
    const liveCorrectText = (qq.options || [])[liveCorrectIndex] || '';
    const liveAcceptedShort = Array.isArray(qq.acceptedAnswers) ? qq.acceptedAnswers.map((entry) => (entry || '').toString().trim().toLowerCase()) : [];
    submissions.forEach(submission => {
      const allQuestions = submission.allQuestions || [];
      const answerMap = submission.answers || {};
      allQuestions.forEach((studentQ, studentIndex) => {
        const sourceId = studentQ._sourceId || makeQuestionId(studentQ, studentIndex);
        if (sourceId !== qq._sourceId) return;
        seen++;
        const ans = answerMap[studentIndex];
        if (typeof ans === 'undefined' || ans === null || ans === '') {
          unanswered++;
          return;
        }
        attempted++;
        // Score against the LIVE quiz answer (not the snapshot) so question /
        // option edits reflect in correctness counts and the resulting
        // facility index ordering.
        let isCorrect = false;
        if (liveQType === 'mcq') {
          const chosenText = optionText(studentQ, ans);
          if (chosenText && liveCorrectText) isCorrect = (chosenText === liveCorrectText);
          else isCorrect = (ans.toString().toUpperCase() === liveCorrectLetter);
        } else if (liveQType === 'yesno') {
          isCorrect = ans.toString().trim().toLowerCase() === liveCorrectLetter.toLowerCase();
        } else if (liveQType === 'short') {
          const norm = ans.toString().trim().toLowerCase();
          isCorrect = liveAcceptedShort.some((entry) => entry === norm);
        }
        if (isCorrect) correct++;
        const chosenText = optionText(studentQ, ans);
        const originalOptionIndex = (qq.options || []).findIndex(opt => opt === chosenText);
        if (originalOptionIndex >= 0 && optionCounts[originalOptionIndex]) {
          optionCounts[originalOptionIndex].count++;
        }
      });
    });
    const fi = attempted > 0 ? (correct / attempted) : null;
    return {
      index: idx + 1,
      sourceId: qq._sourceId,
      subject: qq.subject,
      topic: qq.topic || '',
      explanation: qq.explanation || '',
      learningPoint: qq.learningPoint || '',
      keyConcept: qq.keyConcept || qq.topic || '',
      mediaAssets: sanitizeQuestionMediaAssets(qq.mediaAssets || []),
      question: qq.question,
      options: qq.options,
      answer: qq.answer,
      difficulty: qq.difficulty,
      correct,
      seen,
      attempted,
      unanswered,
      notSeen: Math.max(0, submissions.length - seen),
      optionCounts,
      facilityIndex: fi
    };
  });

  return results;
}

// Compute facility index for a quiz by aggregating stored submissions
function computeFacilityIndex(quizId) {
  const quiz = getAllQuizzes()[quizId];
  if (!quiz) return [];
  const submissions = getAllSubmissions().filter((submission) => submission.quizId === quizId);
  return computeFacilityIndexFromQuizAndSubmissions(quiz, submissions);
}

function getFacilityDifficultyBand(facilityIndex) {
  if (facilityIndex == null) return { label: 'No Attempts', shortLabel: 'No Attempts', min: 0, max: 0, color: '#F8FAFC', accent: '#CBD5E1', text: '#475569' };
  const percent = Math.round(facilityIndex * 100);
  if (percent >= 90) return { label: 'Very Easy', shortLabel: 'Very Easy', min: 90, max: 100, color: '#D1FAE5', accent: '#6EE7B7', text: '#111827' };
  if (percent >= 75) return { label: 'Easy', shortLabel: 'Easy', min: 75, max: 89, color: '#E0F2FE', accent: '#7DD3FC', text: '#111827' };
  if (percent >= 50) return { label: 'Moderate', shortLabel: 'Moderate', min: 50, max: 74, color: '#FEF9C3', accent: '#FDE68A', text: '#111827' };
  if (percent >= 30) return { label: 'Difficult', shortLabel: 'Difficult', min: 30, max: 49, color: '#FFE4E6', accent: '#FDA4AF', text: '#111827' };
  return { label: 'Very Difficult', shortLabel: 'Very Difficult', min: 0, max: 29, color: '#FEE2E2', accent: '#FCA5A5', text: '#111827' };
}

function getFacilityAnalysisSummary(items = []) {
  const usable = items.filter((item) => item.facilityIndex != null);
  const average = usable.length ? Math.round((usable.reduce((sum, item) => sum + item.facilityIndex, 0) / usable.length) * 100) : 0;
  const counts = { veryEasy: 0, easy: 0, moderate: 0, difficult: 0, veryDifficult: 0 };
  usable.forEach((item) => {
    const label = getFacilityDifficultyBand(item.facilityIndex).label;
    if (label === 'Very Easy') counts.veryEasy++;
    else if (label === 'Easy') counts.easy++;
    else if (label === 'Moderate') counts.moderate++;
    else if (label === 'Difficult') counts.difficult++;
    else if (label === 'Very Difficult') counts.veryDifficult++;
  });
  const total = usable.length || 1;
  return {
    average,
    totalQuestions: items.length,
    counts,
    percentages: {
      easy: Math.round(((counts.veryEasy + counts.easy) / total) * 100),
      moderate: Math.round((counts.moderate / total) * 100),
      difficult: Math.round(((counts.difficult + counts.veryDifficult) / total) * 100)
    }
  };
}

function getQuizQuestionsForTaking(quiz) {
  let allQuestions = [];
  for (const subj of (quiz.subjects || [])) {
    const source = Array.isArray(subj.bankQuestions) && subj.bankQuestions.length ? subj.bankQuestions : subj.questions;
    let normalized = buildQuestionsWithSubjectImages(source || [], subj.name || 'General', subj.questionImages || [], {
      replaceExistingMedia: Array.isArray(subj.questionImages)
    }).map((question) => ({
      ...question,
      _subject: subj.name || question.subject || 'General'
    }));
    if (quiz.shuffleQs) shuffle(normalized);
    const subjectPickCount = parseInt(subj.questionCount || 0, 10) || 0;
    if (subjectPickCount > 0 && subjectPickCount < normalized.length) normalized = normalized.slice(0, subjectPickCount);
    allQuestions.push(...normalized);
  }
  if (quiz.shuffleQs) shuffle(allQuestions);
  return allQuestions.map(question => prepareQuestionForStudent(question, !!quiz.shuffleOpts));
}

function buildQuestionSubjectSections(questions = []) {
  const subjectMap = new Map();
  (Array.isArray(questions) ? questions : []).forEach((question, globalIndex) => {
    const subjectName = (question?._subject || question?.subject || 'General').toString().trim() || 'General';
    if (!subjectMap.has(subjectName)) subjectMap.set(subjectName, { name: subjectName, indices: [] });
    subjectMap.get(subjectName).indices.push(globalIndex);
  });
  return Array.from(subjectMap.values()).map((section, sectionIndex) => ({
    ...section,
    sectionIndex,
    total: section.indices.length,
    firstIndex: section.indices[0] ?? 0,
    lastIndex: section.indices[section.indices.length - 1] ?? 0
  }));
}

function getSubjectSectionIndexForQuestion(sections = [], questionIndex = 0) {
  const normalizedIndex = Math.max(0, Number(questionIndex) || 0);
  const foundIndex = sections.findIndex((section) => section.indices.includes(normalizedIndex));
  return foundIndex >= 0 ? foundIndex : 0;
}

function getQuestionPositionWithinSubject(sections = [], questionIndex = 0) {
  const sectionIndex = getSubjectSectionIndexForQuestion(sections, questionIndex);
  const section = sections[sectionIndex] || { name: 'General', indices: [questionIndex], total: 1, firstIndex: questionIndex, lastIndex: questionIndex };
  const localIndex = Math.max(0, section.indices.indexOf(questionIndex));
  return {
    sectionIndex,
    section,
    localIndex,
    localNumber: localIndex + 1,
    totalInSubject: section.total || section.indices.length || 1
  };
}

function countAnsweredQuestionsInSection(section, answers = {}) {
  if (!section || !Array.isArray(section.indices)) return 0;
  return section.indices.filter((globalIndex) => !!answers[globalIndex]).length;
}

function encodeQuizToLink(q, options = {}) {
  const base = window.location.href.split('?')[0];
  if (!q || !q.id) return base;
  if (options.portable) {
    return `${base}?q=${encodeURIComponent(q.id)}&import=${encodeQuizToPortablePayload(q)}`;
  }
  return `${base}?q=${encodeURIComponent(q.id)}`;
}

function parseQuizAccessInput(value) {
  const raw = (value || '').trim();
  if (!raw) return { code: '', link: '' };
  if (/^https?:\/\//i.test(raw)) return { code: '', link: raw };
  const qMatch = raw.match(/[?&]q=([^&]+)/i);
  if (qMatch) return { code: decodeURIComponent(qMatch[1]), link: raw };
  return { code: raw.replace(/\s+/g, ''), link: '' };
}

function decodeQuizFromString(encoded) {
  try {
    return JSON.parse(decodeTextFromBase64(decodeURIComponent(encoded)));
  } catch(e) { return null; }
}

// A portable-link / portable-code quiz carries no owner — stamp the importing
// teacher (if there is one) so a later push doesn't land in Supabase with an
// empty teacher_id and orphan all of that quiz's submissions on read.
function stampImportedQuizOwner(quiz) {
  if (!quiz || typeof quiz !== 'object') return quiz;
  if (normalizeEmail(quiz.teacherId || '')) return quiz;
  const email = normalizeEmail(state.teacherId || getTeacherId());
  if (!email) return quiz;
  quiz.teacherId = email;
  return quiz;
}

function resolveQuizFromAccess(access) {
  const all = getAllQuizzes();
  if (access && access.link) {
    try {
      const params = new URLSearchParams((new URL(access.link)).search);
      if (params.has('q')) {
        const matchedQuiz = all[params.get('q')] || null;
        if (matchedQuiz) return matchedQuiz;
      }
      if (params.has('import')) {
        const importedQuiz = stampImportedQuizOwner(decodeQuizFromString(params.get('import')));
        if (importedQuiz) {
          all[importedQuiz.id] = importedQuiz;
          saveAllQuizzes(all);
          return importedQuiz;
        }
      }
    } catch (e) {
      return null;
    }
  }
  if (access && access.code) {
    if (access.code.toUpperCase().startsWith(PORTABLE_QUIZ_CODE_PREFIX)) {
      const importedQuiz = stampImportedQuizOwner(decodeQuizFromString(access.code.slice(PORTABLE_QUIZ_CODE_PREFIX.length)));
      if (importedQuiz) {
        all[importedQuiz.id] = importedQuiz;
        saveAllQuizzes(all);
        return importedQuiz;
      }
      return null;
    }
    return all[access.code] || null;
  }
  return null;
}

function isTeacherWorkspaceView(view = state.view) {
  return !!view && view.startsWith('teacher') && view !== 'teacher.login';
}

function buildTeacherMobileNav() {
  const wrapper = document.createElement('div');
  wrapper.className = 'mobile-teacher-nav';
  const sections = [
    {
      title: 'Navigation',
      items: [
        { view: 'teacher', label: 'Overview' },
        { view: 'teacher.bank', label: 'Question Bank' }
      ]
    },
    {
      title: 'Manage',
      items: [
        { view: 'teacher.students', label: 'Students' },
        { view: 'teacher.settings', label: 'Settings' }
      ]
    },
    {
      title: 'Help',
      items: [
        { view: 'teacher.guide', label: 'User Guide' },
        { view: 'teacher.support', label: 'Support' }
      ]
    }
  ];
  wrapper.innerHTML = sections.map((section) => `
    <div class="mobile-teacher-nav-label">${escapeHtml(section.title)}</div>
    ${section.items.map((item) => `
      <button type="button" class="mobile-teacher-nav-btn ${state.view === item.view ? 'active' : ''}" data-view="${item.view}">
        ${escapeHtml(item.label)}
      </button>
    `).join('')}
  `).join('');
  setTimeout(() => {
    wrapper.querySelectorAll('.mobile-teacher-nav-btn').forEach((button) => {
      button.onclick = () => {
        state.view = button.dataset.view;
        render();
      };
    });
  }, 0);
  return wrapper;
}

// Pull out the quiz id a student is trying to open (a bare 6-digit code, or the
// ?q=<id> param of a magic link). Portable codes/links carry the whole quiz so
// they don't need a cloud fetch and return ''.
function quizIdFromAccess(access) {
  if (!access) return '';
  if (access.code) {
    const code = access.code.toString().trim();
    if (!code || code.toUpperCase().startsWith(PORTABLE_QUIZ_CODE_PREFIX)) return '';
    return code;
  }
  if (access.link) {
    try {
      const params = new URLSearchParams((new URL(access.link)).search);
      if (params.has('import')) return ''; // self-contained, no fetch needed
      return (params.get('q') || '').toString().trim();
    } catch (e) { return ''; }
  }
  return '';
}

// Fetch one quiz by id from the public GET /api/quizzes/<id>. This is THE path a
// student takes when all they have is the 6-digit code / magic link and the
// quiz isn't on this device yet. Single attempt — they can retry the button.
async function fetchQuizFromCloudByAccess(access) {
  const id = quizIdFromAccess(access);
  if (!id || !canUseNetworkSync()) return null;
  try {
    const res = await makeAbortableSyncFetch(buildApiUrl(`/api/quizzes/${encodeURIComponent(id)}`), {
      cache: 'no-store',
      headers: getAuthSessionToken() ? withAuthHeader({}) : {}
    });
    if (!res.ok) {
      console.warn('Quiz lookup failed for', id, '— HTTP', res.status);
      return null;
    }
    const payload = await res.json();
    const cloudQuiz = payload && payload.quiz && typeof payload.quiz === 'object' ? payload.quiz : null;
    if (!cloudQuiz || !cloudQuiz.id) {
      console.warn('Quiz lookup for', id, 'returned no quiz payload');
      return null;
    }
    // Merge the cloud quiz into local storage so subsequent lookups (and the
    // exam flow) find it. Don't re-upload — skipNetworkSync.
    const localQuizzes = getAllQuizzes({ includeDeleted: true });
    const merged = mergeRecordMapForSync(localQuizzes || {}, { [cloudQuiz.id]: cloudQuiz });
    saveAllQuizzes(merged, { skipNetworkSync: true });
    // Authenticated callers (the owner) also get this quiz's submissions back —
    // merge those too so the teacher's results view is current.
    if (Array.isArray(payload.submissions) && payload.submissions.length) {
      const localSubs = getAllSubmissions({ includeDeleted: true });
      const mergedSubs = mergeSubmissionListsForSync(localSubs || [], payload.submissions);
      saveAllSubmissions(mergedSubs, { includeDeleted: true, skipNetworkSync: true });
    }
    return cloudQuiz;
  } catch (e) {
    console.warn('Quiz lookup for', id, 'errored:', e && e.message ? e.message : e);
    return null;
  }
}

// One-shot per session: stamp the current teacher as owner on any local quiz
// that has no teacherId (so it stops being an "orphan"). These are the quizzes
// the rest of the app filters OUT of "your" quiz list and OUT of Force Sync
// Now, so they never make it into pushSingleQuizToCloud where the inline stamp
// lives — they sit on the cloud with an empty teacher_id column and the bulk
// submissions read silently drops every one of their results. After stamping
// we fire-and-forget a per-quiz auto-push for each one so the server's
// teacher_id column gets populated and the submissions become visible.
function reclaimOrphanLocalQuizzes() {
  const email = normalizeEmail(state.teacherId || getTeacherId());
  if (!email) return;
  const all = getAllStoredQuizzes();
  if (!all || typeof all !== 'object') return;
  const reclaimed = [];
  Object.keys(all).forEach((id) => {
    const q = all[id];
    if (!q || typeof q !== 'object') return;
    if (normalizeEmail(q.teacherId || '')) return; // already has an owner
    const claimed = { ...q, teacherId: email };
    all[id] = claimed;
    reclaimed.push(claimed);
  });
  if (!reclaimed.length) return;
  saveAllQuizzes(all, { skipNetworkSync: true });
  console.log(`Reclaimed ${reclaimed.length} local quiz(zes) without an owner for ${email}:`, reclaimed.map((q) => q.id));
  if (!canUseNetworkSync() || !getAuthSessionToken()) return;
  Promise.all(reclaimed.map((q) =>
    pushSingleQuizToCloud(q, { auto: true })
      .then((ok) => ({ id: q.id, ok }))
      .catch(() => ({ id: q.id, ok: false }))
  )).then((results) => {
    const ok = results.filter((r) => r.ok).map((r) => r.id);
    const bad = results.filter((r) => !r.ok).map((r) => r.id);
    if (ok.length) console.log(`Auto-resynced reclaimed quiz(zes):`, ok);
    if (bad.length) console.warn(`Failed to auto-resync some reclaimed quiz(zes):`, bad);
    // If we're on a teacher page, re-render so the new "Cloud synced" status
    // shows and a follow-up pull picks up the now-visible submissions.
    if (state.view && state.view.startsWith('teacher') && state.view !== 'teacher.login') render();
  }).catch(() => {});
}

// Pull ONE quiz + its submissions via GET /api/quizzes/<id>. This is the small,
// reliable read the teacher's results view uses — unlike GET /api/state, which
// ships every quiz (images and all) plus every submission and tends to die mid
// transfer on a flaky mobile connection (ERR_HTTP2_PING_FAILED). The quiz owner
// gets { quiz, submissions } back; merge both into local storage. Returns true
// if the call succeeded (the caller should then re-render).
async function pullQuizSubmissionsFromCloud(quizId) {
  const id = (quizId || '').toString().trim();
  if (!id || !canUseNetworkSync() || !getAuthSessionToken()) return false;
  try {
    const res = await makeAbortableSyncFetch(buildApiUrl(`/api/quizzes/${encodeURIComponent(id)}`), {
      cache: 'no-store',
      headers: withAuthHeader({})
    });
    if (!res.ok) {
      console.warn('Quiz/submissions pull failed for', id, '— HTTP', res.status);
      return false;
    }
    const payload = await res.json();
    if (!Array.isArray(payload.submissions)) {
      console.warn('Quiz/submissions pull for', id, '— response had no submissions array');
      return true;
    }
    const cloudSubs = payload.submissions.filter((s) => s && typeof s === 'object');
    console.log(`Quiz ${id}: cloud returned ${payload.submissions.length} row(s), ${cloudSubs.length} usable —`,
      cloudSubs.map((s) => ({ sid: s.submissionId, qid: s.quizId, email: s.email, when: s.submittedAt, deleted: !!s.deletedAt })));
    // Merge cloud over local (cloud as primary, so a live cloud copy can't be
    // beaten by a stale local one of the same id), then write straight to
    // storage — going through saveAllSubmissions re-merges local "deleted"
    // tombstones back in, which can hide a freshly-pulled live submission.
    const localStored = getAllStoredSubmissions();
    const merged = mergeSubmissionRecordsForSync(cloudSubs, Array.isArray(localStored) ? localStored : []);
    const forQuiz = merged.filter((s) => s && String(s.quizId) === String(id));
    const liveForQuiz = forQuiz.filter((s) => !isDeletedSubmission(s));
    console.log(`Quiz ${id}: after merge — ${liveForQuiz.length} live / ${forQuiz.length} total for this quiz, ${merged.length} submissions overall.`);
    const slimmed = slimSubmissionListForStorage(merged);
    const slimmedForQuiz = slimmed.filter((s) => s && String(s.quizId) === String(id));
    const wrote = writeSubmissionsToStorage(slimmed, id);
    if (wrote) {
      // localStorage now holds the canonical copy for this quiz; drop any
      // in-memory fallback we may have been keeping for it.
      _cloudSubmissionsFallback.delete(String(id));
      clearNetworkKeyDirty(STORAGE_KEYS.submissions);
      const storedForQuiz = getAllSubmissions().filter((s) => s && String(s.quizId) === String(id)).length;
      console.log(`Pulled ${payload.submissions.length} submission(s) for quiz ${id} from cloud; ${storedForQuiz} now stored locally for it.`);
    } else {
      // Even after shedding webcam frames the device couldn't hold the full
      // submissions array. Keep THIS quiz's submissions in memory for the rest
      // of the session so the Results view still renders them (it reads through
      // getAllStoredSubmissions, which overlays this map). The cloud keeps the
      // canonical record — nothing is lost.
      _cloudSubmissionsFallback.set(String(id), slimmedForQuiz);
      console.error(`Quiz ${id}: localStorage is full — showing this quiz's ${slimmedForQuiz.length} submission(s) straight from the cloud without persisting them. Ask the teacher to clear old browsing data.`);
    }
    return true;
  } catch (e) {
    console.warn('Quiz/submissions pull errored for', id, ':', e && e.message ? e.message : e);
    return false;
  }
}

// Refresh the shared state once when the teacher navigates into (or between)
// their dashboard pages so new student submissions / attempts appear. This is
// the read-side counterpart to manual sync: it's reactive to an actual
// navigation (not a timer, not focus/visibilitychange), and a 60s throttle
// keeps it from turning back into the egress-heavy 15s polling loop.
function maybePullSharedStateOnTeacherNav(previousView) {
  const view = state.view || '';
  if (!view.startsWith('teacher') || view === 'teacher.login') return;
  if (view === previousView) return;
  if (!canUseNetworkSync() || !getAuthSessionToken()) return;
  if (Date.now() - Math.max(_lastTeacherNavPullAt, lastNetworkPullAt) < 60000) return;
  _lastTeacherNavPullAt = Date.now();
  pullSharedStateSilently({
    forcePull: true,
    timeoutMs: DEFAULT_TEACHER_NAV_SYNC_TIMEOUT_MS,
    forceRenderOnLate: true
  })
    .then((changed) => { if (changed) applySharedStateUiRefresh(true, { forceRender: true }); })
    .catch(() => {});
}

async function resolveQuizFromAccessWithSync(access) {
  let quiz = resolveQuizFromAccess(access);
  if (quiz || !canUseNetworkSync()) return quiz;
  // Students have no session, so the bulk GET /api/state is a guaranteed no-op
  // for them — go straight to the public per-quiz endpoint.
  await fetchQuizFromCloudByAccess(access);
  quiz = resolveQuizFromAccess(access);
  if (quiz) return quiz;
  // Logged-in teachers can still fall back to the full snapshot pull.
  if (getAuthSessionToken()) {
    await pullSharedStateSilently({ forcePull: true, timeoutMs: 5000 });
    quiz = resolveQuizFromAccess(access);
  }
  return quiz;
}

// ============================================================================
// RENDER ROOT (modified to route sidebar "Quizzes" to teacher.quizzes)
// ============================================================================

function render() {
  if (!_didCompactSubmissions) {
    compactStoredSubmissions();
    _didCompactSubmissions = true;
  }
  if (!_didFlushSubmissionOutbox) {
    _didFlushSubmissionOutbox = true;
    flushSubmissionOutbox().catch(() => {});
  }
  if (!_didReclaimOrphanQuizzes && normalizeEmail(state.teacherId || getTeacherId())) {
    reclaimOrphanLocalQuizzes();
    _didReclaimOrphanQuizzes = true;
  }
  const previousRenderedView = _lastRenderedView;
  if (previousRenderedView) captureViewScrollState(previousRenderedView);
  maybePullSharedStateOnTeacherNav(previousRenderedView);
  document.body.classList.toggle('pdf-route-active', state.view === 'pdf.render');
  document.body.classList.toggle('print-route-active', state.view === 'print.correction' || state.view === 'print.facility');
  const app = document.getElementById('app');
  if (state.view === 'pdf.render') {
    app.innerHTML = '';
    app.appendChild(renderPdfExportView());
    _lastRenderedView = state.view;
    persistAppUiState();
    return;
  }
  if (state.view === 'print.correction' || state.view === 'print.facility') {
    app.innerHTML = '';
    app.appendChild(renderPrintRouteView());
    _lastRenderedView = state.view;
    return;
  }
  if (window.history && !_historyApplying && state.view !== _lastHistoryView) {
    const historyState = { view: state.view, quizId: state.currentQuiz && state.currentQuiz.id ? state.currentQuiz.id : '' };
    const historyUrl = buildHistoryUrlForState();
    if (!_lastHistoryView) window.history.replaceState(historyState, '', historyUrl);
    else window.history.pushState(historyState, '', historyUrl);
    _lastHistoryView = state.view;
  }
  app.innerHTML = '';
  const headerAlerts = isTeacherLoggedIn() || isSuperAdmin() ? buildTeacherAlerts() : [];
  const unreadHeaderAlerts = getUnreadAlertCount(headerAlerts);

  // Topbar (updated with Home / Teacher / Student nav)
  const top = document.createElement('header');
  top.className = 'topbar';
  top.innerHTML = `
    <div class="container" style="display:flex;align-items:center;justify-content:space-between">
      <div style="display:flex;align-items:center;gap:12px">
        <img class="app-brand-mark" src="${APP_LOGO_SRC}" alt="OPE Assessor logo" />
        <div>
          <div class="title">OPE Assessor</div>
          <div class="small">Zero-friction assessments - privacy first</div>
        </div>
      </div>

      <div style="display:flex;align-items:center;gap:12px">
        <div class="header-nav" role="navigation" aria-label="Main">
          <button id="topHome" class="nav-btn">Home</button>
          <button id="topTeacher" class="nav-btn">Teacher</button>
          <button id="topStudent" class="nav-btn">Student</button>
        </div>
        <div class="top-actions">
          <button id="openTeacherQuiz" class="btn btn-ghost btn-sm">Open Quiz</button>
          ${isTeacherLoggedIn() || isSuperAdmin() ? '<button id="topSupport" class="btn btn-ghost btn-sm" aria-label="Support">Support</button>' : ''}
          ${isTeacherLoggedIn() || isSuperAdmin() ? `<button id="topAlerts" class="btn btn-ghost btn-sm${unreadHeaderAlerts ? ' has-unread' : ''}" aria-label="${unreadHeaderAlerts ? `${unreadHeaderAlerts} new alert${unreadHeaderAlerts === 1 ? '' : 's'}` : 'Notifications'}">Alerts${unreadHeaderAlerts ? ` <span class="alerts-pill">${unreadHeaderAlerts}</span>` : ''}</button>` : ''}
          <div class="small" id="userBadge">${escapeHtml(getTeacherUserBadgeLabel())}</div>
          ${isTeacherLoggedIn() ? '<button id="logoutTeacher" class="btn btn-ghost btn-sm">Logout</button>' : ''}
        </div>
      </div>
    </div>
  `;
  if (state.view !== 'take' && state.view !== 'student.result') app.appendChild(top);

  // Layout: sidebar + main
  const layout = document.createElement('div');
  layout.className = 'layout container';

  // Sidebar creation (no inline active logic)
  const sidebar = document.createElement('aside');
  sidebar.className = 'sidebar card';
  sidebar.innerHTML = `
    <div class="section-title">Navigation</div>
    <div id="navOverview" class="nav-item">Overview</div>
    <div id="navBank" class="nav-item">Question Bank</div>
    <div class="section-title">Manage</div>
    <div id="navStudents" class="nav-item">Students</div>
    <div id="navSettings" class="nav-item">Settings</div>
    <div class="section-title">Help</div>
    <div id="navGuide" class="nav-item">User Guide</div>
    <div id="navSupport" class="nav-item">Support</div>
  `;

  const main = document.createElement('main');
  main.className = 'main';

  // route dispatch (same as before)
  if (state.view === 'home') {
    const homeDiv = renderHomePage();
    main.appendChild(homeDiv);
  } else if (state.view === 'admin') {
    state.view = isSuperAdmin() ? 'teacher.settings' : 'teacher.login';
    return render();
  } else if (state.view === 'teacher.login') {
    main.appendChild(renderTeacherAuth());
  } else if (state.view === 'teacher') {
    if (!requireTeacher()) return render();
    main.appendChild(renderTeacherOverview());
  } else if (state.view === 'teacher.quizzes') {
    if (!requireTeacher()) return render();
    main.appendChild(renderTeacherQuizzes());
  } else if (state.view === 'teacher.bank') {
    if (!requireTeacher()) return render();
    main.appendChild(renderQuestionBankView());
  } else if (state.view === 'teacher.students') {
    if (!requireTeacher()) return render();
    main.appendChild(renderStudentsView());
  } else if (state.view === 'teacher.settings') {
    if (!requireTeacher()) return render();
    main.appendChild(renderSettingsView());
  } else if (state.view === 'teacher.guide') {
    if (!requireTeacher()) return render();
    main.appendChild(renderTeacherGuideView());
  } else if (state.view === 'teacher.support') {
    if (!requireTeacher()) return render();
    main.appendChild(renderTeacherSupportView());
  } else if (state.view === 'student') {
    main.appendChild(renderStudentEntry());
  } else if (state.view === 'student.result') {
    main.appendChild(renderResultLinkLanding());
  } else if (state.view === 'take') {
    main.appendChild(renderQuizTake());
  } else if (state.view === 'results' || state.view === 'teacher.results') {
    if (!requireTeacher()) return render();
    if (!state.currentQuiz) {
      state.view = isSuperAdmin() ? 'teacher' : 'teacher.quizzes';
      return render();
    }
    if (!canCurrentTeacherAccessQuiz(state.currentQuiz)) {
      state.currentQuiz = null;
      state.view = isSuperAdmin() ? 'teacher' : 'teacher.quizzes';
      showNotification('Access denied: this quiz belongs to another teacher', 'error');
      return render();
    }
    main.appendChild(renderResultsView());
  } else {
    // fallback: existing views
    // ...existing code...
  }

  if (isTeacherWorkspaceView()) {
    main.prepend(buildTeacherMobileNav());
  }

  if (state.view !== 'teacher.login' && state.view !== 'student' && state.view !== 'student.result' && state.view !== 'home' && state.view !== 'take' && state.view !== 'admin') layout.appendChild(sidebar);
  layout.appendChild(main);
  app.appendChild(layout);

  // Wire header and sidebar nav, set active classes
  setTimeout(() => {
    // header nav
    const topHomeBtn = document.getElementById('topHome');
    if (topHomeBtn) topHomeBtn.onclick = () => {
      if (state.view === 'student' || state.view === 'student.result') clearStudentEntryContext();
      state.view = 'home';
      render();
    };
    const topTeacherBtn = document.getElementById('topTeacher');
    if (topTeacherBtn) topTeacherBtn.onclick = async () => {
      if (state.view === 'student' || state.view === 'student.result') clearStudentEntryContext();
      await openTeacherWorkspace('teacher');
    };
    const topStudentBtn = document.getElementById('topStudent');
    if (topStudentBtn) topStudentBtn.onclick = () => {
      if (state.view === 'student.result') clearStudentEntryContext();
      state.view = 'student';
      render();
    };
    const openBtn = document.getElementById('openTeacherQuiz'); if (openBtn) openBtn.onclick = ()=> showTeacherAccessModal();
    const supportBtn = document.getElementById('topSupport'); if (supportBtn) supportBtn.onclick = () => openSupportChooser();
    const alertsBtn = document.getElementById('topAlerts'); if (alertsBtn) alertsBtn.onclick = () => showAlertsPanel();
    const logoutBtn = document.getElementById('logoutTeacher'); if (logoutBtn) logoutBtn.onclick = () => logoutTeacher();

    // sidebar nav handlers
    const navOverview = document.getElementById('navOverview');
    const navBank = document.getElementById('navBank');
    const navStudents = document.getElementById('navStudents');
    const navSettings = document.getElementById('navSettings');
    const navGuide = document.getElementById('navGuide');
    const navSupport = document.getElementById('navSupport');
    if (navOverview && navBank && navStudents && navSettings && navGuide && navSupport) {
      navOverview.onclick = () => { state.view = 'teacher'; render(); };
      navBank.onclick = () => { state.view = 'teacher.bank' ; render(); };
      navStudents.onclick = () => { state.view = 'teacher.students' ; render(); };
      navSettings.onclick = () => { state.view = 'teacher.settings' ; render(); };
      navGuide.onclick = () => { state.view = 'teacher.guide'; render(); };
      navSupport.onclick = () => { state.view = 'teacher.support'; render(); };

      // set active classes robustly
      document.querySelectorAll('.sidebar .nav-item').forEach(n => n.classList.remove('active'));
      if (state.view === 'teacher') navOverview.classList.add('active');
      if (state.view === 'teacher.bank') navBank.classList.add('active');
      if (state.view === 'teacher.students') navStudents.classList.add('active');
      if (state.view === 'teacher.settings') navSettings.classList.add('active');
      if (state.view === 'teacher.guide') navGuide.classList.add('active');
      if (state.view === 'teacher.support') navSupport.classList.add('active');
    }

    // header active style
    document.querySelectorAll('.header-nav .nav-btn').forEach(b => b.classList.remove('active'));
    if (state.view === 'home') document.getElementById('topHome')?.classList.add('active');
    if (state.view === 'teacher' || state.view.startsWith('teacher')) document.getElementById('topTeacher')?.classList.add('active');
    if (state.view === 'student' || state.view === 'student.result') document.getElementById('topStudent')?.classList.add('active');
    enhancePasswordFields(app);
    if (state.pendingResultLookup && state.view !== 'take') {
      const pending = { ...state.pendingResultLookup };
      setResultLinkUiState(pending);
      state.pendingResultLookup = null;
      setTimeout(async () => {
        await processPendingResultLinkRequest(pending);
      }, 50);
    }
    const sameViewRerender = previousRenderedView && previousRenderedView === state.view;
    if (_pendingScrollRestore) {
      restoreViewScrollState(_pendingScrollRestore);
      _pendingScrollRestore = null;
    } else if (sameViewRerender) {
      restoreViewScrollState(_viewScrollState[state.view] || null);
    } else if (_historyApplying && _viewScrollState[state.view]) {
      restoreViewScrollState(_viewScrollState[state.view]);
    } else {
      restoreViewScrollState(null, { forceTop: true });
    }
    _lastRenderedView = state.view;
    updateInstallAppButtons();
    refreshAlertsButton(headerAlerts);
    persistAppUiState();
    syncOverlayBodyLock();
    hideStartupSplash();
  }, 0);
}

window.addEventListener('popstate', (event) => {
  if (state.view === 'take') {
    window.history.pushState({ view: 'take', quizId: state.currentQuiz && state.currentQuiz.id ? state.currentQuiz.id : '' }, '', buildHistoryUrlForState());
    showNotification('Use the exam buttons to move during the quiz.', 'warning');
    return;
  }
  const view = event.state && event.state.view ? event.state.view : 'home';
  _historyApplying = true;
  state.view = view;
  if (event.state && event.state.quizId) state.currentQuiz = getAllQuizzes()[event.state.quizId] || state.currentQuiz;
  _pendingScrollRestore = _viewScrollState[view] || _pendingScrollRestore;
  render();
  _lastHistoryView = state.view;
  _historyApplying = false;
});

window.addEventListener('pagehide', () => {
  captureViewScrollState(_lastRenderedView || state.view);
  persistAppUiState();
});

// ============================================================================
// TEACHER OVERVIEW - clean, card-based (replaces old renderTeacher top portion)
// ============================================================================

function renderHomePage() {
  const wrapper = document.createElement('div');
  wrapper.className = 'home-page';
  wrapper.innerHTML = `
    <section class="hero">
      <div class="hero-copy">
        <div class="hero-eyebrow">Assessment Platform</div>
        <h1 class="hero-title">Create polished computer-based assessments with speed and clarity.</h1>
        <p class="hero-subtitle">Build quizzes, organize question banks, monitor performance, and deliver private browser-based testing in one clean workflow.</p>
        <div class="hero-actions">
          <button id="homeGetStarted" class="btn-main hero-cta">Get Started</button>
          <button id="homeInstallApp" class="btn btn-ghost" data-install-app-button type="button">Install App</button>
        </div>
        <div class="hero-metrics" aria-label="Platform highlights">
          <div class="hero-metric">
            <strong>Quiz-ready</strong>
            <span>Structured setup for teachers</span>
          </div>
          <div class="hero-metric">
            <strong>Insightful</strong>
            <span>Results and progress at a glance</span>
          </div>
        </div>
      </div>
      <div class="hero-illustration" aria-hidden="true">
        <div class="hero-orb hero-orb-one"></div>
        <div class="hero-orb hero-orb-two"></div>
        <div class="hero-dashboard-frame">
          <div class="hero-window-bar">
            <span></span><span></span><span></span>
          </div>
          <div class="hero-dashboard-body">
            <div class="hero-dashboard-sidebar">
              <div class="hero-nav-pill active"></div>
              <div class="hero-nav-pill"></div>
              <div class="hero-nav-pill"></div>
              <div class="hero-nav-pill short"></div>
            </div>
            <div class="hero-dashboard-main">
              <div class="hero-panel hero-panel-assessment">
                <div class="hero-panel-heading">
                  <div>
                    <strong>Physics Midterm</strong>
                    <span>Draft assessment setup</span>
                  </div>
                  <i class="hero-status-chip">Ready</i>
                </div>
                <div class="hero-score-bars">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
                <div class="hero-progress-row">
                  <div class="hero-mini-stat">
                    <strong>48</strong>
                    <span>Questions</span>
                  </div>
                  <div class="hero-mini-stat">
                    <strong>92%</strong>
                    <span>Completion</span>
                  </div>
                </div>
              </div>
              <div class="hero-lower-grid">
                <div class="hero-panel hero-chart-card">
                  <div class="hero-chart-header">
                    <strong>Results</strong>
                    <span>This week</span>
                  </div>
                  <div class="hero-chart-bars">
                    <i></i><i></i><i></i><i></i><i></i>
                  </div>
                </div>
                <div class="hero-panel hero-student-card">
                  <div class="hero-chart-header">
                    <strong>Progress</strong>
                    <span>Live class</span>
                  </div>
                  <div class="hero-student-list">
                    <div><b></b><span></span></div>
                    <div><b></b><span></span></div>
                    <div><b></b><span></span></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="feature-grid">
      <div class="feature-card">
        <div class="feature-icon shield">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l7 3v6c0 5-3.5 9.5-7 11-3.5-1.5-7-6-7-11V5l7-3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
        </div>
        <h3>Efficient & Secure</h3>
        <p>Zero-friction assessments with privacy first security.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon lightning">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2L5 14h5l-1 8 8-12h-5l1-8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
        </div>
        <h3>Create Quizzes Quickly</h3>
        <p>Easily create and share quizzes with your students.</p>
      </div>
      <div class="feature-card">
        <div class="feature-icon chart">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19h16M7 16V9m5 7V5m5 11v-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </div>
        <h3>Track Student Progress</h3>
        <p>View detailed results and insights at a glance.</p>
      </div>
    </section>
  `;
  setTimeout(() => {
    document.getElementById('homeGetStarted').onclick = () => { openTeacherWorkspace('teacher'); };
    updateInstallAppButtons();
  }, 0);
  return wrapper;
}

function getAlertOwnerKey() {
  return normalizeEmail(state.teacherId || getTeacherId() || 'guest');
}

function readAlertStateMap() {
  const stored = readLocalStorageValue(STORAGE_KEYS.alertState);
  return stored && typeof stored === 'object' ? stored : {};
}

function saveAlertStateMap(map = {}) {
  writeLocalStorageValue(STORAGE_KEYS.alertState, map);
}

function getLastSeenAlertStamp() {
  const ownerKey = getAlertOwnerKey();
  if (!ownerKey) return 0;
  const map = readAlertStateMap();
  return Number(map[ownerKey] || 0);
}

function markAlertsSeen(alerts = []) {
  const ownerKey = getAlertOwnerKey();
  if (!ownerKey) return 0;
  const latestStamp = (Array.isArray(alerts) ? alerts : []).reduce((maxStamp, alert) => {
    if (!alert || !alert.notifyOnNew) return maxStamp;
    return Math.max(maxStamp, Number(alert.stamp) || 0);
  }, 0);
  if (!latestStamp) return 0;
  const map = readAlertStateMap();
  if (latestStamp > Number(map[ownerKey] || 0)) {
    map[ownerKey] = latestStamp;
    saveAlertStateMap(map);
  }
  return latestStamp;
}

function getUnreadAlertCount(alerts = []) {
  const lastSeen = getLastSeenAlertStamp();
  return (Array.isArray(alerts) ? alerts : []).filter((alert) =>
    alert && alert.notifyOnNew && (Number(alert.stamp) || 0) > lastSeen
  ).length;
}

function buildSubmissionAlertAction(submission = {}, options = {}) {
  return {
    type: 'open-results',
    quizId: submission.quizId || '',
    submissionKey: submission.submissionId || buildSubmissionIdentity(submission),
    openModal: !!options.openModal
  };
}

function buildTeacherAlerts() {
  const quizzes = getAllQuizzes();
  const quizKeys = Object.keys(quizzes).filter((key) => {
    const quiz = quizzes[key];
    if (!quiz || isDeletedQuiz(quiz)) return false;
    if (isSuperAdmin()) return true;
    return state.teacherId && normalizeEmail(quiz.teacherId) === normalizeEmail(state.teacherId);
  });
  const submissions = getAllSubmissions().filter((submission) => quizKeys.includes(submission.quizId));
  const now = Date.now();
  const recentSubmissionWindowMs = 24 * 60 * 60 * 1000;
  const teacher = getCurrentTeacher() || {};
  const licence = getTeacherLicenseStatus(teacher);
  const licenceStamp = getTeacherAccessStamp(teacher);
  const alerts = [];

  if (isTeacherLoggedIn()) {
    if (!licence.active) {
      alerts.push({
        id: `license:${getAlertOwnerKey()}:${licenceStamp || 'pending'}`,
        type: 'warning',
        title: licence.label,
        detail: licence.detail,
        stamp: licenceStamp,
        notifyOnNew: !!licenceStamp,
        action: { type: 'license' }
      });
    }
    const activeCount = quizKeys.filter((key) => {
      const quiz = quizzes[key];
      return (!quiz.scheduleStart || new Date(quiz.scheduleStart).getTime() <= now) && (!quiz.scheduleEnd || new Date(quiz.scheduleEnd).getTime() >= now);
    }).length;
    if (activeCount) {
      alerts.push({
        id: `active-exams:${activeCount}`,
        type: 'info',
        title: `${activeCount} active exam(s)`,
        detail: 'These quizzes are currently available to students.',
        stamp: 0,
        notifyOnNew: false,
        action: { type: 'teacher-quizzes' }
      });
    }
  } else {
    alerts.push({
      id: 'guest-mode',
      type: 'info',
      title: 'Guest mode',
      detail: 'Log in as a teacher to see exam and monitoring alerts.',
      stamp: 0,
      notifyOnNew: false,
      action: null
    });
  }

  submissions
    .filter((submission) => {
      const submittedAt = new Date(submission?.submittedAt || submission?.updatedAt || 0).getTime();
      return submittedAt && submittedAt <= now && (now - submittedAt) <= recentSubmissionWindowMs;
    })
    .sort((left, right) => new Date(right?.submittedAt || right?.updatedAt || 0).getTime() - new Date(left?.submittedAt || left?.updatedAt || 0).getTime())
    .slice(0, 10)
    .forEach((submission) => {
      const studentLabel = submission.name || submission.email || 'Student';
      const quizLabel = quizzes[submission.quizId]?.title || submission.quizId || 'Quiz';
      const submittedAtStamp = new Date(submission?.submittedAt || submission?.updatedAt || 0).getTime();
      const submittedAtText = submission.submittedAt ? new Date(submission.submittedAt).toLocaleString() : 'Recently';
      alerts.push({
        id: `recent-submission:${submission.submissionId || buildSubmissionIdentity(submission)}`,
        type: 'info',
        title: 'Recent submission',
        detail: `${studentLabel} submitted ${quizLabel} on ${submittedAtText}.`,
        stamp: submittedAtStamp,
        notifyOnNew: true,
        action: buildSubmissionAlertAction(submission)
      });
    });

  submissions.slice(-10).reverse().forEach((submission) => {
    const monitoring = submission.monitoring || {};
    const flags = [];
    if (monitoring.tabSwitches) flags.push(`${monitoring.tabSwitches} tab switch(es)`);
    if (monitoring.fullscreenExits) flags.push(`${monitoring.fullscreenExits} fullscreen exit(s)`);
    if (monitoring.copyAttempts) flags.push(`${monitoring.copyAttempts} copy attempt(s)`);
    if (monitoring.screenshotAttempts) flags.push(`${monitoring.screenshotAttempts} screenshot attempt(s)`);
    if (!flags.length) return;
    alerts.push({
      id: `monitoring:${submission.submissionId || buildSubmissionIdentity(submission)}:${flags.join('|')}`,
      type: 'warning',
      title: submission.name || submission.email || 'Student alert',
      detail: `${quizzes[submission.quizId]?.title || submission.quizId}: ${flags.join(', ')}`,
      stamp: new Date(submission.updatedAt || submission.submittedAt || 0).getTime(),
      notifyOnNew: true,
      action: buildSubmissionAlertAction(submission)
    });
  });

  const lastSeen = getLastSeenAlertStamp();
  return alerts.map((alert) => ({
    ...alert,
    stamp: Number(alert.stamp) || 0,
    isUnread: !!alert.notifyOnNew && (Number(alert.stamp) || 0) > lastSeen
  }));
}

function refreshAlertsButton(alerts = null) {
  const button = document.getElementById('topAlerts');
  if (!button) return;
  const currentAlerts = Array.isArray(alerts) ? alerts : buildTeacherAlerts();
  const unreadCount = getUnreadAlertCount(currentAlerts);
  button.classList.toggle('has-unread', unreadCount > 0);
  button.innerHTML = unreadCount > 0 ? `Alerts <span class="alerts-pill">${unreadCount}</span>` : 'Alerts';
  button.setAttribute('aria-label', unreadCount > 0 ? `${unreadCount} new alert${unreadCount === 1 ? '' : 's'}` : 'Notifications');
}

function openAlertDestination(alert = null) {
  if (!alert || !alert.action) return;
  const modal = document.getElementById('alertsPanel');
  if (modal) modal.remove();
  const action = alert.action;
  if (action.type === 'license') {
    showLicenseRequired();
    return;
  }
  if (action.type === 'teacher-quizzes') {
    state.view = 'teacher.quizzes';
    render();
    return;
  }
  if (action.type === 'open-results') {
    const quiz = getAllQuizzes()[action.quizId];
    if (!quiz) {
      showNotification('That alert item is no longer available.', 'warning', 6000);
      return;
    }
    state.currentQuiz = quiz;
    state.pendingResultsFocus = {
      quizId: quiz.id,
      submissionKey: action.submissionKey || '',
      openModal: !!action.openModal
    };
    state.view = 'teacher.results';
    render();
  }
}

function renderAdminAuth() {
  const wrapper = document.createElement('div');
  wrapper.className = 'auth-shell';
  wrapper.innerHTML = `
    <div class="card auth-card">
      <div class="h1">Admin Login</div>
      <div class="small">Super admin access only.</div>
      <div style="height:18px"></div>
      <label class="small">Admin email</label>
      <input id="adminLoginId" class="input-beautiful" placeholder="Admin email" />
      <div style="height:10px"></div>
      <label class="small">Password</label>
      <input id="adminLoginPassword" class="input-beautiful" type="password" placeholder="Admin password" />
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:16px">
        <button id="btnAdminLogin" class="btn btn-primary">Login</button>
      </div>
    </div>
  `;
  setTimeout(() => {
    document.getElementById('btnAdminLogin').onclick = async () => {
      const id = normalizeEmail(document.getElementById('adminLoginId').value);
      const password = document.getElementById('adminLoginPassword').value || '';
      if (!id || !password) return showNotification('Enter the admin email and password', 'error');
      if (!canUseNetworkSync()) return showNotification('Admin login requires the OPE server. Connect to a network or set the sync server URL in Settings.', 'error', 8000);
      try {
        const result = await postAuthJson('/api/auth/super-admin/login', { email: id, password });
        if (!result.ok) {
          const message = (result.data && result.data.error) || 'Invalid admin email or password';
          return showNotification(message, 'error');
        }
        setStoredAuthSession({
          token: result.data.sessionToken,
          role: result.data.role,
          email: result.data.email,
          expiresInMs: result.data.expiresInMs
        });
        ensureSuperAdminAccount();
        save(STORAGE_KEYS.teacherSession, { teacherId: id, loggedInAt: new Date().toISOString() });
        localStorage.setItem(STORAGE_KEYS.teacherId, id);
        state.teacherId = id;
        await openTeacherWorkspace('teacher.settings');
      } catch (error) {
        showNotification('Could not reach the OPE server to verify the admin login. Try again.', 'error', 8000);
      }
    };
  }, 0);
  return wrapper;
}

function showAlertsPanel() {
  let modal = document.getElementById('alertsPanel');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'alertsPanel';
  modal.style.position = 'fixed';
  modal.style.inset = '0';
  modal.style.background = 'rgba(15,23,42,.45)';
  modal.style.zIndex = 30000;
  modal.style.display = 'flex';
  modal.style.alignItems = 'flex-start';
  modal.style.justifyContent = 'flex-end';
  modal.style.padding = '72px 24px 24px';
  const alerts = buildTeacherAlerts();

  const inner = document.createElement('div');
  inner.className = 'card-beautiful';
  inner.style.width = 'min(420px, 94vw)';
  inner.style.maxHeight = 'calc(100vh - 110px)';
  inner.style.overflow = 'auto';
  inner.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px">
      <h3 style="margin:0">Alerts</h3>
      <button id="closeAlertsPanel" class="btn btn-ghost btn-sm">Close</button>
    </div>
    <div class="small" style="margin-bottom:12px">Exam notices, token status, recent quiz submissions from the last 24 hours, and recent monitoring warnings.</div>
    ${alerts.map(a => `
      <div class="alert-item alert-${escapeHtml(a.type)}${a.action ? ' alert-clickable' : ''}"${a.action ? ` data-alert-id="${escapeHtml(a.id)}"` : ''}>
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
          <strong>${escapeHtml(a.title)}</strong>
          ${a.isUnread ? '<span class="alert-new-badge">New</span>' : ''}
        </div>
        <div class="small">${escapeHtml(a.detail)}</div>
      </div>
    `).join('') || '<div class="small">No alerts right now.</div>'}
  `;
  modal.appendChild(inner);
  document.body.appendChild(modal);
  markAlertsSeen(alerts);
  refreshAlertsButton(alerts);
  document.getElementById('closeAlertsPanel').onclick = () => modal.remove();
  inner.querySelectorAll('[data-alert-id]').forEach((node) => {
    node.onclick = () => {
      const alert = alerts.find((item) => item.id === node.dataset.alertId);
      openAlertDestination(alert);
    };
  });
  modal.onclick = (ev) => { if (ev.target === modal) modal.remove(); };
}

function renderTeacherAuth() {
  const wrapper = document.createElement('div');
  wrapper.className = 'auth-shell';
  wrapper.innerHTML = `
    <div class="card auth-card">
      <div class="h1">Teacher Login</div>
      <div class="small">Use your teacher email ID and password. Registered admin emails open the admin tools from this same box.</div>
      <div style="height:18px"></div>
      <label class="small">Teacher email ID</label>
      <input id="teacherLoginId" class="input-beautiful" placeholder="teacher@example.com" />
      <div style="height:10px"></div>
      <label class="small">Password</label>
      <input id="teacherLoginPassword" class="input-beautiful" type="password" placeholder="Your password" />
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:16px">
        <button id="btnTeacherLogin" class="btn btn-primary">Login</button>
        <button id="btnTeacherCreate" class="btn btn-ghost">Create Teacher ID</button>
      </div>
    </div>
  `;

  setTimeout(() => {
    const idInput = document.getElementById('teacherLoginId');
    const passwordInput = document.getElementById('teacherLoginPassword');
    const loginBtn = document.getElementById('btnTeacherLogin');
    const createBtn = document.getElementById('btnTeacherCreate');
    const setBusy = (busy, mode = 'login') => {
      [idInput, passwordInput, loginBtn, createBtn].forEach((node) => {
        if (!node) return;
        node.disabled = !!busy;
      });
      if (loginBtn) loginBtn.textContent = busy && mode === 'login' ? 'Syncing...' : 'Login';
      if (createBtn) createBtn.textContent = busy && mode === 'create' ? 'Creating...' : 'Create Teacher ID';
    };

    const login = async (createMode = false) => {
      const id = normalizeEmail(idInput?.value);
      const password = passwordInput?.value || '';
      if (!id || !password) return showNotification('Enter teacher email ID and password', 'error');
      if (id === SUPER_ADMIN_EMAIL) ensureSuperAdminAccount();
      setBusy(true, createMode ? 'create' : 'login');
      try {
        // Path A: server is reachable → authenticate against /api/auth/teacher/*
        if (canUseNetworkSync()) {
          if (createMode) {
            if (id === SUPER_ADMIN_EMAIL) return showNotification('Admin account already exists. Login instead.', 'error');
            const result = await postAuthJson('/api/auth/teacher/register', { email: id, password });
            if (!result.ok) {
              const message = (result.data && result.data.error) || 'Could not create teacher ID';
              return showNotification(message, 'error', 8000);
            }
            setStoredAuthSession({
              token: result.data.sessionToken,
              role: result.data.role,
              email: result.data.email,
              expiresInMs: result.data.expiresInMs
            });
            await recordLocalAuthForPassword(id, password);
            await pullSharedStateSilently({
              forcePull: true,
              timeoutMs: DEFAULT_WORKSPACE_SYNC_TIMEOUT_MS,
              forceRenderOnLate: true
            }).catch(() => {});
            showNotification('Teacher ID created', 'success', 6000);
          } else {
            const isAdminLogin = id === SUPER_ADMIN_EMAIL;
            const endpoint = isAdminLogin ? '/api/auth/super-admin/login' : '/api/auth/teacher/login';
            const result = await postAuthJson(endpoint, { email: id, password });
            if (!result.ok) {
              const fallback = isAdminLogin ? 'Invalid admin email or password' : 'Invalid teacher ID or password';
              const message = (result.data && result.data.error) || fallback;
              return showNotification(message, 'error', 6000);
            }
            setStoredAuthSession({
              token: result.data.sessionToken,
              role: result.data.role,
              email: result.data.email,
              expiresInMs: result.data.expiresInMs
            });
            // The super-admin password is server-only and never cached locally.
            if (!isAdminLogin) await recordLocalAuthForPassword(id, password);
            // Pull the shared state now so this device actually has a teacher
            // record (and quizzes/submissions) before the workspace renders —
            // otherwise a wiped device authenticates fine but getCurrentTeacher()
            // is empty and openTeacherWorkspace bounces straight back to login.
            await pullSharedStateSilently({
              forcePull: true,
              timeoutMs: DEFAULT_WORKSPACE_SYNC_TIMEOUT_MS,
              forceRenderOnLate: true
            }).catch(() => {});
          }
        } else {
          // Path B: offline. Allow login only — never registration — and only
          // when we have a previously cached PBKDF2 hash from a prior online login.
          if (createMode) {
            return showNotification('Creating a teacher account requires the OPE server. Connect to a network and try again.', 'error', 8000);
          }
          if (id === SUPER_ADMIN_EMAIL) {
            return showNotification('Admin login requires the OPE server. Connect to a network and try again.', 'error', 8000);
          }
          const localAuth = getLocalAuthMap()[id];
          if (!localAuth || !localAuth.passwordHash) {
            return showNotification('Cannot verify this account offline. Connect to the OPE server and log in once before going offline.', 'error', 8000);
          }
          const ok = await verifyLocalAuthHash(password, localAuth.passwordHash).catch(() => false);
          if (!ok) return showNotification('Invalid teacher ID or password', 'error');
        }
        save(STORAGE_KEYS.teacherSession, { teacherId: id, loggedInAt: new Date().toISOString() });
        localStorage.setItem(STORAGE_KEYS.teacherId, id);
        state.teacherId = id;
        _pendingNewTeacherProfilePrompt = !!(createMode && id !== SUPER_ADMIN_EMAIL);
        await openTeacherWorkspace(createMode || id === SUPER_ADMIN_EMAIL ? 'teacher.settings' : 'teacher', {
          pullSharedState: false
        });
      } catch (error) {
        console.error(error);
        showNotification('Unable to verify this teacher account right now. Please try again.', 'error', 8000);
      } finally {
        setBusy(false);
      }
    };
    if (loginBtn) loginBtn.onclick = () => login(false);
    if (createBtn) createBtn.onclick = () => login(true);
  }, 0);
  return wrapper;
}

function openTeacherProfileEditor() {
  const teacher = getCurrentTeacher();
  if (!teacher) return showNotification('Teacher account not found', 'error');
  let modal = document.getElementById('teacherProfileEditorModal');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'teacherProfileEditorModal';
  modal.className = 'student-result-modal';
  const lockEmail = isSuperAdmin();
  const inner = document.createElement('div');
  inner.className = 'card-beautiful admin-modal-card';
  inner.style.width = 'min(560px, 94vw)';
  inner.innerHTML = `
    <div class="page-heading">
      <div>
        <div class="h2">Teacher Profile</div>
        <div class="small">Update the identity that appears on your dashboard and correction messages.</div>
      </div>
      <button id="closeTeacherProfileEditor" class="btn btn-ghost">Close</button>
    </div>
    <label class="small">Full name</label>
    <input id="teacherProfileName" class="input-beautiful" value="${escapeHtml(teacher.name || '')}" placeholder="e.g. Chinedu Okafor" />
    <div style="height:10px"></div>
    <label class="small">Phone number</label>
    <input id="teacherProfilePhone" class="input-beautiful" value="${escapeHtml(teacher.phone || teacher.phoneNumber || '')}" placeholder="e.g. 08012345678" />
    <div style="height:10px"></div>
    <label class="small">Teacher email ID</label>
    <input id="teacherProfileEmail" class="input-beautiful" value="${escapeHtml(teacher.email || teacher.teacherId || state.teacherId || '')}" ${lockEmail ? 'readonly' : ''} />
    <div class="small" style="margin-top:8px;line-height:1.7">${lockEmail ? 'The super admin email ID stays fixed on this installation.' : 'Changing your teacher email ID will move your quizzes and uploaded students to the new ID automatically.'}</div>
    <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px;flex-wrap:wrap">
      <button id="cancelTeacherProfileEditor" class="btn btn-ghost">Cancel</button>
      <button id="saveTeacherProfileEditor" class="btn btn-primary">Save Profile</button>
    </div>
  `;
  modal.appendChild(inner);
  document.body.appendChild(modal);
  modal.onclick = (event) => { if (event.target === modal) modal.remove(); };
  document.getElementById('closeTeacherProfileEditor').onclick = () => modal.remove();
  document.getElementById('cancelTeacherProfileEditor').onclick = () => modal.remove();
  document.getElementById('saveTeacherProfileEditor').onclick = () => {
    const payload = {
      name: (document.getElementById('teacherProfileName').value || '').trim(),
      phone: (document.getElementById('teacherProfilePhone').value || '').trim(),
      email: (document.getElementById('teacherProfileEmail').value || '').trim()
    };
    if (!payload.email) return showNotification('Enter a teacher email ID', 'error');
    const currentId = normalizeEmail(teacher.teacherId || teacher.email || state.teacherId);
    const nextId = lockEmail ? currentId : normalizeEmail(payload.email);
    const message = !lockEmail && nextId !== currentId
      ? `Save this profile and change your teacher email ID from ${currentId} to ${nextId}? Your quizzes and uploaded students will move to the new ID.`
      : 'Save your teacher profile now?';
    if (!confirmTeacherAction(message)) return;
    const result = updateTeacherProfileRecord(currentId, payload, { lockEmail });
    if (!result.ok) return showNotification(result.message || 'Could not save teacher profile', 'error');
    modal.remove();
    showNotification(result.changedId ? `Profile updated. Your teacher ID is now ${result.teacherId}` : 'Teacher profile updated', 'success', 7000);
    render();
  };
}

function renderTeacherOverview() {
  const teacher = getCurrentTeacher() || {};
  const profileName = (teacher.name || '').toString().trim() || 'Not set yet';
  const profilePhone = getTeacherPhoneLabel(teacher);
  const profileEmail = (teacher.email || teacher.teacherId || state.teacherId || '').toString().trim();
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <div class="dashboard-heading">
      <div class="h1">Teacher Dashboard</div>
      <div class="small">Overview & quick actions</div>
    </div>
    <div id="licenseBanner" class="license-banner"></div>

    <div class="grid-cards stats-grid" style="margin-bottom:var(--space-3)">
      <div class="card stat stat-blue">
        <div class="stat-icon">Quiz</div>
        <div class="value" id="ovTotalQuizzes">0</div>
        <div class="label">Total quizzes</div>
        <span>Manage your quizzes</span>
      </div>
      <div class="card stat stat-green">
        <div class="stat-icon">Live</div>
        <div class="value" id="ovActiveExams">0</div>
        <div class="label">Active exams</div>
        <span>Currently available</span>
      </div>
      <div class="card stat stat-purple">
        <div class="stat-icon">Subs</div>
        <div class="value" id="ovTotalSubmissions">0</div>
        <div class="label">Total submissions</div>
        <span>Across your quizzes</span>
      </div>
      <div class="card stat stat-orange">
        <div class="stat-icon">Avg</div>
        <div class="value" id="ovAvgScore">0%</div>
        <div class="label">Average score</div>
        <span>Submission average</span>
      </div>
    </div>

    <div class="action-grid">
      <button id="quickCreate" class="action-card">Create Quiz</button>
      <button id="quickUpload" class="action-card">Upload Questions</button>
      <button id="btnFindIP" class="action-card">Track IP</button>
      <button id="gotoQuizzes" class="action-card">Manage Quizzes</button>
    </div>

    <div class="card" style="margin-bottom:var(--space-3);margin-top:var(--space-3)">
      <div class="page-heading" style="margin-bottom:0">
        <div>
          <div class="h3">Teacher Profile</div>
          <div class="small">This identity appears on your dashboard and signs your correction messages.</div>
        </div>
        <button id="editTeacherProfileBtn" class="btn btn-ghost btn-sm">Edit Profile</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:14px">
        <div class="card" style="padding:14px;border:1px solid #DBEAFE;box-shadow:none">
          <div class="small">Name</div>
          <div style="font-weight:800;margin-top:6px">${escapeHtml(profileName)}</div>
        </div>
        <div class="card" style="padding:14px;border:1px solid #DBEAFE;box-shadow:none">
          <div class="small">Phone Number</div>
          <div style="font-weight:800;margin-top:6px">${escapeHtml(profilePhone)}</div>
        </div>
        <div class="card" style="padding:14px;border:1px solid #DBEAFE;box-shadow:none">
          <div class="small">Teacher Email ID</div>
          <div style="font-weight:800;margin-top:6px;word-break:break-word">${escapeHtml(profileEmail)}</div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:var(--space-3)">
      <div class="h3">Recent activity</div>
      <div class="small" style="margin-top:8px">Your recent quizzes and submissions</div>
      <div id="recentActivity" style="margin-top:12px"></div>
    </div>
  `;

  setTimeout(() => {
    document.getElementById('quickCreate').onclick = () => { showCreateQuizModal(); };
    document.getElementById('quickUpload').onclick = () => { showCreateQuizModal(); };
    document.getElementById('btnFindIP').onclick = () => { showLocalNetworkGuide(); };
    document.getElementById('gotoQuizzes').onclick = () => { state.view = 'teacher.quizzes'; render(); };
    document.getElementById('editTeacherProfileBtn').onclick = () => openTeacherProfileEditor();
    const licence = getTeacherLicenseStatus();
    const banner = document.getElementById('licenseBanner');
    banner.className = 'license-banner ' + (licence.active ? 'license-active' : 'license-inactive');
    banner.innerHTML = `
      <div>
        <strong>${escapeHtml(licence.label)}</strong>
        <div class="small">${escapeHtml(licence.detail)}</div>
        <div class="small" style="margin-top:6px">${escapeHtml(licence.summary || '')}</div>
      </div>
      ${licence.canSaveQuiz ? '<button id="requestLicenceInline" class="btn btn-ghost btn-sm">Top Up / Unlimited</button>' : '<button id="requestLicenceInline" class="btn btn-primary btn-sm">Buy Tokens</button>'}
    `;
    const req = document.getElementById('requestLicenceInline'); if (req) req.onclick = () => showLicenseRequired();

    // populate overview stats from storage
    const quizzes = getAllQuizzes();
    const quizKeys = Object.keys(quizzes).filter(k => isSuperAdmin() || normalizeEmail(quizzes[k].teacherId) === normalizeEmail(state.teacherId));
    document.getElementById('ovTotalQuizzes').textContent = quizKeys.length;
    const subs = getAllSubmissions().filter(s => quizKeys.includes(s.quizId));
    document.getElementById('ovTotalSubmissions').textContent = subs.length;
    const avg = subs.length ? Math.round(subs.reduce((a,b)=>a+b.percent,0)/subs.length) : 0;
    document.getElementById('ovAvgScore').textContent = avg + '%';
    const now = Date.now();
    const active = quizKeys.filter(k => {
      const q = quizzes[k];
      const startOk = !q.scheduleStart || new Date(q.scheduleStart).getTime() <= now;
      const effectiveEnd = getQuizEffectiveEndTime(q);
      const endOk = !effectiveEnd || effectiveEnd >= now;
      return startOk && endOk;
    }).length;
    document.getElementById('ovActiveExams').textContent = active;
    // quick recent activity (show last 5)
    const recent = quizKeys.slice(-5).reverse().map(k => `<div class="activity-item"><strong>  ${escapeHtml(quizzes[k].title)}</strong><div class="small">  ${new Date(quizzes[k].createdAt).toLocaleString()}</div></div>`).join('');
    document.getElementById('recentActivity').innerHTML = recent || '<div class="small">No recent activity</div>';
  }, 0);

  return wrapper;
}

// Teacher quick access by Quiz ID + Password (view summary)
function showTeacherAccessModal() {
  let m = document.getElementById('teacherAccess'); if (m) m.remove();
  m = document.createElement('div'); m.id='teacherAccess'; m.style.position='fixed'; m.style.inset='0'; m.style.zIndex=30000; m.style.background='rgba(0,0,0,0.4)';
  const inner = document.createElement('div'); inner.className='card-beautiful p-6'; inner.style.width='520px'; inner.style.margin='40px auto';
  inner.innerHTML = `
    <h3>Teacher   Open Quiz Summary</h3>
    <div class="small">You must be logged in as the owner teacher or super admin.</div>
    <div style="height:8px"></div>
    <input id="taQuizId" class="input-beautiful" placeholder="Quiz ID (6 digits)" />
    <div style="height:8px"></div>
      <input id="taPassword" class="input-beautiful" type="password" placeholder="Password (if set)" />
    <div style="height:12px"></div>
    <div style="display:flex;justify-content:flex-end;gap:8px"><button id="btnTeacherOpen" class="btn-pastel-primary">Open</button><button id="btnTeacherCancel" class="btn-pastel-secondary">Cancel</button></div>
  `;
  m.appendChild(inner); document.body.appendChild(m);
  document.getElementById('btnTeacherCancel').onclick = ()=>m.remove();
  document.getElementById('btnTeacherOpen').onclick = ()=>{
    const id = document.getElementById('taQuizId').value.trim(); const pw = document.getElementById('taPassword').value || '';
    if (!requireTeacher()) { m.remove(); return render(); }
    const quiz = getAllQuizzes()[id]; if (!quiz) return showNotification('Quiz not found','error');
    if (quiz.teacherId !== state.teacherId && !isSuperAdmin()) return showNotification('Access denied: this quiz belongs to another teacher', 'error');
    if (quiz.password && quiz.password !== pw && !isSuperAdmin()) return showNotification('Invalid quiz password','error');
    state.currentQuiz = quiz; state.view = 'teacher.results'; render(); m.remove();
  };
}

// ============================================================================
// TEACHER QUIZZES view - accessible via sidebar (removed from main teacher view)
// ============================================================================

function renderTeacherQuizzes() {
  const container = document.createElement('div');
  // The page-level "Sync To Cloud" button used to push every key for every
  // teacher in one shot. That triggered a full /api/state pull (huge egress)
  // and, on shared accounts, made it easy to thrash the backend. Per-quiz
  // sync now lives in the Test Manager dropdown next to each quiz; the bulk
  // option is moved to Settings → Force Sync Now.
  const syncHelp = canUseNetworkSync()
    ? `<div class="card small" style="margin:0 0 16px;padding:12px 14px;background:#F0F9FF;border-color:#BAE6FD;color:#075985;line-height:1.55">Sync one quiz at a time using <strong>Test Manager → Sync To Cloud</strong> on the row below. Need a full refresh? Open <button id="openSyncSettingsFromQuizzesInfo" class="btn btn-ghost btn-sm" style="padding:2px 8px;margin:0 2px">Settings → Cloud Sync</button> and use Force Sync Now.</div>`
    : '';
  // Only surface the "not active" card after a sync the teacher actually
  // triggered failed — a quiet background read should never plant this banner.
  const syncNotice = (networkSyncFailed && lastSyncFailedForUser)
    ? `<div class="card small" style="margin:0 0 16px;padding:14px 16px;border-color:#FDE68A;background:#FFFBEB;color:#92400E">Shared sync is not active right now.<div style="margin-top:8px;line-height:1.6">${escapeHtml(networkSyncFailureMessage || 'Fix the backend connection before sending quiz IDs or links to students.')}</div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button id="openSyncSettingsFromQuizzes" class="btn btn-ghost btn-sm">Cloud Sync Settings</button><button id="testSyncFromQuizzes" class="btn btn-primary btn-sm">Test Connection</button></div></div>`
    : '';
  container.innerHTML = `<div class="h1">Quizzes</div><div class="small" style="margin-bottom:var(--space-2)">Manage your quizzes (edit, copy link, view results)</div>${syncHelp}${syncNotice}<div id="teacherQuizzesList" style="margin-top:16px"></div>`;
  setTimeout(() => {
    const openSyncSettingsFromQuizzesInfo = document.getElementById('openSyncSettingsFromQuizzesInfo');
    if (openSyncSettingsFromQuizzesInfo) openSyncSettingsFromQuizzesInfo.onclick = () => { state.view = 'teacher.settings'; render(); };
    const openSyncSettingsFromQuizzes = document.getElementById('openSyncSettingsFromQuizzes');
    if (openSyncSettingsFromQuizzes) openSyncSettingsFromQuizzes.onclick = () => { state.view = 'teacher.settings'; render(); };
    const testSyncFromQuizzes = document.getElementById('testSyncFromQuizzes');
    if (testSyncFromQuizzes) testSyncFromQuizzes.onclick = async () => {
      userInitiatedSync = true;
      lastSyncFailedForUser = false;
      try {
        const health = await checkNetworkSyncHealth({ timeoutMs: 5000 });
        if (health.ok) {
          await runSharedSyncCycle({ forcePull: true, forceRender: true });
        } else {
          lastSyncFailedForUser = true;
        }
        showNotification(health.ok ? 'Cloud sync server is reachable' : health.message, health.ok ? 'success' : 'error', 9000);
      } finally {
        userInitiatedSync = false;
      }
      render();
    };
    const all = getAllQuizzes();
    const myEmail = normalizeEmail(state.teacherId);
    // Include unowned quizzes too — the reclaim pass will adopt them as the
    // current teacher's so they show up in the dashboard and can be re-synced.
    const keys = Object.keys(all).filter(k => {
      const qOwner = normalizeEmail(all[k].teacherId || '');
      return !qOwner || qOwner === myEmail;
    }).sort((a,b)=> new Date(all[b].createdAt)-new Date(all[a].createdAt));
    const listEl = document.getElementById('teacherQuizzesList');
    if (!keys.length) {
      listEl.innerHTML = '<div class="card small">No quizzes yet. Click Create Quiz to start.</div>';
      return;
    }
    listEl.innerHTML = keys.map(k => {
      const q = all[k];
      const syncStatus = getQuizSyncStatus(q);
      const effectiveEnd = getQuizEffectiveEndTime(q);
      const ended = effectiveEnd && effectiveEnd <= Date.now();
      return `<div class="card quiz-list-card" style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:12px">
        <div style="min-width:240px;flex:1">
          <div style="font-weight:700">${escapeHtml(q.title)} <span class="small" style="color:var(--muted);font-weight:500">(${q.id})</span></div>
          <div class="small">${(q.subjects || []).length} subject(s)   ${q.timeLimit}m   ${q.maxGrade} points</div>
          <div class="small" style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap">
            <span class="status-chip ${syncStatus.tone === 'success' ? 'status-success' : syncStatus.tone === 'warning' ? 'status-pending' : ''}">${escapeHtml(syncStatus.label)}</span>
            ${ended ? '<span class="status-chip">Ended</span>' : '<span class="status-chip status-success">Open</span>'}
          </div>
        </div>
        <div class="quiz-list-actions" style="min-width:min(320px,100%);display:flex;justify-content:flex-end">
          <div class="row-action-shell" style="width:min(320px,100%)">
            <select class="input-beautiful row-action-select teacherQuizActionSelect" data-id="${q.id}">
              <option value="">Test Manager</option>
              <option value="sync-cloud">${syncStatus.tone === 'success' ? 'Re-sync To Cloud (already synced)' : 'Sync To Cloud'}</option>
              <option value="copy-code">Copy Student Code</option>
              <option value="copy-link">Copy Link</option>
              <option value="share-whatsapp">Share on WhatsApp</option>
              <option value="edit">Edit</option>
              <option value="end"${ended ? ' disabled' : ''}>End Test</option>
              <option value="delete">Delete</option>
              <option value="results">View Results</option>
            </select>
            <button class="btn btn-ghost btn-sm btnApplyTeacherQuizAction" data-id="${q.id}">Apply</button>
          </div>
        </div>
      </div>`;
    }).join('');
    // wire actions
    setTimeout(()=> {
      document.querySelectorAll('.btnApplyTeacherQuizAction').forEach((button) => button.onclick = async (event) => {
        const selector = event.currentTarget.parentElement.querySelector('.teacherQuizActionSelect');
        const action = selector ? selector.value : '';
        const quiz = getAllQuizzes()[event.currentTarget.dataset.id];
        if (!quiz) return showNotification('Quiz not found', 'error');
        if (!action) return showNotification('Choose a quiz action first', 'error');
        if (action === 'sync-cloud') {
          const triggerBtn = event.currentTarget;
          const originalLabel = triggerBtn.textContent;
          triggerBtn.disabled = true;
          triggerBtn.textContent = 'Syncing…';
          userInitiatedSync = true;
          lastSyncFailedForUser = false;
          try {
            const result = await syncSingleQuizWithCloud(quiz);
            const tone = result.ok ? (result.pulled === false ? 'warning' : 'success') : 'error';
            if (!result.ok) lastSyncFailedForUser = true;
            showNotification(result.message, tone, result.ok ? 6000 : 9000);
            if (result.ok) render();
          } finally {
            userInitiatedSync = false;
            triggerBtn.disabled = false;
            triggerBtn.textContent = originalLabel;
          }
        }
        if (action === 'copy-code') await copyQuizAccessCode(quiz);
        if (action === 'copy-link') await copyQuizAccessLink(quiz);
        if (action === 'share-whatsapp') await shareQuizAccessLink(quiz);
        if (action === 'edit') {
          canSetQuestions() ? showCreateQuizModal(quiz.id) : showLicenseRequired();
        }
        if (action === 'end') await endQuizNow(quiz.id);
        if (action === 'delete') await deleteQuizById(quiz.id);
        if (action === 'results') {
          state.currentQuiz = quiz;
          state.view = 'teacher.results';
          render();
        }
        if (selector) selector.value = '';
      });
    },0);
  },0);
  return container;
}

function buildTeacherSupportRequestMessage() {
  const teacher = getCurrentTeacher() || {};
  const name = getTeacherDisplayName(teacher, { fallback: 'Teacher' });
  const phone = getTeacherPhoneLabel(teacher, { fallback: '' });
  const teacherId = (teacher.email || teacher.teacherId || state.teacherId || '').toString().trim();
  return [
    'Hello Admin,',
    '',
    `Teacher Name: ${name}`,
    `Teacher ID: ${teacherId}`,
    phone ? `Phone Number: ${phone}` : '',
    '',
    'Please help me with:',
    '',
    '',
    'Regards,',
    name
  ].filter(Boolean).join('\n');
}

function getTeacherQuizKeys() {
  const all = getAllQuizzes();
  const myEmail = normalizeEmail(state.teacherId);
  return Object.keys(all).filter(k => {
    const qOwner = normalizeEmail(all[k].teacherId || '');
    return !qOwner || qOwner === myEmail;
  });
}

function buildQuestionBankQuizSummary(quiz = {}) {
  const questionCount = (quiz.subjects || []).reduce((sum, subject) => {
    const source = Array.isArray(subject.bankQuestions) && subject.bankQuestions.length ? subject.bankQuestions : subject.questions;
    return sum + ((source || []).filter(isMeaningfulQuestion).length);
  }, 0);
  return { ...quiz, questionCount };
}

function getAdminTemplateQuizKeys() {
  const all = getAllQuizzes();
  const myEmail = normalizeEmail(state.teacherId);
  return Object.keys(all).filter((key) => {
    const owner = normalizeEmail(all[key].teacherId || '');
    return owner === SUPER_ADMIN_EMAIL && owner !== myEmail;
  });
}

function canViewQuestionBankQuiz(quiz = null) {
  if (!quiz) return false;
  if (isSuperAdmin()) return true;
  const owner = normalizeEmail(quiz.teacherId || '');
  const current = normalizeEmail(state.teacherId);
  return !!current && (!owner || owner === current || owner === SUPER_ADMIN_EMAIL);
}

function canSetQuizFromAdminTemplate(quiz = null) {
  if (!quiz || isSuperAdmin()) return false;
  return normalizeEmail(quiz.teacherId || '') === SUPER_ADMIN_EMAIL && !!normalizeEmail(state.teacherId);
}

function renderQuestionBankView() {
  const all = getAllQuizzes();
  const keys = getTeacherQuizKeys();
  const quizSets = keys.map((id) => buildQuestionBankQuizSummary(all[id])).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  const adminQuizSets = isSuperAdmin()
    ? []
    : getAdminTemplateQuizKeys().map((id) => buildQuestionBankQuizSummary(all[id])).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));

  const container = document.createElement('div');
  container.innerHTML = `
    <div class="page-heading">
      <div>
        <div class="h1">Question Bank</div>
        <div class="small">Your quiz sets. Questions and answers stay hidden until you open a quiz.</div>
      </div>
      <button id="bankCreateQuiz" class="btn btn-primary">Create Quiz</button>
    </div>
    <div class="card">
      <div class="card-header"><h3>Quiz Sets</h3></div>
      <div class="table-wrap">
        <table class="table-dense">
          <thead><tr><th>Quiz</th><th>Quiz ID</th><th>Subjects</th><th>Questions</th><th>Schedule</th><th>Actions</th></tr></thead>
          <tbody>
            ${quizSets.map(q => `
              <tr>
                <td>${escapeHtml(q.title)}</td>
                <td>${q.id}</td>
                <td>${(q.subjects || []).length}</td>
                <td>${q.questionCount}</td>
                <td>${q.scheduleStart ? new Date(q.scheduleStart).toLocaleString() : 'Any time'}${q.scheduleEnd ? ' - ' + new Date(q.scheduleEnd).toLocaleString() : ''}</td>
                <td><button class="btn btn-ghost btn-sm btnViewQuizSet" data-id="${q.id}">View Content</button></td>
              </tr>
            `).join('') || '<tr><td colspan="6">No quiz sets yet. Create a quiz and import questions to populate this bank.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
    ${isSuperAdmin() ? '' : `
      <div class="card" style="margin-top:16px">
        <div class="card-header"><h3>Admin Quizzes</h3></div>
        <div class="small" style="padding:0 16px 14px;line-height:1.7">Question content prepared by the admin appears here. View the content first if you want to inspect it, or choose Set Quiz to open the normal quiz-setting workspace with that content already loaded under your account.</div>
        <div class="table-wrap">
          <table class="table-dense">
            <thead><tr><th>Quiz</th><th>Quiz ID</th><th>Subjects</th><th>Questions</th><th>Updated</th><th>Actions</th></tr></thead>
            <tbody>
              ${adminQuizSets.map((q) => `
                <tr>
                  <td>${escapeHtml(q.title || 'Untitled Quiz')}</td>
                  <td>${escapeHtml(q.id || '')}</td>
                  <td>${(q.subjects || []).length}</td>
                  <td>${q.questionCount}</td>
                  <td>${q.updatedAt ? new Date(q.updatedAt).toLocaleString() : q.createdAt ? new Date(q.createdAt).toLocaleString() : 'Not recorded'}</td>
                  <td>
                    <div class="row-action-shell">
                      <select class="input-beautiful row-action-select adminQuizActionSelect" data-id="${escapeHtml(q.id || '')}">
                        <option value="">Choose action</option>
                        <option value="view-content">View Content</option>
                        <option value="set-quiz">Set Quiz</option>
                      </select>
                      <button class="btn btn-ghost btn-sm btnApplyAdminQuizAction" data-id="${escapeHtml(q.id || '')}">Apply</button>
                    </div>
                  </td>
                </tr>
              `).join('') || '<tr><td colspan="6">No admin quizzes are available yet. When the admin saves and syncs one, it will appear here.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    `}
  `;
  setTimeout(() => {
    document.getElementById('bankCreateQuiz').onclick = () => { canSetQuestions() ? showCreateQuizModal() : showLicenseRequired(); };
    document.querySelectorAll('.btnViewQuizSet').forEach(btn => btn.onclick = (ev) => showQuizSetDetails(ev.currentTarget.dataset.id));
    document.querySelectorAll('.btnApplyAdminQuizAction').forEach((button) => {
      button.onclick = (event) => {
        const quizId = event.currentTarget.dataset.id || '';
        const selector = event.currentTarget.parentElement.querySelector('.adminQuizActionSelect');
        const action = selector ? selector.value : '';
        if (!action) return showNotification('Choose an action first', 'error');
        if (action === 'view-content') {
          showQuizSetDetails(quizId);
        } else if (action === 'set-quiz') {
          if (!canSetQuestions()) return showLicenseRequired();
          showCreateQuizModal('', { templateQuizId: quizId });
        }
        if (selector) selector.value = '';
      };
    });
  }, 0);
  return container;
}

function showQuizSetDetails(quizId) {
  const quiz = getAllQuizzes()[quizId];
  if (!quiz || !canViewQuestionBankQuiz(quiz)) return showNotification('Quiz set not found', 'error');
  const canEditThisQuiz = normalizeEmail(quiz.teacherId) === normalizeEmail(state.teacherId) && canSetQuestions();
  const canSetFromTemplate = canSetQuizFromAdminTemplate(quiz);
  const contentInfoMessage = canEditThisQuiz
    ? 'Spacing, line breaks, bold text, lists, superscript, subscript, and special characters stay visible here while you edit. Save when you finish this subject so the updated content is used the next time students open this quiz.'
    : canSetFromTemplate
      ? 'This admin quiz is view-only here. Use Set Quiz to open the normal quiz-setting workspace with this content already loaded under your account.'
      : 'This content is view-only in your current role or current token access state.';
  let modal = document.getElementById('quizSetDetails'); if (modal) modal.remove();
  modal = document.createElement('div'); modal.id='quizSetDetails'; modal.style.position='fixed'; modal.style.inset='0'; modal.style.background='rgba(0,0,0,0.45)'; modal.style.zIndex=20000; modal.style.display='flex'; modal.style.alignItems='center'; modal.style.justifyContent='center';
  const inner = document.createElement('div'); inner.className='card-beautiful p-6'; inner.style.width='94%'; inner.style.maxWidth='1000px'; inner.style.maxHeight='86vh'; inner.style.overflow='auto';
  const draftQuiz = JSON.parse(JSON.stringify(quiz));
  let selectedSubjectIndex = 0;
  const ensureSubjectQuestions = (subject) => {
    const source = Array.isArray(subject?.bankQuestions) && subject.bankQuestions.length ? subject.bankQuestions : subject?.questions;
    return (source || []).map((question, index) => normalizeQuestionForStorage(question, index, subject?.name || 'General'));
  };
  const getSubjectLabel = (subject, index) => escapeHtml(subject?.name || `Subject ${index + 1}`);
  const renumberQuestionCards = () => {
    inner.querySelectorAll('.quiz-editor-question-card').forEach((card, index) => {
      const label = card.querySelector('.quiz-editor-question-title');
      if (label) label.textContent = `Question ${index + 1}`;
    });
    const count = inner.querySelector('#quizSubjectQuestionCount');
    if (count) count.textContent = `${inner.querySelectorAll('.quiz-editor-question-card').length} question(s) in this subject`;
  };
  const captureCurrentSubjectDraft = () => {
    const editor = inner.querySelector('[data-quiz-subject-index]');
    if (!editor) return;
    const subjectIndex = parseInt(editor.dataset.quizSubjectIndex || '0', 10) || 0;
    const subject = (draftQuiz.subjects || [])[subjectIndex];
    if (!subject) return;
    const questions = Array.from(inner.querySelectorAll('.quiz-editor-question-card')).map((card, questionIndex) => {
      const cardType = normalizeQuestionType(card.dataset.questionType || (card.querySelector('.quiz-editor-type') && card.querySelector('.quiz-editor-type').value) || 'mcq');
      const baseFields = {
        _sourceId: card.dataset.sourceId || '',
        type: cardType,
        question: getEditorFieldStorageValue(card.querySelector('.quiz-editor-question')),
        topic: normalizeRichText((card.querySelector('.quiz-editor-topic') || {}).value || ''),
        difficulty: (card.querySelector('.quiz-editor-difficulty') || {}).value || 'Medium',
        explanation: getEditorFieldStorageValue(card.querySelector('.quiz-editor-explanation')),
        learningPoint: getEditorFieldStorageValue(card.querySelector('.quiz-editor-learning-point')),
        keyConcept: getEditorFieldStorageValue(card.querySelector('.quiz-editor-key-concept'))
      };
      if (cardType === 'mcq') {
        const optionValues = Array.from(card.querySelectorAll('.quiz-editor-option'))
          .map((field) => getEditorFieldStorageValue(field))
          .filter((value) => getRichTextPlainText(value).trim());
        const rawAnswer = ((card.querySelector('.quiz-editor-answer') || {}).value || 'A').toUpperCase();
        const rawIndex = rawAnswer.charCodeAt(0) - 65;
        const answerIndex = optionValues.length ? Math.max(0, Math.min(optionValues.length - 1, rawIndex)) : 0;
        baseFields.options = optionValues;
        baseFields.answer = String.fromCharCode(65 + answerIndex);
      } else if (cardType === 'yesno') {
        baseFields.answer = ((card.querySelector('.quiz-editor-yesno-answer') || {}).value || 'Yes');
      } else if (cardType === 'short') {
        const raw = (card.querySelector('.quiz-editor-accepted') || {}).value || '';
        baseFields.acceptedAnswers = normalizeAcceptedAnswers(raw);
      }
      return normalizeQuestionForStorage(baseFields, questionIndex, subject.name || 'General');
    }).filter(isMeaningfulQuestion);
    subject.questions = questions.slice();
    subject.bankQuestions = questions.slice();
  };
  const renderEditor = () => {
    const subjects = Array.isArray(draftQuiz.subjects) ? draftQuiz.subjects : [];
    if (!subjects.length) {
      inner.querySelector('#quizSetDetailsBody').innerHTML = '<div class="card-beautiful"><div class="h3">No subjects found</div><div class="small" style="margin-top:8px">Ask the teacher to save questions into this quiz first.</div></div>';
      return;
    }
    selectedSubjectIndex = Math.max(0, Math.min(subjects.length - 1, selectedSubjectIndex));
    const subject = subjects[selectedSubjectIndex];
    const questions = ensureSubjectQuestions(subject);
    subject.questions = questions.slice();
    subject.bankQuestions = questions.slice();
    const questionCards = questions.map((question, questionIndex) => {
      const qType = normalizeQuestionType(question.type);
      const optionCount = Math.max(4, (question.options || []).length || 0);
      const optionFields = Array.from({ length: optionCount }, (_, optionIndex) => {
        const letter = String.fromCharCode(65 + optionIndex);
        return buildRichEditorFieldMarkup(`Option ${letter}`, 'quiz-editor-option', (question.options || [])[optionIndex] || '', { minHeight: '74px' });
      }).join('');
      // MCQ-only fields are rendered into one block we hide/show based on the
      // type dropdown. Yes/No, Short, Essay each have their own block. Initial
      // CSS hides the blocks that don't match the current type.
      const mcqHidden = qType !== 'mcq' ? ' style="display:none"' : '';
      const yesnoHidden = qType !== 'yesno' ? ' style="display:none"' : '';
      const shortHidden = qType !== 'short' ? ' style="display:none"' : '';
      // Essay needs no extra fields beyond the question text + topic etc.
      const acceptedAnswersText = Array.isArray(question.acceptedAnswers)
        ? question.acceptedAnswers.join('\n')
        : '';
      return `
        <div class="card quiz-editor-question-card" data-source-id="${escapeHtml(question._sourceId || '')}" data-question-type="${escapeHtml(qType)}">
          <div class="page-heading" style="margin-bottom:12px">
            <div class="h3 quiz-editor-question-title">Question ${questionIndex + 1}</div>
            ${canEditThisQuiz ? '<button type="button" class="btn btn-ghost btn-sm btnRemoveEditorQuestion">Remove</button>' : ''}
          </div>
          <div class="field-grid-2" style="margin-bottom:12px">
            <div class="subject-field">
              <label class="small">Question type</label>
              <select class="input-beautiful quiz-editor-type">
                <option value="mcq" ${qType === 'mcq' ? 'selected' : ''}>Multiple Choice (MCQ)</option>
                <option value="yesno" ${qType === 'yesno' ? 'selected' : ''}>Yes / No (True/False)</option>
                <option value="short" ${qType === 'short' ? 'selected' : ''}>Short Answer</option>
                <option value="essay" ${qType === 'essay' ? 'selected' : ''}>Long Answer (Essay)</option>
              </select>
            </div>
            <div class="subject-field">
              <label class="small">Difficulty</label>
              <select class="input-beautiful quiz-editor-difficulty">
                ${['Easy', 'Medium', 'Hard'].map((level) => `<option value="${level}" ${level === (question.difficulty || 'Medium') ? 'selected' : ''}>${level}</option>`).join('')}
              </select>
            </div>
          </div>
          ${buildRichEditorFieldMarkup('Question text', 'quiz-editor-question', question.question || '', { minHeight: '132px' })}
          <div class="quiz-editor-type-block quiz-editor-type-block-mcq"${mcqHidden}>
            <div class="quiz-editor-options-grid">${optionFields}</div>
            <div class="subject-field" style="margin-top:12px">
              <label class="small">Correct answer</label>
              <select class="input-beautiful quiz-editor-answer">
                ${Array.from({ length: optionCount }, (_, optionIndex) => {
                  const letter = String.fromCharCode(65 + optionIndex);
                  return `<option value="${letter}" ${letter === (question.answer || 'A') ? 'selected' : ''}>${letter}</option>`;
                }).join('')}
              </select>
            </div>
          </div>
          <div class="quiz-editor-type-block quiz-editor-type-block-yesno"${yesnoHidden}>
            <div class="subject-field" style="margin-top:12px">
              <label class="small">Correct answer</label>
              <select class="input-beautiful quiz-editor-yesno-answer">
                <option value="Yes" ${(question.answer || 'Yes') === 'Yes' ? 'selected' : ''}>Yes</option>
                <option value="No" ${question.answer === 'No' ? 'selected' : ''}>No</option>
              </select>
              <div class="small" style="margin-top:6px;line-height:1.55">Students will see two radio buttons (Yes / No). Auto-marked: full marks for an exact match, zero otherwise.</div>
            </div>
          </div>
          <div class="quiz-editor-type-block quiz-editor-type-block-short"${shortHidden}>
            <div class="subject-field" style="margin-top:12px">
              <label class="small">Accepted answers</label>
              <textarea class="input-beautiful quiz-editor-accepted" rows="3" placeholder="One accepted answer per line, or comma-separated. Example:&#10;Paris&#10;paris">${escapeHtml(acceptedAnswersText)}</textarea>
              <div class="small" style="margin-top:6px;line-height:1.55">List every spelling/variant you'll accept (one per line). Marking is case-insensitive and trims spaces. The student gets full marks if their answer matches any entry.</div>
            </div>
          </div>
          <div class="subject-field" style="margin-top:12px">
            <label class="small">Topic</label>
            <input class="input-beautiful quiz-editor-topic preserve-format" value="${escapeHtml(getRichTextPlainText(question.topic || ''))}" />
          </div>
          <div class="field-grid-2" style="margin-top:12px">
            ${buildRichEditorFieldMarkup('Explanation', 'quiz-editor-explanation', question.explanation || '', { minHeight: '120px' })}
            ${buildRichEditorFieldMarkup('Learning point', 'quiz-editor-learning-point', question.learningPoint || '', { minHeight: '120px' })}
          </div>
          <div style="margin-top:12px">
            ${buildRichEditorFieldMarkup('Key concept', 'quiz-editor-key-concept', question.keyConcept || '', { minHeight: '88px' })}
          </div>
        </div>
      `;
    }).join('');
    inner.querySelector('#quizSetDetailsBody').innerHTML = `
      <div class="quiz-content-toolbar">
        <div>
          <div class="small">Choose subject</div>
          <select id="quizContentSubjectSelect" class="input-beautiful" style="min-width:220px">
            ${subjects.map((item, index) => `<option value="${index}" ${index === selectedSubjectIndex ? 'selected' : ''}>${getSubjectLabel(item, index)} (${ensureSubjectQuestions(item).length})</option>`).join('')}
          </select>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" id="prevQuizContentSubject" class="btn btn-ghost btn-sm" ${selectedSubjectIndex === 0 ? 'disabled' : ''}>Previous Subject</button>
          <button type="button" id="nextQuizContentSubject" class="btn btn-ghost btn-sm" ${selectedSubjectIndex === subjects.length - 1 ? 'disabled' : ''}>Next Subject</button>
          ${canEditThisQuiz ? '<button type="button" id="saveQuizContentChanges" class="btn btn-primary btn-sm">Save Content Changes</button>' : ''}
        </div>
      </div>
      <div class="small" style="margin-bottom:12px;line-height:1.7">${escapeHtml(contentInfoMessage)}</div>
      <div class="card" style="padding:14px;margin-bottom:14px">
        <div class="h3">${getSubjectLabel(subject, selectedSubjectIndex)}</div>
        <div id="quizSubjectQuestionCount" class="small" style="margin-top:6px">${questions.length} question(s) in this subject</div>
      </div>
      <div data-quiz-subject-index="${selectedSubjectIndex}" class="quiz-editor-list ${canEditThisQuiz ? '' : 'quiz-editor-readonly'}">
        ${questionCards || '<div class="card-beautiful"><div class="small">No questions found in this subject yet.</div></div>'}
      </div>
    `;
    wireRichTextEditors(inner);
    inner.querySelectorAll('.btnRemoveEditorQuestion').forEach((button) => {
      button.onclick = () => {
        if (!confirmTeacherAction('Remove this question from the subject?')) return;
        button.closest('.quiz-editor-question-card')?.remove();
        renumberQuestionCards();
      };
    });
    // Toggle the per-type field blocks live when the teacher changes the
    // question type dropdown. Only the block for the current type is shown.
    inner.querySelectorAll('.quiz-editor-question-card').forEach((card) => {
      const typeSelect = card.querySelector('.quiz-editor-type');
      if (!typeSelect) return;
      const updateBlocks = () => {
        const t = normalizeQuestionType(typeSelect.value);
        card.dataset.questionType = t;
        card.querySelectorAll('.quiz-editor-type-block').forEach((block) => {
          const blockType = block.classList.contains('quiz-editor-type-block-mcq') ? 'mcq'
            : block.classList.contains('quiz-editor-type-block-yesno') ? 'yesno'
            : block.classList.contains('quiz-editor-type-block-short') ? 'short'
            : 'essay';
          block.style.display = (t === blockType) ? '' : 'none';
        });
      };
      typeSelect.onchange = updateBlocks;
    });
    if (!canEditThisQuiz) {
      inner.querySelectorAll('.quiz-editor-list input, .quiz-editor-list textarea, .quiz-editor-list select').forEach((field) => {
        field.setAttribute('readonly', 'readonly');
        field.setAttribute('disabled', 'disabled');
      });
      inner.querySelectorAll('.quiz-editor-list [data-rich-input="true"]').forEach((field) => {
        field.setAttribute('contenteditable', 'false');
      });
      inner.querySelectorAll('.quiz-editor-list [data-rich-command]').forEach((button) => {
        button.setAttribute('disabled', 'disabled');
      });
    }
    const subjectSelect = inner.querySelector('#quizContentSubjectSelect');
    if (subjectSelect) subjectSelect.onchange = () => {
      captureCurrentSubjectDraft();
      selectedSubjectIndex = parseInt(subjectSelect.value || '0', 10) || 0;
      renderEditor();
    };
    const prevSubject = inner.querySelector('#prevQuizContentSubject');
    if (prevSubject) prevSubject.onclick = () => {
      captureCurrentSubjectDraft();
      selectedSubjectIndex = Math.max(0, selectedSubjectIndex - 1);
      renderEditor();
    };
    const nextSubject = inner.querySelector('#nextQuizContentSubject');
    if (nextSubject) nextSubject.onclick = () => {
      captureCurrentSubjectDraft();
      selectedSubjectIndex = Math.min(subjects.length - 1, selectedSubjectIndex + 1);
      renderEditor();
    };
    const saveBtn = inner.querySelector('#saveQuizContentChanges');
    if (saveBtn) saveBtn.onclick = async () => {
      captureCurrentSubjectDraft();
      const updatedQuiz = {
        ...draftQuiz,
        updatedAt: new Date().toISOString(),
        editedAt: new Date().toISOString()
      };
      const quizzes = getAllQuizzes();
      quizzes[updatedQuiz.id] = updatedQuiz;
      // Persist locally without firing save()'s bulk PUT to /api/state/quizzes —
      // pushSingleQuizToCloud below pushes this one quiz through /api/quizzes/<id>
      // and the syncSharedKeys fallback only fires if that per-quiz PUT failed.
      saveAllQuizzes(quizzes, { skipNetworkSync: true });
      const didRegrade = regradeSubmissionsForQuiz(updatedQuiz);
      if (state.currentQuiz && state.currentQuiz.id === updatedQuiz.id) state.currentQuiz = updatedQuiz;
      // Automatic per-quiz upload — ONE attempt, no retry loop (the manual
      // "Sync To Cloud" button is the retrying recovery path).
      const singleQuizOk = await pushSingleQuizToCloud(updatedQuiz, { auto: true });
      // Submissions for THIS quiz only — bulk PUT /api/state/submissions is
      // blocked for teacher sessions (would re-upload every other quiz's
      // submissions too). Regraded rows ride the per-quiz endpoint instead.
      let submissionsCloudOk = true;
      if (didRegrade) {
        const quizSubs = getAllSubmissions({ includeDeleted: true }).filter((s) => s && s.quizId === updatedQuiz.id);
        submissionsCloudOk = await pushSingleQuizSubmissionsToCloud(updatedQuiz.id, quizSubs, { auto: true });
      }
      const quizCloudSaved = singleQuizOk && submissionsCloudOk;
      if (quizCloudSaved) {
        markQuizzesCloudSynced([updatedQuiz.id]);
        showNotification('Quiz content updated', 'success');
      } else {
        showNotification(`Quiz content updated on this device. ${getSharedSyncWarningMessage()}`, 'warning', 7000);
      }
      renderEditor();
    };
  };
  inner.innerHTML = `
    <div class="page-heading">
      <div>
        <div class="h2">${escapeHtml(quiz.title)}</div>
        <div class="small">Quiz ID: ${quiz.id}</div>
        <div class="small">${canSetFromTemplate ? 'Admin quiz template' : `Student code: ${escapeHtml(quiz.id)}`}</div>
      </div>
      <button id="closeQuizSetDetails" class="btn btn-ghost">Close</button>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
      ${canSetFromTemplate ? '<button id="setQuizFromTemplateBtn" class="btn btn-primary btn-sm">Set Quiz</button>' : ''}
      ${canSetFromTemplate ? '' : '<button id="copyQuizSetId" class="btn btn-ghost btn-sm">Copy Student Code</button>'}
      ${canSetFromTemplate ? '' : '<button id="copyQuizSetLink" class="btn btn-primary btn-sm">Copy Link</button>'}
      ${canSetFromTemplate ? '' : '<button id="shareQuizSetLink" class="btn btn-ghost btn-sm">Share Link</button>'}
      ${canEditThisQuiz ? '<button id="deleteQuizSetBtn" class="btn btn-ghost btn-sm">Delete Quiz</button>' : ''}
    </div>
    <div id="quizSetDetailsBody"></div>
  `;
  modal.appendChild(inner); document.body.appendChild(modal);
  document.getElementById('closeQuizSetDetails').onclick = () => modal.remove();
  const setQuizFromTemplateBtn = document.getElementById('setQuizFromTemplateBtn');
  if (setQuizFromTemplateBtn) setQuizFromTemplateBtn.onclick = () => {
    modal.remove();
    showCreateQuizModal('', { templateQuizId: quizId });
  };
  const copyQuizSetIdBtn = document.getElementById('copyQuizSetId');
  if (copyQuizSetIdBtn) copyQuizSetIdBtn.onclick = async () => { await copyQuizAccessCode(getAllQuizzes()[quizId] || draftQuiz); };
  const copyQuizSetLinkBtn = document.getElementById('copyQuizSetLink');
  if (copyQuizSetLinkBtn) copyQuizSetLinkBtn.onclick = async () => { await copyQuizAccessLink(getAllQuizzes()[quizId] || draftQuiz); };
  const shareQuizSetLinkBtn = document.getElementById('shareQuizSetLink');
  if (shareQuizSetLinkBtn) shareQuizSetLinkBtn.onclick = async () => { await shareQuizAccessLink(getAllQuizzes()[quizId] || draftQuiz); };
  const deleteQuizSetBtn = document.getElementById('deleteQuizSetBtn');
  if (deleteQuizSetBtn) deleteQuizSetBtn.onclick = async () => {
    const deleted = await deleteQuizById(quizId, { onDeleted: () => modal.remove() });
    if (deleted) return;
  };
  renderEditor();
}

function renderStudentsView() {
  const container = document.createElement('div');
  container.innerHTML = `
    <div class="page-heading">
      <div>
        <div class="h1">Students</div>
        <div class="small">Manage uploaded classes first, then open one class to add, edit, remove, export, or import students.</div>
      </div>
    </div>
    <div id="teacherStudentManagerHost" class="card"></div>
  `;
  setTimeout(() => {
    renderStudentClassManager(document.getElementById('teacherStudentManagerHost'), state.teacherId, {
      scope: 'teacher',
      includeImport: true,
      includeExport: true,
      includeTemplate: true
    });
  }, 0);
  return container;
}

function renderSettingsView() {
  const teachers = getAllTeachers();
  const currentTeacher = getCurrentTeacher() || {};
  const teacherProfileNeedsAttention = !((currentTeacher.name || '').toString().trim()) || !((currentTeacher.phone || currentTeacher.phoneNumber || '').toString().trim());
  const teacherRows = Object.values(teachers).sort((a,b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const container = document.createElement('div');
  container.innerHTML = `
    <div class="h1">Settings</div>
    <div class="small" style="margin-bottom:var(--space-3)">Tools for backups, access identity, and local delivery.</div>
    ${!isSuperAdmin() && teacherProfileNeedsAttention ? `
      <div class="card" style="margin-bottom:var(--space-3);border:1px solid #FDE68A;background:#FFFBEB">
        <div class="h3">Complete Teacher Profile</div>
        <div class="small" style="margin-top:8px;line-height:1.7">Add your full name and phone number now so they show correctly in Settings, correction messages, token requests, and the admin teacher list.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
          <button id="completeTeacherProfilePrompt" class="btn btn-primary">Update Name & Phone</button>
        </div>
      </div>
    ` : ''}
    <div class="settings-grid">
      <div class="card">
        <div class="h3">Teacher Identity</div>
        <div class="small">You are logged in with this teacher email ID. Your profile name signs correction messages.</div>
        <input class="input-beautiful" value="${escapeHtml(state.teacherId)}" readonly style="margin-top:12px" />
        <div class="small" style="margin-top:10px;line-height:1.7">Name: <strong>${escapeHtml(getTeacherDisplayName(currentTeacher, { preferPlaceholder: true }))}</strong><br/>Phone: <strong>${escapeHtml(getTeacherPhoneLabel(currentTeacher))}</strong></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
          <button id="copyTeacherId" class="btn btn-ghost">Copy Teacher ID</button>
          <button id="editTeacherProfileFromSettings" class="btn btn-primary">Edit Profile</button>
        </div>
      </div>
      <div class="card">
        <div class="h3">Change Password</div>
        <div class="small">Teachers can update their own password from here.</div>
        <label class="small" style="display:block;margin-top:12px">Current password</label>
        <input id="selfCurrentPassword" class="input-beautiful" type="password" />
        <label class="small" style="display:block;margin-top:10px">New password</label>
        <input id="selfNewPassword" class="input-beautiful" type="password" />
        <label class="small" style="display:block;margin-top:10px">Confirm new password</label>
        <input id="selfConfirmPassword" class="input-beautiful" type="password" />
        <button id="saveOwnPassword" class="btn btn-primary" style="margin-top:12px">Update Password</button>
      </div>
      <div class="card">
        <div class="h3">Data Backup</div>
        <div class="small">Download all quizzes and submissions stored in this browser.</div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button id="downloadBackup" class="btn btn-primary">Download Backup</button>
          <button id="importBackup" class="btn btn-ghost">Import Backup</button>
          <input type="file" id="importBackupInput" accept="application/json" style="display:none" />
        </div>
      </div>
      <div class="card">
        <div class="h3">Cloud Sync</div>
        <div class="small">All devices must reach the same OPE Assessor Node server for teacher accounts, licenses, quizzes, and results to sync.</div>
        <label class="small" style="display:block;margin-top:12px">Sync server URL</label>
        <input id="syncApiBaseUrlInput" class="input-beautiful" value="${escapeHtml(NETWORK_SYNC_CONFIG.apiBaseUrl || '')}" placeholder="Leave blank for this same site, or enter https://example.com" />
        <div class="small" id="syncServerStatusText" style="margin-top:10px;line-height:1.7">Current target: <strong>${escapeHtml(getCurrentSyncServerLabel())}</strong><br/>Leave this blank only when this app and the API are opened from the same server address.</div>
        <div class="small" id="syncPendingStatus" style="margin-top:10px;line-height:1.7"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
          <button id="saveSyncServerBtn" class="btn btn-primary">Save Sync Server</button>
          <button id="forceSyncNowBtn" class="btn btn-primary">Force Sync Now</button>
          <button id="testSyncServerBtn" class="btn btn-ghost">Test Connection</button>
          <button id="useThisSiteForSyncBtn" class="btn btn-ghost">Use This Site</button>
        </div>
      </div>
      <div class="card">
        <div class="h3">Local Network</div>
        <div class="small">Show instructions for running the real app server on one computer and opening that same server from other devices on the same Wi-Fi.</div>
        <button id="openNetworkGuide" class="btn btn-ghost" style="margin-top:12px">Find IP Guide</button>
      </div>
      ${isSuperAdmin() ? `
        <div class="card">
          <div class="h3">Token Packages</div>
          <div class="small">1 Token = 1 Quiz = ${formatNaira(TOKEN_PRICE_PER_QUIZ)}. The app now uses only Tokens plus the 3-month unlimited plan.</div>
          <div style="margin-top:12px;display:grid;gap:10px">
            ${getTokenPackageCatalog().map((tokenPackage) => `
              <div class="card" style="padding:12px;border:1px solid #DBEAFE;box-shadow:none">
                <div style="font-weight:800;color:#1D4ED8">${escapeHtml(tokenPackage.label)}</div>
                <div class="small" style="margin-top:4px">${tokenPackage.unlimitedDays
                  ? `${formatNaira(tokenPackage.price)} • ${tokenPackage.unlimitedDays} days on one registered device`
                  : `${tokenPackage.tokens} Token${tokenPackage.tokens === 1 ? '' : 's'} • ${formatNaira(tokenPackage.price)} • ${formatNaira(tokenPackage.effectivePrice)} per quiz`}</div>
                <div class="small" style="margin-top:4px">${escapeHtml(tokenPackage.useCase || '')}</div>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
    </div>
    ${isSuperAdmin() ? `
      <div class="card" style="margin-top:var(--space-3)">
        <div class="card-header"><h3>Super Admin - Teacher Accounts</h3></div>
        <div class="small" style="margin:12px 0">Teacher ID, name, and phone number stay visible here. Token balances stay inside the action dropdown.</div>
        <input id="teacherSearch" class="input-beautiful" placeholder="Search teacher ID, name, or phone..." style="margin-bottom:12px" />
        <div class="table-wrap">
          <table class="table-dense">
            <thead><tr><th>Teacher ID</th><th>Name</th><th>Phone Number</th><th>Role</th><th>Access</th><th>Request</th><th>Created</th><th>Actions</th></tr></thead>
            <tbody id="teacherAdminRows">${teacherRows.map(t => {
              const id = t.teacherId || t.email;
              const rowSearch = [id, getTeacherDisplayName(t, { preferPlaceholder: true }), getTeacherPhoneLabel(t)].join(' ').toLowerCase();
              return `<tr data-teacher-row="${escapeHtml(rowSearch)}"><td>${escapeHtml(id)}</td><td>${escapeHtml(getTeacherDisplayName(t, { preferPlaceholder: true }))}</td><td>${escapeHtml(getTeacherPhoneLabel(t))}</td><td>${escapeHtml(t.role || 'teacher')}</td><td>${escapeHtml(getTeacherAdminAccessSummary(t))}</td><td>${t.tokenRequestedAt ? new Date(t.tokenRequestedAt).toLocaleString() : '-'}</td><td>${t.createdAt ? new Date(t.createdAt).toLocaleString() : ''}</td><td><div class="row-action-shell"><select class="input-beautiful row-action-select teacherAdminActionSelect" data-id="${escapeHtml(id)}"><option value="">Choose action</option><option value="view-account">View Token Details</option><option value="view-exams">View Exams</option><option value="view-students">Students</option><option value="grant-license">Grant Tokens / Unlimited</option><option value="transfer-unlimited-device">Transfer Unlimited Device</option><option value="stop-license">Clear Unlimited</option><option value="reset-password">Reset Password</option><option value="change-id">Change ID</option></select><button class="btn btn-ghost btn-sm btnApplyTeacherAdminAction" data-id="${escapeHtml(id)}">Apply</button></div></td></tr>`;
            }).join('') || '<tr><td colspan="8">No teachers yet.</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    ` : ''}
  `;
  setTimeout(() => {
    document.getElementById('copyTeacherId').onclick = () => {
      copyTextToClipboard(state.teacherId, 'Teacher ID copied');
    };
    const completeProfilePromptBtn = document.getElementById('completeTeacherProfilePrompt');
    if (completeProfilePromptBtn) completeProfilePromptBtn.onclick = () => openTeacherProfileEditor();
    const editProfileBtn = document.getElementById('editTeacherProfileFromSettings');
    if (editProfileBtn) editProfileBtn.onclick = () => openTeacherProfileEditor();
    if (_pendingNewTeacherProfilePrompt && !isSuperAdmin()) {
      _pendingNewTeacherProfilePrompt = false;
      setTimeout(() => openTeacherProfileEditor(), 0);
    }
    const ownPasswordBtn = document.getElementById('saveOwnPassword');
    if (ownPasswordBtn) ownPasswordBtn.onclick = async () => {
      const teacher = getCurrentTeacher();
      if (!teacher) return showNotification('Teacher account not found', 'error');
      if (isSuperAdmin()) return showNotification('The super-admin password is set via the SUPER_ADMIN_PASSWORD environment variable on the server, not from the app.', 'info', 9000);
      const currentPassword = document.getElementById('selfCurrentPassword').value || '';
      const newPassword = document.getElementById('selfNewPassword').value || '';
      const confirmPassword = document.getElementById('selfConfirmPassword').value || '';
      if (!newPassword || newPassword.length < 4) return showNotification('New password must be at least 4 characters', 'error');
      if (newPassword !== confirmPassword) return showNotification('New password and confirmation do not match', 'error');
      if (!confirmTeacherAction('Save your new password now?')) return;
      if (!canUseNetworkSync()) return showNotification('Changing your password requires the OPE server. Connect to a network and try again.', 'error', 9000);
      const result = await postAuthJson('/api/auth/teacher/change-password', { currentPassword, newPassword });
      if (!result.ok) {
        const message = (result.data && result.data.error) || 'Could not update password';
        return showNotification(message, 'error', 8000);
      }
      await recordLocalAuthForPassword(state.teacherId, newPassword);
      showNotification('Password updated', 'success');
      document.getElementById('selfCurrentPassword').value = '';
      document.getElementById('selfNewPassword').value = '';
      document.getElementById('selfConfirmPassword').value = '';
    };
    document.getElementById('downloadBackup').onclick = () => {
      const payload = {
        exportedAt: new Date().toISOString(),
        teacherId: state.teacherId,
        quizzes: getAllQuizzes(),
        submissions: getAllSubmissions()
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const filename = `ope-backup-${new Date().toISOString().slice(0,10)}.json`;
      if (typeof saveAs === 'function') {
        saveAs(blob, filename);
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      }
      showNotification('Backup downloaded', 'success');
    };
    // Import backup handler: open file picker, parse JSON, validate, and restore keys
    const importBtn = document.getElementById('importBackup');
    const importInput = document.getElementById('importBackupInput');
    if (importBtn && importInput) {
      importBtn.onclick = () => importInput.click();
      importInput.onchange = () => {
        const file = (importInput.files && importInput.files[0]) || null;
        if (!file) return;
        if (!confirmTeacherAction('Importing a backup will replace local quizzes and submissions. Continue?')) { importInput.value = ''; return; }
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const txt = (ev && ev.target && ev.target.result) ? ev.target.result : null;
            const payload = txt ? JSON.parse(String(txt)) : null;
            if (!payload || typeof payload !== 'object') throw new Error('Invalid backup format');
            const quizzes = payload.quizzes || null;
            const submissions = payload.submissions || null;
            if (!quizzes || !submissions) throw new Error('Backup missing quizzes or submissions');
            const ok1 = writeLocalStorageValue(STORAGE_KEYS.quizzes, quizzes);
            const ok2 = writeLocalStorageValue(STORAGE_KEYS.submissions, submissions);
            if (!ok1 || !ok2) return showNotification('Could not write backup to storage (quota or error)', 'error', 8000);
            showNotification('Backup imported', 'success', 5000);
            try { render(); } catch (e) { /* ignore */ }
          } catch (err) {
            console.error(err);
            showNotification('Invalid backup file', 'error', 8000);
          } finally {
            importInput.value = '';
          }
        };
        reader.onerror = () => { showNotification('Could not read file', 'error'); importInput.value = ''; };
        reader.readAsText(file);
      };
    }
    const syncApiBaseUrlInput = document.getElementById('syncApiBaseUrlInput');
    const syncServerStatusText = document.getElementById('syncServerStatusText');
    const renderSyncServerStatus = (status) => {
      if (!syncServerStatusText) return;
      const currentTarget = status && status.target ? status.target : getCurrentSyncServerLabel();
      const currentMessage = status && status.message
        ? escapeHtml(status.message)
        : escapeHtml(networkSyncFailureMessage || (networkSyncReady ? `Connected to ${currentTarget}` : `Current target: ${currentTarget}`));
      syncServerStatusText.innerHTML = `Current target: <strong>${escapeHtml(currentTarget)}</strong><br/>${currentMessage}`;
    };
    renderSyncServerStatus();
    const saveSyncServer = async (nextValue, options = {}) => {
      setNetworkSyncApiBaseUrl(nextValue);
      if (syncApiBaseUrlInput) syncApiBaseUrlInput.value = NETWORK_SYNC_CONFIG.apiBaseUrl || '';
      const health = await checkNetworkSyncHealth({ timeoutMs: 5000 });
      renderSyncServerStatus(health);
      if (health.ok) {
        await runSharedSyncCycle({ forcePull: true, forceRender: true });
        if (options.showNotification !== false) showNotification('Cloud sync server saved and connected', 'success', 6000);
      } else if (options.showNotification !== false) {
        showNotification(`Cloud sync server saved, but the connection test failed. ${health.message}`, 'warning', 9000);
      }
    };
    const saveSyncServerBtn = document.getElementById('saveSyncServerBtn');
    if (saveSyncServerBtn) saveSyncServerBtn.onclick = async () => {
      await saveSyncServer(syncApiBaseUrlInput ? syncApiBaseUrlInput.value : '');
    };
    const testSyncServerBtn = document.getElementById('testSyncServerBtn');
    if (testSyncServerBtn) testSyncServerBtn.onclick = async () => {
      const health = await probeNetworkSyncHealth(syncApiBaseUrlInput ? syncApiBaseUrlInput.value : '', { timeoutMs: 5000, captureFailure: false });
      if (!health.ok) {
        networkSyncFailed = true;
        networkSyncFailureMessage = health.message;
      } else {
        networkSyncFailed = false;
        networkSyncFailureMessage = '';
      }
      renderSyncServerStatus(health);
      showNotification(health.ok ? 'Cloud sync server is reachable' : health.message, health.ok ? 'success' : 'error', 9000);
    };
    const useThisSiteForSyncBtn = document.getElementById('useThisSiteForSyncBtn');
    if (useThisSiteForSyncBtn) useThisSiteForSyncBtn.onclick = async () => {
      await saveSyncServer('', { showNotification: true });
    };
    const syncPendingStatus = document.getElementById('syncPendingStatus');
    const renderSyncPendingStatus = () => {
      if (!syncPendingStatus) return;
      const dirty = Array.from(dirtyNetworkKeys);
      if (!dirty.length) {
        syncPendingStatus.innerHTML = networkSyncReady && !networkSyncFailed
          ? '<span style="color:#047857">All changes uploaded.</span>'
          : '';
        return;
      }
      const labels = dirty.map((key) => NETWORK_STATE_KEY_MAP[key] || key).join(', ');
      syncPendingStatus.innerHTML = `<span style="color:#B45309"><strong>${dirty.length}</strong> change-set(s) waiting to upload: ${escapeHtml(labels)}.</span>`;
    };
    renderSyncPendingStatus();
    const forceSyncNowBtn = document.getElementById('forceSyncNowBtn');
    if (forceSyncNowBtn) forceSyncNowBtn.onclick = async () => {
      forceSyncNowBtn.disabled = true;
      const originalLabel = forceSyncNowBtn.textContent;
      forceSyncNowBtn.textContent = 'Syncing…';
      userInitiatedSync = true;
      lastSyncFailedForUser = false;
      try {
        // Quizzes are excluded from the bulk flush — they sync exclusively
        // through /api/quizzes/<id>. Fan them out one at a time below so a
        // teacher with 100 quizzes pushes 100 small requests instead of one
        // 1.7 MB blob to /api/state/quizzes.
        NETWORK_SYNC_KEYS
          .filter((key) => key !== STORAGE_KEYS.quizzes)
          .forEach(markNetworkKeyDirty);
        await flushPendingNetworkWrites([], { pullAfter: false });
        const ownerId = normalizeEmail(state.teacherId);
        // Include unowned quizzes too — pushSingleQuizToCloud stamps the
        // current teacher on them, which is what populates the server's
        // teacher_id column so the bulk submissions read stops dropping their
        // results. Without this, an orphan quiz (no local teacherId) was
        // filtered out HERE, never made it to pushSingleQuizToCloud's stamp,
        // and stayed invisible forever — that's why "X synced successfully"
        // was a count smaller than the dashboard list.
        const ownQuizzes = Object.values(getAllQuizzes() || {}).filter((quiz) => {
          if (!quiz || !quiz.id) return false;
          if (isSuperAdmin()) return true;
          const qOwner = normalizeEmail(quiz.teacherId || '');
          return !qOwner || qOwner === ownerId;
        });
        // Try every quiz in this set, even if one fails — a "wrong teacherId"
        // / oversize / transient failure on one shouldn't block the others.
        let syncedQuizzes = 0;
        const failedQuizIds = [];
        for (const quiz of ownQuizzes) {
          const ok = await pushSingleQuizToCloud(quiz);
          if (ok) syncedQuizzes += 1;
          else failedQuizIds.push(quiz.id);
        }
        await pullNetworkState(true);
        renderSyncPendingStatus();
        renderSyncServerStatus();
        const failureCount = failedQuizIds.length;
        // networkSyncFailed is the source of truth for "did something actually
        // go wrong": a successful pull clears it even when nothing changed
        // (pullNetworkState returns `false` for "no changes", which used to be
        // misread as a failure). A pull error / a real push error sets it.
        const everythingOk = failureCount === 0 && !networkSyncFailed;
        if (everythingOk) {
          showNotification(`Cloud sync completed (${syncedQuizzes} of ${ownQuizzes.length} quiz${ownQuizzes.length === 1 ? '' : 'es'} synced).`, 'success', 6000);
        } else if (failureCount > 0) {
          lastSyncFailedForUser = true;
          console.warn('Force Sync Now: failed quiz ids:', failedQuizIds);
          showNotification(`${syncedQuizzes} of ${ownQuizzes.length} quiz(es) synced — ${failureCount} failed (${failedQuizIds.slice(0, 3).join(', ')}${failureCount > 3 ? '…' : ''}). ${getSharedSyncWarningMessage()}`, 'warning', 9000);
        } else {
          lastSyncFailedForUser = true;
          showNotification(`Quizzes uploaded, but refreshing the latest data hit a snag. ${getSharedSyncWarningMessage()}`, 'warning', 9000);
        }
      } catch (err) {
        lastSyncFailedForUser = true;
        showNotification(`Force sync failed: ${err && err.message ? err.message : 'unknown error'}`, 'error', 9000);
      } finally {
        userInitiatedSync = false;
        forceSyncNowBtn.disabled = false;
        forceSyncNowBtn.textContent = originalLabel;
      }
    };
    document.getElementById('openNetworkGuide').onclick = () => showLocalNetworkGuide();
    const search = document.getElementById('teacherSearch');
    if (search) search.oninput = () => {
      const term = normalizeEmail(search.value);
      document.querySelectorAll('[data-teacher-row]').forEach(row => {
        row.style.display = normalizeEmail(row.dataset.teacherRow).includes(term) ? '' : 'none';
      });
    };
    document.querySelectorAll('.btnApplyTeacherAdminAction').forEach(btn => btn.onclick = async (ev) => {
      if (!isSuperAdmin()) return;
      const actionSelect = ev.currentTarget.parentElement.querySelector('.teacherAdminActionSelect');
      const action = actionSelect ? actionSelect.value : '';
      const id = normalizeEmail(ev.currentTarget.dataset.id);
      if (!action) return showNotification('Choose an admin action first', 'error');
      if (action === 'view-account') {
        showAdminTeacherAccountDetails(id);
      } else if (action === 'view-exams') {
        showAdminTeacherExams(id);
      } else if (action === 'view-students') {
        showAdminTeacherStudents(id);
      } else if (action === 'grant-license') {
        if (id === SUPER_ADMIN_EMAIL) return showNotification('Admin access is already unlimited', 'info');
        const all = getAllTeachers();
        if (!all[id]) return showNotification('Teacher not found', 'error');
        const requestedPackageKey = (all[id].tokenRequestedPackageKey || '').toString().trim().toLowerCase();
        const suggestedPackage = requestedPackageKey || 'starter';
        const enteredPackageKey = (prompt(`Token package for ${id}. Enter single, starter, standard, pro, school, or unlimited-3mo.`, suggestedPackage) || suggestedPackage).trim().toLowerCase();
        const tokenPackage = getTokenPackageByKey(enteredPackageKey);
        if (!tokenPackage) return showNotification('Unknown package key', 'error');
        const now = new Date().toISOString();
        if (tokenPackage.unlimitedDays) {
          const targetDeviceId = (all[id].tokenRequestedDeviceId || all[id].unlimitedDeviceId || prompt(`Device ID to lock ${tokenPackage.label} for ${id}`, '') || '').trim();
          if (!targetDeviceId) return showNotification('Device ID is required for unlimited access', 'error');
          if (!confirmTeacherAction(`Grant ${tokenPackage.label} to ${id} and lock it to device ${targetDeviceId}?`)) return;
          all[id].unlimitedExpiresAt = new Date(Date.now() + tokenPackage.unlimitedDays * 24 * 60 * 60 * 1000).toISOString();
          all[id].unlimitedDeviceId = targetDeviceId;
          all[id].licenseUpdatedAt = now;
          all[id].tokenUpdatedAt = now;
          all[id].updatedAt = now;
          all[id].tokenRequestStatus = 'approved';
          appendTokenTransaction(buildTokenTransaction('unlimited_purchase', 0, `Admin granted ${tokenPackage.label}.`, {
            userId: id,
            packageKey: tokenPackage.key,
            nairaAmount: tokenPackage.price,
            deviceId: targetDeviceId,
            createdAt: now
          }));
        } else {
          if (!confirmTeacherAction(`Grant ${tokenPackage.tokens} Token${tokenPackage.tokens === 1 ? '' : 's'} to ${id}?`)) return;
          all[id].tokenBalance = getTeacherTokenBalance(all[id]) + tokenPackage.tokens;
          all[id].licenseUpdatedAt = now;
          all[id].tokenUpdatedAt = now;
          all[id].updatedAt = now;
          all[id].tokenRequestStatus = 'approved';
          appendTokenTransaction(buildTokenTransaction('token_purchase', tokenPackage.tokens, `Admin granted ${tokenPackage.label}.`, {
            userId: id,
            packageKey: tokenPackage.key,
            nairaAmount: tokenPackage.price,
            createdAt: now
          }));
        }
        all[id].tokenRequestedAt = '';
        all[id].tokenRequestedPackageKey = '';
        all[id].tokenRequestedAmount = 0;
        all[id].tokenRequestedTokens = 0;
        all[id].tokenRequestedDeviceId = '';
        saveAllTeachers(all);
        const sharedSyncOk = await syncSharedKeys([STORAGE_KEYS.teachers, STORAGE_KEYS.tokenTransactions]);
        showNotification(sharedSyncOk ? 'Token package granted' : `Token package granted locally. ${getSharedSyncWarningMessage()}`, sharedSyncOk ? 'success' : 'warning', 7000);
        render();
      } else if (action === 'transfer-unlimited-device') {
        if (id === SUPER_ADMIN_EMAIL) return showNotification('Admin access does not need device transfer', 'info');
        const all = getAllTeachers();
        if (!all[id]) return showNotification('Teacher not found', 'error');
        if (!all[id].unlimitedExpiresAt || !getUnlimitedDaysLeft(all[id])) return showNotification('This teacher has no active unlimited plan to transfer', 'error');
        const lastTransferStamp = all[id].lastUnlimitedDeviceTransferAt ? new Date(all[id].lastUnlimitedDeviceTransferAt).getTime() : 0;
        if (lastTransferStamp && (Date.now() - lastTransferStamp) < TOKEN_UNLIMITED_TRANSFER_COOLDOWN_DAYS * 24 * 60 * 60 * 1000) {
          return showNotification(`Unlimited device transfer is limited to once every ${TOKEN_UNLIMITED_TRANSFER_COOLDOWN_DAYS} days.`, 'error', 7000);
        }
        const nextDeviceId = (prompt(`Enter the new device ID for ${id}`, all[id].tokenRequestedDeviceId || '') || '').trim();
        if (!nextDeviceId) return;
        if (!confirmTeacherAction(`Transfer unlimited access for ${id} to device ${nextDeviceId}?`)) return;
        const now = new Date().toISOString();
        all[id].unlimitedDeviceId = nextDeviceId;
        all[id].lastUnlimitedDeviceTransferAt = now;
        all[id].licenseUpdatedAt = now;
        all[id].tokenUpdatedAt = now;
        all[id].updatedAt = now;
        saveAllTeachers(all);
        appendTokenTransaction(buildTokenTransaction('unlimited_transfer', 0, 'Admin transferred unlimited access to a new device.', {
          userId: id,
          deviceId: nextDeviceId,
          createdAt: now
        }));
        const sharedSyncOk = await syncSharedKeys([STORAGE_KEYS.teachers, STORAGE_KEYS.tokenTransactions]);
        showNotification(sharedSyncOk ? 'Unlimited device transferred' : `Unlimited device transferred locally. ${getSharedSyncWarningMessage()}`, sharedSyncOk ? 'success' : 'warning', 7000);
        render();
      } else if (action === 'stop-license') {
        if (id === SUPER_ADMIN_EMAIL) return showNotification('Admin unlimited access cannot be cleared', 'info');
        if (!confirmTeacherAction(`Clear unlimited access for ${id}? Token balance will remain untouched.`)) return;
        const all = getAllTeachers();
        if (!all[id]) return showNotification('Teacher not found', 'error');
        const now = new Date().toISOString();
        all[id].unlimitedExpiresAt = '';
        all[id].unlimitedDeviceId = '';
        all[id].licenseStopped = false;
        all[id].licenseUpdatedAt = now;
        all[id].tokenUpdatedAt = now;
        all[id].updatedAt = now;
        saveAllTeachers(all);
        appendTokenTransaction(buildTokenTransaction('unlimited_cleared', 0, 'Admin cleared unlimited access.', {
          userId: id,
          createdAt: now
        }));
        const sharedSyncOk = await syncSharedKeys([STORAGE_KEYS.teachers, STORAGE_KEYS.tokenTransactions]);
        showNotification(sharedSyncOk ? 'Unlimited access cleared' : `Unlimited access cleared locally. ${getSharedSyncWarningMessage()}`, sharedSyncOk ? 'success' : 'warning', 7000);
        render();
      } else if (action === 'reset-password') {
        if (id === SUPER_ADMIN_EMAIL) return showNotification('The super-admin password is rotated via the SUPER_ADMIN_PASSWORD env var, not from the app.', 'info', 9000);
        const next = prompt('Enter new password for ' + id);
        if (!next) return;
        if (next.length < 4) return showNotification('Password must be at least 4 characters', 'error');
        if (!confirmTeacherAction(`Reset the password for ${id}?`)) return;
        if (!canUseNetworkSync()) return showNotification('Resetting passwords requires the OPE server. Connect to a network and try again.', 'error', 9000);
        const result = await postAuthJson('/api/auth/teacher/admin-reset-password', { teacherEmail: id, newPassword: next });
        if (!result.ok) {
          const message = (result.data && result.data.error) || 'Could not reset password';
          return showNotification(message, 'error', 8000);
        }
        clearLocalAuthRecord(id);
        await pullSharedStateSilently({ forcePull: true, timeoutMs: 5000 }).catch(() => {});
        showNotification('Password reset', 'success', 6000);
      } else if (action === 'change-id') {
        if (id === SUPER_ADMIN_EMAIL) return showNotification('Admin email ID cannot be changed here', 'info');
        const newId = normalizeEmail(prompt('Enter new teacher email ID for ' + id) || '');
        if (!newId || newId === id) return;
        if (!confirmTeacherAction(`Change teacher ID from ${id} to ${newId}?`)) return;
        const teacher = getAllTeachers()[id];
        if (!teacher) return showNotification('Teacher not found', 'error');
        const result = updateTeacherProfileRecord(id, {
          email: newId,
          name: teacher.name || '',
          phone: teacher.phone || teacher.phoneNumber || ''
        });
        if (!result.ok) return showNotification(result.message || 'Could not change teacher ID', 'error');
        const sharedSyncOk = await syncSharedKeys([STORAGE_KEYS.teachers, STORAGE_KEYS.students, STORAGE_KEYS.quizzes]);
        showNotification(sharedSyncOk ? 'Teacher ID changed' : `Teacher ID changed locally. ${getSharedSyncWarningMessage()}`, sharedSyncOk ? 'success' : 'warning', 7000);
        render();
      }
      if (actionSelect) actionSelect.value = '';
    });
  }, 0);
  return container;
}

function openSupportChooser() {
  const settings = getSupportSettings();
  let modal = document.getElementById('supportChooserModal');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'supportChooserModal';
  modal.className = 'student-result-modal';
  const inner = document.createElement('div');
  inner.className = 'card-beautiful admin-modal-card';
  inner.style.width = 'min(420px, 94vw)';
  inner.innerHTML = `
    <div class="page-heading">
      <div>
        <div class="h2">Help and Support</div>
        <div class="small">Choose how you want to contact the admin support line.</div>
      </div>
      <button id="closeSupportChooser" class="btn btn-ghost">Close</button>
    </div>
    <div style="display:grid;gap:12px;margin-top:14px">
      <button id="supportByEmail" class="btn btn-primary">Email Support</button>
      <button id="supportByWhatsapp" class="btn btn-ghost">WhatsApp Support</button>
    </div>
  `;
  modal.appendChild(inner);
  document.body.appendChild(modal);
  modal.onclick = (event) => { if (event.target === modal) modal.remove(); };
  document.getElementById('closeSupportChooser').onclick = () => modal.remove();
  document.getElementById('supportByEmail').onclick = () => {
    if (!settings.email) return showNotification('Support email has not been set yet', 'error');
    window.location.href = `mailto:${encodeURIComponent(settings.email)}?subject=${encodeURIComponent('OPE Assessor Support Request')}&body=${encodeURIComponent(buildTeacherSupportRequestMessage())}`;
  };
  document.getElementById('supportByWhatsapp').onclick = () => {
    const phone = (settings.whatsapp || '').replace(/[^\d]/g, '');
    if (!phone) return showNotification('Support WhatsApp number has not been set yet', 'error');
    openWhatsappChat(phone, buildTeacherSupportRequestMessage());
  };
}

function renderTeacherGuideView() {
  const topics = [
    {
      id: 'create-account',
      title: 'Create Teacher Account',
      description: 'Set up a teacher account and sign in.',
      steps: [
        'Open the Teacher page from the top navigation.',
        'Type your teacher email ID and choose the password you want to use for this account.',
        'Click Create Teacher ID the first time you are entering the app with that email.',
        'Wait for the success message, then use the same email ID and password any time you want to log in again.',
        'If the account already exists, type the same email ID and password and click Login.',
        'After login, open Settings if you want to copy your teacher ID, change your password, or download a backup.'
      ]
    },
    {
      id: 'import-students',
      title: 'Import Students',
      description: 'Upload class lists step by step.',
      steps: [
        'Open Students from the teacher menu.',
        'Click Student Template to download the import file first.',
        'Open the file and fill in Name, Email or Registration No / ID, and the Class column for every student.',
        'Save the file as Excel or CSV after you finish entering the class list.',
        'Return to Students and click Import Students.',
        'Choose the saved file and wait for the upload confirmation message.',
        'Open the class selector or class cards to confirm that each student entered the correct class.',
        'If a row was uploaded without a class, open that student and edit the class immediately so quiz assignment stays accurate.'
      ]
    },
    {
      id: 'manage-classes',
      title: 'Manage Classes and Students',
      description: 'Open one class at a time and manage students inside it.',
      steps: [
        'Open Students and select the class card or class dropdown you want to manage.',
        'Review only the students inside that selected class.',
        'Use the row action dropdown to edit a student or remove a student from that class list.',
        'Use Add Student Manually when one student needs to be added without re-uploading the whole file.',
        'Save changes and stay on the same class so you can confirm the class list is correct before setting a quiz for that class.'
      ]
    },
    {
      id: 'export-items',
      title: 'Exports and Templates',
      description: 'Download templates, student lists, and result files.',
      steps: [
        'Open Students and click Student Template when you want the import sheet for class uploads.',
        'Use Export Excel in Students when you want the currently uploaded student register.',
        'Open Create Quiz and click Export Quiz Template before preparing question files for upload.',
        'Open Results for a quiz and use Export Excel when you need the raw result sheet.',
        'Use PDF Summary in Results when you need the broadsheet in printable form.',
        'For multi-subject quizzes, choose Grouped Subjects or Separate Subject Columns before the broadsheet PDF downloads.',
        'Confirm the institution name is filled in the quiz settings first if you want it to appear on the broadsheet PDF.'
      ]
    },
    {
      id: 'create-quiz',
      title: 'Create a Quiz',
      description: 'Build a quiz from start to finish.',
      steps: [
        'Open Create Quiz from Overview or Question Bank.',
        'Choose who can take the quiz first: Public or Uploaded class.',
        'If you choose Uploaded class, select the class that already exists in Students.',
        'Enter the institution name, quiz title, timing, grading rules, and schedule.',
        'Calculator access starts on Basic by default, and you can change it to None or Scientific if needed.',
        'Turn on camera requirement only when monitoring is compulsory for that quiz.',
        'Add each subject and upload one file per subject, or paste CSV for a single-subject quiz.',
        'Use Add Question Image inside each subject when a diagram or illustration should appear in selected question numbers. Enter the numbers with commas such as 1, 3, 5 and choose whether the image should show before or after the question text.',
        'Add certificate signatories only if you need them, and decide whether each signatory name should show or stay hidden on the certificate.',
        'Saving a brand-new quiz uses either 1 Token or your active unlimited plan on the registered device. Editing an existing quiz does not deduct a token.',
        'Save the quiz, then use Sync To Cloud if the quiz still shows Pending cloud sync.'
      ]
    },
    {
      id: 'admin-quizzes',
      title: 'Use Admin Quizzes',
      description: 'Reuse question content prepared by the admin.',
      steps: [
        'The super admin can open Question Bank, click Create Quiz, enter the question content, and save it as an admin quiz.',
        'After the admin syncs that quiz, registered teachers can open Question Bank and scroll to the Admin Quizzes section.',
        'Use the action dropdown on any admin quiz row and choose View Content when you want to inspect the full questions first.',
        'Choose Set Quiz from the same dropdown when you want to use that content for your own students.',
        'Set Quiz opens the normal quiz-setting workspace with the admin content already loaded, but it does not change the original admin quiz.',
        'From that screen, you can edit the title, choose Public or Uploaded class, add or change the class, preview the questions, adjust settings, and save as your own quiz normally.'
      ]
    },
    {
      id: 'view-edit-content',
      title: 'View and Edit Quiz Content',
      description: 'Review subject content and edit it from View Content.',
      steps: [
        'Open Question Bank and click View Content for the quiz.',
        'If the quiz has more than one subject, choose the subject from the subject selector or move with Previous Subject and Next Subject.',
        'Edit the question text directly in the rich-text editor. Bold text, italics, lists, superscript, subscript, line breaks, and special characters stay visible while you edit.',
        'Update options, answer, topic, difficulty, explanation, learning point, or key concept for any question that needs correction.',
        'Use Remove on a question only when you truly want that question deleted from the subject.',
        'Click Save Content Changes when you finish editing the current subject.',
        'If shared sync is active, the cloud copy is refreshed after save so other devices use the updated content too.'
      ]
    },
    {
      id: 'results-management',
      title: 'Results and Score Editing',
      description: 'Manage submissions, edit scores, and delete results safely.',
      steps: [
        'Open View Results for the quiz.',
        'Use the action dropdown on any student row to edit score, download correction, email, or delete.',
        'When you edit a score, save it so the new score appears in teacher exports, broadsheet PDFs, and student result views.',
        'Use PDF Summary when you need the broadsheet PDF. The broadsheet now keeps only the student name, score, percent, and status columns for cleaner printing.',
        'Student correction links now open into a direct verified-result loading page and start the correction PDF automatically after the result is found.',
        'Student result summaries now show the grading band, second-person remark, and captured IP address for easier tracking.',
        'Question images assigned in the quiz builder also appear in the quiz interface, correction PDF, and facility index PDF.',
        'When you delete a result, confirm the warning so the result is removed and stays removed.',
        'Use End Test when you want to stop the quiz before the scheduled end time.'
      ]
    },
    {
      id: 'licensing',
      title: 'Tokens and Unlimited Access',
      description: 'Request and manage token bundles or the 3-month unlimited plan.',
      steps: [
        'Open the token banner or Buy Tokens whenever your token balance is low or you want unlimited access.',
        '1 Token = 1 Quiz Attempt = N1,000. Token bundles are Single, Starter, Standard, Pro, and School.',
        'The 3-month unlimited plan is locked to the device ID shown in the request modal, so copy that ID correctly when you contact the admin.',
        'Request the selected token bundle or unlimited plan by Email or WhatsApp so the package, amount, and device ID are saved with your teacher record.',
        'Super admins can open Settings and either grant tokens, grant unlimited, transfer the unlimited device, or clear unlimited access directly from the teacher table.',
        'If unlimited is active on another device, you can still continue on this device with tokens until the admin transfers the unlimited device.'
      ]
    },
    {
      id: 'teacher-settings',
      title: 'Settings and Password',
      description: 'Update your own access without waiting for admin help.',
      steps: [
        'Open Settings from the teacher navigation.',
        'Use Teacher Identity if you want to copy your teacher email ID quickly.',
        'Use Edit Profile when you want to update the name, phone number, or teacher email ID attached to your account.',
        'Use Change Password to enter your current password, then your new password twice.',
        'Click Update Password and confirm when the warning message appears.',
        'Use Download Backup when you want a local copy of quizzes and submissions from this device.'
      ]
    },
    {
      id: 'sync-sharing',
      title: 'Cloud Sync and Sharing',
      description: 'Make quizzes work across devices.',
      steps: [
        'Check the status on each quiz card. Cloud synced means the latest version of that quiz has already been copied to the shared server, so other devices can open the same quiz data.',
        'If the quiz says Pending cloud sync, click Sync To Cloud first.',
        'Open on a quiz card means the test is still active and students can still enter it. Ended means the test window is closed for students.',
        'Use Copy Student Code or Copy Link after sync.',
        'Shared result links and correction links depend on shared sync, so confirm the backend is active before sending any link outside the teacher device.',
        'If shared sync looks inactive, fix the backend first before sending the quiz code or student link.',
        'When a quiz was created on one phone before cloud sync was fixed, reopen it on that original device and save or sync it once so the shared copy is uploaded.'
      ]
    },
    {
      id: 'support',
      title: 'Support and Help',
      description: 'Reach the admin from inside the app.',
      steps: [
        'Open Support from the teacher menu or the top Support button.',
        'Choose Email or WhatsApp.',
        'Admins can open Support and update the live support email and WhatsApp number from there.'
      ]
    }
  ];
  const selectedTopic = topics.find((topic) => topic.id === state.teacherGuideTopic) || null;
  const container = document.createElement('div');
  container.innerHTML = `
    <div class="page-heading">
      <div>
        <div class="h1">User Guide</div>
        <div class="small">Choose one topic, then read the step-by-step guide for that exact task.</div>
      </div>
    </div>
    <div class="guide-layout" style="display:grid;grid-template-columns:minmax(260px,.9fr) minmax(0,1.3fr);gap:16px">
      <div class="card-beautiful">
        <div class="h3">Guide Topics</div>
        <div class="small" style="margin-top:6px">Tap any item below.</div>
        <div style="display:grid;gap:10px;margin-top:14px">
          ${topics.map((topic) => `
            <button type="button" class="btn btn-ghost guideTopicBtn ${selectedTopic && selectedTopic.id === topic.id ? 'guide-topic-active' : ''}" data-topic="${topic.id}" style="justify-content:flex-start;text-align:left">
              <span>
                <strong style="display:block">${escapeHtml(topic.title)}</strong>
                <span class="small">${escapeHtml(topic.description)}</span>
              </span>
            </button>
          `).join('')}
        </div>
      </div>
      <div class="card-beautiful">
        ${selectedTopic ? `
          <div class="h3">${escapeHtml(selectedTopic.title)}</div>
          <div class="small" style="margin-top:8px">${escapeHtml(selectedTopic.description)}</div>
          <ol class="guide-step-list" style="margin:18px 0 0;padding-left:18px;display:grid;gap:12px">
            ${selectedTopic.steps.map((step) => `<li style="line-height:1.7;color:#334155">${escapeHtml(step)}</li>`).join('')}
          </ol>
        ` : `
          <div class="h3">Choose a Guide Topic</div>
          <div class="small" style="margin-top:8px;line-height:1.7">Nothing is opened yet. Choose one topic from the left to see the full step-by-step explanation for that task only.</div>
        `}
      </div>
    </div>
  `;
  setTimeout(() => {
    container.querySelectorAll('.guideTopicBtn').forEach((button) => {
      button.onclick = () => {
        state.teacherGuideTopic = button.dataset.topic || '';
        render();
      };
    });
  }, 0);
  return container;
}

function renderTeacherSupportView() {
  const support = getSupportSettings();
  const container = document.createElement('div');
  container.innerHTML = `
    <div class="page-heading">
      <div>
        <div class="h1">Help and Support</div>
        <div class="small">Reach the admin quickly by email or WhatsApp. Admins can update the live support contacts here.</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button id="supportPageEmail" class="btn btn-primary">Email</button>
        <button id="supportPageWhatsapp" class="btn btn-ghost">WhatsApp</button>
      </div>
    </div>
    <div class="settings-grid">
      <div class="card">
        <div class="h3">Contact Admin</div>
        <div class="small" style="margin-top:12px;line-height:1.7">Use the buttons above to open email or WhatsApp directly. The support contact details stay hidden from the general teacher view.</div>
      </div>
      ${isSuperAdmin() ? `
        <div class="card">
          <div class="h3">Admin Contact Settings</div>
          <div class="small" style="margin-bottom:12px">Update the support email and WhatsApp number that teachers will use.</div>
          <label class="small">Support email</label>
          <input id="supportEmailInput" class="input-beautiful" value="${escapeHtml(support.email || '')}" />
          <div style="height:10px"></div>
          <label class="small">WhatsApp number</label>
          <input id="supportWhatsappInput" class="input-beautiful" value="${escapeHtml(support.whatsapp || '')}" placeholder="e.g. 2348012345678" />
          <button id="saveSupportSettingsBtn" class="btn btn-primary" style="margin-top:12px">Save Support Settings</button>
        </div>
      ` : ''}
    </div>
  `;
  setTimeout(() => {
    document.getElementById('supportPageEmail').onclick = () => {
      if (!support.email) return showNotification('Support email has not been set yet', 'error');
      window.location.href = `mailto:${encodeURIComponent(support.email)}?subject=${encodeURIComponent('OPE Assessor Support Request')}&body=${encodeURIComponent(buildTeacherSupportRequestMessage())}`;
    };
    document.getElementById('supportPageWhatsapp').onclick = () => {
      const phone = (support.whatsapp || '').replace(/[^\d]/g, '');
      if (!phone) return showNotification('Support WhatsApp number has not been set yet', 'error');
      openWhatsappChat(phone, buildTeacherSupportRequestMessage());
    };
    const saveBtn = document.getElementById('saveSupportSettingsBtn');
    if (saveBtn) saveBtn.onclick = () => {
      const email = (document.getElementById('supportEmailInput').value || '').trim();
      const whatsapp = (document.getElementById('supportWhatsappInput').value || '').trim();
      if (!email && !whatsapp) return showNotification('Enter at least one support contact', 'error');
      if (!confirmTeacherAction('Save these support contact settings?')) return;
      saveSupportSettings({ email, whatsapp });
      showNotification('Support settings saved', 'success');
      render();
    };
  }, 0);
  return container;
}

function openStudentEditorModal(teacherId, student = null, onSaved = null, options = {}) {
  let modal = document.getElementById('studentEditorModal');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'studentEditorModal';
  modal.className = 'student-result-modal';
  const inner = document.createElement('div');
  inner.className = 'card-beautiful admin-modal-card';
  inner.style.width = 'min(520px, 94vw)';
  const isEditing = !!student;
  inner.innerHTML = `
    <div class="page-heading">
      <div>
        <div class="h2">${isEditing ? 'Edit Student' : 'Add Student'}</div>
        <div class="small">${escapeHtml(normalizeEmail(teacherId))}</div>
      </div>
      <button id="closeStudentEditor" class="btn btn-ghost">Close</button>
    </div>
    <label class="small">Full name</label>
    <input id="studentEditorName" class="input-beautiful" value="${escapeHtml(student?.name || '')}" />
    <div style="height:10px"></div>
    <label class="small">Email</label>
    <input id="studentEditorEmail" class="input-beautiful" value="${escapeHtml(student?.email || '')}" />
    <div style="height:10px"></div>
    <label class="small">Registration No / ID</label>
    <input id="studentEditorReg" class="input-beautiful" value="${escapeHtml(student?.registrationNo || student?.id || '')}" />
    <div style="height:10px"></div>
    <label class="small">Class</label>
    <input id="studentEditorClass" class="input-beautiful" value="${escapeHtml(normalizeClassName(student?.className || student?.class || options.defaultClassName || ''))}" placeholder="e.g. SS1A" />
    <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:16px">
      <button id="cancelStudentEditor" class="btn btn-ghost">Cancel</button>
      <button id="saveStudentEditor" class="btn btn-primary">${isEditing ? 'Save Changes' : 'Add Student'}</button>
    </div>
  `;
  modal.appendChild(inner);
  document.body.appendChild(modal);
  modal.onclick = (event) => { if (event.target === modal) modal.remove(); };
  document.getElementById('closeStudentEditor').onclick = () => modal.remove();
  document.getElementById('cancelStudentEditor').onclick = () => modal.remove();
  document.getElementById('saveStudentEditor').onclick = () => {
    const payload = {
      name: (document.getElementById('studentEditorName').value || '').trim(),
      email: (document.getElementById('studentEditorEmail').value || '').trim(),
      registrationNo: (document.getElementById('studentEditorReg').value || '').trim(),
      id: (document.getElementById('studentEditorReg').value || '').trim(),
      className: normalizeClassName(document.getElementById('studentEditorClass').value || ''),
      sourceQuizId: student?.sourceQuizId || '',
      uploadedAt: student?.uploadedAt || new Date().toISOString()
    };
    if (!payload.name) return showNotification('Enter the student name', 'error');
    if (!payload.email && !payload.registrationNo) return showNotification('Enter at least email or registration number', 'error');
    if (!payload.className) return showNotification('Enter the class name for this student', 'error');
    if (!confirmTeacherAction(`${isEditing ? 'Save changes for' : 'Add'} ${payload.name}?`)) return;
    if (!upsertStudentForTeacher(teacherId, payload, payload.sourceQuizId || 'General upload')) return showNotification('Could not save student information', 'error');
    modal.remove();
    showNotification(isEditing ? 'Student updated' : 'Student added', 'success');
    if (typeof onSaved === 'function') onSaved(payload);
  };
}

function buildStudentTableRows(students = [], options = {}) {
  const editable = options.editable !== false;
  return students.map((student) => `
    <tr>
      <td>${escapeHtml(student.name || '')}</td>
      <td>${escapeHtml(student.email || '')}</td>
      <td>${escapeHtml(student.registrationNo || student.id || '')}</td>
      <td>${escapeHtml(normalizeClassName(student.className || student.class || ''))}</td>
      <td>${escapeHtml(student.sourceQuizId || 'General upload')}</td>
      <td>${student.uploadedAt ? new Date(student.uploadedAt).toLocaleString() : ''}</td>
      ${editable ? `
        <td class="text-right">
          <div class="row-action-shell">
            <select class="input-beautiful row-action-select studentRowActionSelect" data-key="${escapeHtml(normalizeEmail(student.email || student.id || student.registrationNo || student.name))}">
              <option value="">Choose action</option>
              <option value="edit">Edit Student</option>
              <option value="remove">Remove Student</option>
            </select>
            <button class="btn btn-ghost btn-sm btnApplyStudentAction" data-key="${escapeHtml(normalizeEmail(student.email || student.id || student.registrationNo || student.name))}">Apply</button>
          </div>
        </td>
      ` : ''}
    </tr>
  `).join('');
}

function renderStudentClassManager(container, teacherId, options = {}) {
  if (!container) return;
  const scope = options.scope || 'teacher';
  const ownTeacher = normalizeEmail(teacherId) === normalizeEmail(state.teacherId);
  const canModify = !!(ownTeacher && canSetQuestions() && !options.readOnly);
  const includeImport = !!options.includeImport && canModify;
  const includeExport = !!options.includeExport;
  const includeTemplate = !!options.includeTemplate && canModify;
  const groups = getStudentClassGroups(teacherId);
  const classNames = Object.keys(groups).sort((left, right) => left.localeCompare(right));
  const preferred = getSelectedClassFilter(teacherId, scope);
  const selectedClass = preferred && groups[preferred] ? preferred : '';
  setSelectedClassFilter(teacherId, selectedClass, scope);
  const visibleStudents = selectedClass ? (groups[selectedClass] || []) : [];
  container.innerHTML = `
    <div class="student-class-shell">
      <div class="student-class-toolbar" style="display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:14px">
        <div>
          <div class="small">Choose class</div>
          <select id="${scope}StudentClassFilter" class="input-beautiful" style="min-width:220px">
            <option value="">Open a class</option>
            ${classNames.map((className) => `<option value="${escapeHtml(className)}" ${selectedClass === className ? 'selected' : ''}>${escapeHtml(className)} (${groups[className].length})</option>`).join('')}
          </select>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${includeTemplate ? '<button type="button" id="' + scope + 'StudentsTemplate" class="btn btn-ghost">Student Template</button>' : ''}
          ${includeExport ? '<button type="button" id="' + scope + 'StudentsExport" class="btn btn-ghost">Export Excel</button>' : ''}
          ${includeImport ? '<button type="button" id="' + scope + 'StudentsImport" class="btn btn-primary">Import Students</button>' : ''}
          ${canModify ? `<button type="button" id="${scope}StudentsAdd" class="btn btn-primary">Add Student Manually</button>` : ''}
        </div>
      </div>
      ${!canModify && ownTeacher ? '<div class="small" style="margin-bottom:12px;color:#92400E">Your account cannot edit this class right now. You can still view your uploaded classes here.</div>' : ''}
      <div class="student-class-cards" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px">
        ${classNames.map((className) => `
          <button type="button" class="card-beautiful studentClassCard ${selectedClass === className ? 'student-class-active' : ''}" data-class="${escapeHtml(className)}" style="text-align:left;border:${selectedClass === className ? '2px solid #4F46E5' : '1px solid #E2E8F0'}">
            <div class="h3">${escapeHtml(className)}</div>
            <div class="small" style="margin-top:6px">${groups[className].length} student(s)</div>
          </button>
        `).join('') || '<div class="card-beautiful"><div class="small">No class uploaded yet.</div></div>'}
      </div>
      ${selectedClass ? `
        <div class="card" style="padding:14px;margin-bottom:14px">
          <div class="page-heading" style="margin-bottom:0">
            <div>
              <div class="h3">${escapeHtml(selectedClass)}</div>
              <div class="small">${visibleStudents.length} student(s) in this class</div>
            </div>
            <button type="button" id="${scope}BackToClasses" class="btn btn-ghost btn-sm">Back to Classes</button>
          </div>
        </div>
        <div class="table-wrap">
          <table class="table-dense">
            <thead><tr><th>Name</th><th>Email</th><th>Registration No / ID</th><th>Class</th><th>Source Quiz</th><th>Uploaded</th>${canModify ? '<th class="text-right">Actions</th>' : ''}</tr></thead>
            <tbody>
              ${visibleStudents.length ? buildStudentTableRows(visibleStudents, { editable: canModify }) : `<tr><td colspan="${canModify ? 7 : 6}">No students in this class yet.</td></tr>`}
            </tbody>
          </table>
        </div>
      ` : '<div class="card-beautiful"><div class="small">Choose a class above to open the students inside it.</div></div>'}
    </div>
  `;
  const rerender = () => renderStudentClassManager(container, teacherId, options);
  container.querySelectorAll('.studentClassCard').forEach((button) => {
    button.onclick = () => {
      setSelectedClassFilter(teacherId, button.dataset.class || '', scope);
      rerender();
    };
  });
  const classFilter = container.querySelector(`#${scope}StudentClassFilter`);
  if (classFilter) classFilter.onchange = () => {
    setSelectedClassFilter(teacherId, classFilter.value || '', scope);
    rerender();
  };
  const backBtn = container.querySelector(`#${scope}BackToClasses`);
  if (backBtn) backBtn.onclick = () => {
    setSelectedClassFilter(teacherId, '', scope);
    rerender();
  };
  const addBtn = container.querySelector(`#${scope}StudentsAdd`);
  if (addBtn) addBtn.onclick = () => openStudentEditorModal(teacherId, null, () => {
    if (selectedClass) setSelectedClassFilter(teacherId, selectedClass, scope);
    rerender();
  }, { ...options, defaultClassName: selectedClass });
  const importBtn = container.querySelector(`#${scope}StudentsImport`);
  if (importBtn) importBtn.onclick = () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel';
    inp.onchange = (event) => {
      const file = event.target.files[0];
      if (!file) return;
      parseQuestionsFile(file, true).then((list) => {
        list.forEach((student) => upsertStudentForTeacher(teacherId, {
          ...student,
          sourceQuizId: student.sourceQuizId || 'General upload'
        }, student.sourceQuizId || 'General upload'));
        const firstClass = normalizeClassName((list[0] && (list[0].className || list[0].class)) || '');
        if (firstClass) setSelectedClassFilter(teacherId, firstClass, scope);
        const missingClassCount = list.filter((student) => !normalizeClassName(student.className || student.class || '')).length;
        showNotification(`Students uploaded (${list.length})`, 'success');
        if (missingClassCount) {
          showNotification(`${missingClassCount} imported student(s) had no class and were placed under Unassigned.`, 'warning', 7000);
        }
        rerender();
      }).catch((error) => { console.error(error); showNotification('Could not import students', 'error'); });
    };
    inp.click();
  };
  const templateBtn = container.querySelector(`#${scope}StudentsTemplate`);
  if (templateBtn) templateBtn.onclick = () => {
    if (typeof XLSX === 'undefined') return showNotification('Excel library not loaded', 'error');
    const rows = [['Name','Email (optional if Reg No is provided)','Registration No / ID','Class'], ['Ada Okafor', '', 'REG001', 'SS1A']];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Students');
    XLSX.writeFile(wb, 'ope-student-template.xlsx');
    showNotification('Student template exported', 'success');
  };
  const exportBtn = container.querySelector(`#${scope}StudentsExport`);
  if (exportBtn) exportBtn.onclick = () => {
    if (typeof XLSX === 'undefined') return showNotification('Excel library not loaded', 'error');
    const rows = [['Name','Email','Registration No / ID','Class','Source Quiz','Uploaded']];
    getStudentsForTeacher(teacherId).forEach((student) => rows.push([student.name, student.email, student.registrationNo || student.id, normalizeClassName(student.className || student.class || ''), student.sourceQuizId || '', student.uploadedAt || '']));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Students');
    XLSX.writeFile(wb, `ope-students-${normalizeEmail(teacherId) || 'teacher'}.xlsx`);
    showNotification('Students exported', 'success');
  };
  container.querySelectorAll('.btnApplyStudentAction').forEach((button) => {
    button.onclick = () => {
      const rowKey = button.dataset.key || '';
      const actionSelect = button.parentElement.querySelector('.studentRowActionSelect');
      const action = actionSelect ? actionSelect.value : '';
      const student = getStudentsForTeacher(teacherId).find((item) => normalizeEmail(item.email || item.id || item.registrationNo || item.name) === rowKey);
      if (!student) return showNotification('Student not found', 'error');
      if (!action) return showNotification('Choose a student action first', 'error');
      if (action === 'edit') {
        openStudentEditorModal(teacherId, student, rerender, options);
      } else if (action === 'remove') {
        if (!confirmTeacherAction(`Remove ${student.name || student.email || 'this student'} from the uploaded list?`)) return;
        if (!removeStudentForTeacher(teacherId, student)) return showNotification('Could not remove student', 'error');
        showNotification('Student removed', 'success');
        rerender();
      }
      if (actionSelect) actionSelect.value = '';
    };
  });
}

function showAdminTeacherExams(teacherId) {
  if (!isSuperAdmin()) return showNotification('Admin access required', 'error');
  const id = normalizeEmail(teacherId);
  const quizzes = getAllQuizzes();
  const submissions = getAllSubmissions();
  const teacherQuizzes = Object.values(quizzes)
    .filter(q => normalizeEmail(q.teacherId) === id)
    .sort((a,b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  let modal = document.getElementById('adminTeacherExamsModal'); if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'adminTeacherExamsModal';
  modal.className = 'student-result-modal';
  const inner = document.createElement('div');
  inner.className = 'card-beautiful admin-modal-card';
  inner.innerHTML = `
    <div class="page-heading">
      <div>
        <div class="h2">Teacher Exams</div>
        <div class="small">${escapeHtml(id)}</div>
      </div>
      <button id="closeAdminTeacherExams" class="btn btn-ghost">Close</button>
    </div>
    <div class="table-wrap">
      <table class="table-dense">
        <thead><tr><th>Exam / Institution</th><th>Quiz</th><th>ID</th><th>Subjects</th><th>Submissions</th><th>Schedule</th><th>Actions</th></tr></thead>
        <tbody>
          ${teacherQuizzes.map(q => {
            const count = submissions.filter(s => s.quizId === q.id).length;
            return `<tr>
              <td>${escapeHtml(q.examName || '-')}</td>
              <td>${escapeHtml(q.title || 'Untitled Quiz')}</td>
              <td>${escapeHtml(q.id)}</td>
              <td>${(q.subjects || []).length}</td>
              <td>${count}</td>
              <td>${q.scheduleStart ? new Date(q.scheduleStart).toLocaleString() : 'Any time'}${q.scheduleEnd ? ' - ' + new Date(q.scheduleEnd).toLocaleString() : ''}</td>
              <td>
                <button class="btn btn-ghost btn-sm adminResultsQuiz" data-id="${escapeHtml(q.id)}">Results</button>
                <button class="btn btn-ghost btn-sm adminContentQuiz" data-id="${escapeHtml(q.id)}">Content</button>
                <button class="btn btn-ghost btn-sm adminCopyQuizLink" data-id="${escapeHtml(q.id)}">Copy Link</button>
                <button class="btn btn-ghost btn-sm adminShareQuizLink" data-id="${escapeHtml(q.id)}">Share</button>
              </td>
            </tr>`;
          }).join('') || '<tr><td colspan="7">This teacher has not created any exams yet.</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
  modal.appendChild(inner);
  document.body.appendChild(modal);
  modal.onclick = (ev) => { if (ev.target === modal) modal.remove(); };
  document.getElementById('closeAdminTeacherExams').onclick = () => modal.remove();
  document.querySelectorAll('.adminResultsQuiz').forEach(btn => btn.onclick = (ev) => {
    state.currentQuiz = getAllQuizzes()[ev.currentTarget.dataset.id];
    state.view = 'teacher.results';
    modal.remove();
    render();
  });
  document.querySelectorAll('.adminContentQuiz').forEach(btn => btn.onclick = (ev) => showQuizSetDetails(ev.currentTarget.dataset.id));
  document.querySelectorAll('.adminCopyQuizLink').forEach(btn => btn.onclick = async (ev) => {
    const q = getAllQuizzes()[ev.currentTarget.dataset.id];
    await copyQuizAccessLink(q);
  });
  document.querySelectorAll('.adminShareQuizLink').forEach(btn => btn.onclick = async (ev) => {
    const q = getAllQuizzes()[ev.currentTarget.dataset.id];
    await shareQuizAccessLink(q);
  });
}

function showAdminTeacherStudents(teacherId) {
  if (!isSuperAdmin()) return showNotification('Admin access required', 'error');
  const id = normalizeEmail(teacherId);
  let modal = document.getElementById('adminTeacherStudentsModal'); if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'adminTeacherStudentsModal';
  modal.className = 'student-result-modal';
  const inner = document.createElement('div');
  inner.className = 'card-beautiful admin-modal-card';
  inner.innerHTML = `
    <div class="page-heading">
      <div>
        <div class="h2">Teacher Students</div>
        <div class="small">${escapeHtml(id)}</div>
      </div>
      <button id="closeAdminTeacherStudents" class="btn btn-ghost">Close</button>
    </div>
    <div id="adminTeacherStudentsHost"></div>
  `;
  modal.appendChild(inner);
  document.body.appendChild(modal);
  modal.onclick = (ev) => { if (ev.target === modal) modal.remove(); };
  document.getElementById('closeAdminTeacherStudents').onclick = () => modal.remove();
  renderStudentClassManager(document.getElementById('adminTeacherStudentsHost'), id, {
    scope: 'admin',
    includeImport: false,
    includeExport: true,
    includeTemplate: false,
    readOnly: true
  });
}

// ============================================================================
// EXAM / QUIZ TAKE - redesigned layout + palette logic
// ============================================================================

function renderQuizWelcome(quiz, questions) {
  const wrapper = document.createElement('div');
  wrapper.className = 'exam-shell quiz-welcome-shell';
  const totalMinutes = parseInt(quiz.timeLimit || 0, 10) || 0;
  const calculatorType = getQuizCalculatorType(quiz);
  const subjectSummaries = getQuizSubjectSummaries(quiz);
  const subjectBreakdownMarkup = subjectSummaries.length > 1
    ? `
      <div class="card" style="margin-top:16px;padding:16px;border:1px solid #DBEAFE;box-shadow:none;text-align:left">
        <div class="h3" style="margin-bottom:6px">Subject Breakdown</div>
        <div class="small" style="margin-bottom:10px">This quiz has ${subjectSummaries.length} subjects. Review each subject and question count below before you start.</div>
        <div style="display:grid;gap:8px">
          ${subjectSummaries.map((item) => `
            <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:10px 12px;border-radius:12px;background:#F8FAFC;border:1px solid #E2E8F0">
              <strong>${escapeHtml(item.name)}</strong>
              <span>${item.questionCount} question(s)</span>
            </div>
          `).join('')}
        </div>
      </div>
    `
    : '';
  wrapper.innerHTML = `
    <div class="card-beautiful quiz-welcome-card">
      <div class="small">OPE Assessor</div>
      <h1 class="display-font">${escapeHtml(quiz.title || 'Quiz')}</h1>
      <p class="text-muted">Read this before you begin. Your answers are saved in this browser and submitted when you finish.</p>
      <div class="quiz-welcome-grid">
        <div><strong>${questions.length}</strong><span>Questions</span></div>
        <div><strong>${(quiz.subjects || []).length || 1}</strong><span>Subject(s)</span></div>
        <div><strong>${totalMinutes || 'No limit'}</strong><span>${totalMinutes ? 'Minutes' : 'Timer'}</span></div>
      </div>
      ${subjectBreakdownMarkup}
      <div class="quiz-instructions">
        <p><strong>Before you start:</strong> you may still leave this screen without penalty.</p>
        <p><strong>After Start Quiz:</strong> leaving the exam tab, exiting fullscreen, refreshing, closing the page, or using copy/screenshot shortcuts may be recorded and can submit the quiz automatically.</p>
        <p><strong>Full screen:</strong> stay in full screen until you submit. Escaping full screen or minimizing the browser can lead to automatic submission.</p>
        ${calculatorType !== 'none' ? `<p><strong>Calculator:</strong> this quiz allows a ${escapeHtml(calculatorType)} calculator from the Calc button during the test.</p>` : ''}
        ${quiz.webcamRequired ? '<p><strong>Camera requirement:</strong> this quiz needs camera monitoring. The camera window can be moved during the test.</p>' : ''}
        <p><strong>Correction PDF:</strong> if you later request a correction, you will enter the WhatsApp number for delivery at the end of the quiz. Your email or registration details from the start screen are already saved.</p>
        <p><strong>Guide:</strong> if you need a quick explanation of the student steps, open the Student Guide from the previous screen before starting.</p>
        <p><strong>Desktop keys:</strong> A/B/C/D choose options, N moves next, P moves previous, and S submits.</p>
        <p>Click Start Quiz only when you are ready to begin.</p>
      </div>
      <div class="student-buttons">
        <button id="beginQuizBtn" class="btn-main">Start Quiz</button>
        <button id="leaveQuizBtn" class="btn-secondary">Back</button>
      </div>
    </div>
  `;
  setTimeout(() => {
    document.getElementById('beginQuizBtn').onclick = async () => {
      state.currentSubmission.examStarted = true;
      state.currentSubmission.startedAt = new Date().toISOString();
      try { if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen(); state.inFullscreen = true; } catch(e){}
      const webcamOn = !!state.currentSubmission.webcamRequested;
      if (webcamOn) startWebcam();
      render();
    };
    document.getElementById('leaveQuizBtn').onclick = () => {
      const calculator = document.getElementById('examCalculatorPanel'); if (calculator) calculator.remove();
      state.currentSubmission = null;
      state.currentQuiz = null;
      state.view = 'student';
      render();
    };
  }, 0);
  return wrapper;
}

function formatCalculatorValue(value) {
  if (value == null || value === '') return '0';
  const num = Number(value);
  if (!Number.isFinite(num)) return 'Error';
  if (Math.abs(num) >= 1e9 || (Math.abs(num) > 0 && Math.abs(num) < 1e-6)) return num.toExponential(6).replace(/\.?0+e/, 'e');
  return Number.isInteger(num) ? String(num) : num.toFixed(8).replace(/\.?0+$/, '');
}

function sanitizeCalculatorExpression(expression) {
  return (expression || '')
    .replace(/÷/g, '/')
    .replace(/×/g, '*')
    .replace(/π/g, 'pi')
    .replace(/\^/g, '**')
    .replace(/(\d+(?:\.\d+)?)%/g, '($1/100)')
    .replace(/\)%/g, ')/100');
}

function evaluateCalculatorExpression(expression) {
  const sanitized = sanitizeCalculatorExpression(expression);
  const degreeFactor = _calculatorMode === 'DEG' ? Math.PI / 180 : _calculatorMode === 'GRAD' ? Math.PI / 200 : 1;
  const helpers = {
    pi: Math.PI,
    e: Math.E,
    sqrt: (x) => Math.sqrt(x),
    cbrt: (x) => Math.cbrt(x),
    log: (x) => Math.log10(x),
    ln: (x) => Math.log(x),
    exp10: (x) => Math.pow(10, x),
    expE: (x) => Math.exp(x),
    inv: (x) => 1 / x,
    sqr: (x) => Math.pow(x, 2),
    cube: (x) => Math.pow(x, 3),
    sin: (x) => Math.sin(x * degreeFactor),
    cos: (x) => Math.cos(x * degreeFactor),
    tan: (x) => Math.tan(x * degreeFactor),
    asin: (x) => (_calculatorMode === 'DEG' ? Math.asin(x) * (180 / Math.PI) : _calculatorMode === 'GRAD' ? Math.asin(x) * (200 / Math.PI) : Math.asin(x)),
    acos: (x) => (_calculatorMode === 'DEG' ? Math.acos(x) * (180 / Math.PI) : _calculatorMode === 'GRAD' ? Math.acos(x) * (200 / Math.PI) : Math.acos(x)),
    atan: (x) => (_calculatorMode === 'DEG' ? Math.atan(x) * (180 / Math.PI) : _calculatorMode === 'GRAD' ? Math.atan(x) * (200 / Math.PI) : Math.atan(x)),
    fact: (n) => {
      const value = Math.floor(Number(n));
      if (!Number.isFinite(value) || value < 0) throw new Error('Invalid factorial');
      let out = 1;
      for (let i = 2; i <= value; i++) out *= i;
      return out;
    },
    nPr: (n, r) => {
      const nn = Math.floor(Number(n));
      const rr = Math.floor(Number(r));
      if (rr > nn || rr < 0) throw new Error('Invalid permutation');
      let out = 1;
      for (let i = 0; i < rr; i++) out *= (nn - i);
      return out;
    },
    nCr: (n, r) => {
      const nn = Math.floor(Number(n));
      const rr = Math.floor(Number(r));
      if (rr > nn || rr < 0) throw new Error('Invalid combination');
      return helpers.nPr(nn, rr) / helpers.fact(rr);
    },
    frac: (a, b, c) => (typeof c === 'undefined' ? Number(a) / Number(b) : Number(a) + (Number(b) / Number(c)))
  };
  try {
    const evaluator = new Function('helpers', `with (helpers) { return (${sanitized || '0'}); }`);
    const result = evaluator(helpers);
    if (!Number.isFinite(result)) throw new Error('Invalid result');
    return result;
  } catch (error) {
    throw new Error('Invalid calculation');
  }
}

function getCalculatorButtonLayout(calculatorType = getQuizCalculatorType(state.currentQuiz)) {
  if (calculatorType === 'basic') {
    return [
      [{ label: 'MC', action: 'mc' }, { label: 'MR', action: 'mr' }, { label: 'M+', action: 'mplus' }, { label: 'M-', action: 'mminus' }, { label: 'AC', action: 'clear' }],
      [{ label: 'C', action: 'backspace' }, { label: '(', value: '(' }, { label: ')', value: ')' }, { label: 'a b/c', value: 'frac(' }, { label: '%', value: '%' }],
      [{ label: '7', value: '7' }, { label: '8', value: '8' }, { label: '9', value: '9' }, { label: '÷', value: '÷' }, { label: '√', value: 'sqrt(' }],
      [{ label: '4', value: '4' }, { label: '5', value: '5' }, { label: '6', value: '6' }, { label: '×', value: '×' }, { label: 'x²', value: '^2' }],
      [{ label: '1', value: '1' }, { label: '2', value: '2' }, { label: '3', value: '3' }, { label: '-', value: '-' }, { label: '1/x', value: 'inv(' }],
      [{ label: '+/-', action: 'sign' }, { label: '0', value: '0' }, { label: '.', value: '.' }, { label: '+', value: '+' }, { label: '=', action: 'equals' }]
    ];
  }
  return [
    [{ label: _calculatorMode, action: 'mode' }, { label: 'MC', action: 'mc' }, { label: 'MR', action: 'mr' }, { label: 'M+', action: 'mplus' }, { label: 'M-', action: 'mminus' }],
    [{ label: 'AC', action: 'clear' }, { label: 'C', action: 'backspace' }, { label: '(', value: '(' }, { label: ')', value: ')' }, { label: 'a b/c', value: 'frac(' }],
    [{ label: 'sin', value: 'sin(' }, { label: 'cos', value: 'cos(' }, { label: 'tan', value: 'tan(' }, { label: 'log', value: 'log(' }, { label: 'ln', value: 'ln(' }],
    [{ label: '7', value: '7' }, { label: '8', value: '8' }, { label: '9', value: '9' }, { label: '÷', value: '÷' }, { label: '√', value: 'sqrt(' }],
    [{ label: '4', value: '4' }, { label: '5', value: '5' }, { label: '6', value: '6' }, { label: '×', value: '×' }, { label: 'x²', value: '^2' }],
    [{ label: '1', value: '1' }, { label: '2', value: '2' }, { label: '3', value: '3' }, { label: '-', value: '-' }, { label: '1/x', value: 'inv(' }],
    [{ label: '+/-', action: 'sign' }, { label: '0', value: '0' }, { label: '.', value: '.' }, { label: '+', value: '+' }, { label: '%', value: '%' }],
    [{ label: 'π', value: 'π' }, { label: 'x^y', value: '^' }, { label: 'n!', value: 'fact(' }, { label: 'nPr', value: 'nPr(' }, { label: 'nCr', value: 'nCr(' }],
    [{ label: 'x³', value: 'cube(' }, { label: '³√x', value: 'cbrt(' }, { label: 'sin⁻¹', value: 'asin(' }, { label: 'cos⁻¹', value: 'acos(' }, { label: 'tan⁻¹', value: 'atan(' }],
    [{ label: '10^x', value: 'exp10(' }, { label: 'e^x', value: 'expE(' }, { label: '=', action: 'equals', wide: true }]
  ];
}

function updateCalculatorExpression(nextExpression) {
  _calculatorExpression = nextExpression;
  renderExamCalculatorWidget(true);
}

function handleCalculatorAction(action, value) {
  if (value) {
    updateCalculatorExpression(`${_calculatorExpression}${value}`);
    return;
  }
  if (action === 'clear') {
    updateCalculatorExpression('');
  } else if (action === 'backspace') {
    updateCalculatorExpression(_calculatorExpression.slice(0, -1));
  } else if (action === 'mode') {
    _calculatorMode = _calculatorMode === 'DEG' ? 'RAD' : _calculatorMode === 'RAD' ? 'GRAD' : 'DEG';
    renderExamCalculatorWidget(true);
  } else if (action === 'mc') {
    _calculatorMemory = 0;
    showNotification('Calculator memory cleared', 'info');
  } else if (action === 'mr') {
    updateCalculatorExpression(`${_calculatorExpression}${formatCalculatorValue(_calculatorMemory)}`);
  } else if (action === 'mplus') {
    try {
      _calculatorMemory += Number(evaluateCalculatorExpression(_calculatorExpression || '0'));
      showNotification('Added to calculator memory', 'success');
    } catch (error) {
      showNotification('Nothing valid to add to memory', 'error');
    }
  } else if (action === 'mminus') {
    try {
      _calculatorMemory -= Number(evaluateCalculatorExpression(_calculatorExpression || '0'));
      showNotification('Subtracted from calculator memory', 'success');
    } catch (error) {
      showNotification('Nothing valid to subtract from memory', 'error');
    }
  } else if (action === 'sign') {
    const expr = (_calculatorExpression || '').trim();
    if (!expr) return updateCalculatorExpression('-');
    updateCalculatorExpression(expr.startsWith('-') ? expr.slice(1) : `-(${expr})`);
  } else if (action === 'equals') {
    try {
      updateCalculatorExpression(formatCalculatorValue(evaluateCalculatorExpression(_calculatorExpression || '0')));
    } catch (error) {
      showNotification(error.message || 'Invalid calculation', 'error');
    }
  }
}

function renderExamCalculatorWidget(open = false) {
  const calculatorType = getQuizCalculatorType(state.currentQuiz);
  if (calculatorType === 'none') {
    const existingPanel = document.getElementById('examCalculatorPanel');
    if (existingPanel) existingPanel.style.display = 'none';
    if (open) showNotification('Calculator is not enabled for this quiz', 'error');
    return;
  }
  let panel = document.getElementById('examCalculatorPanel');
  if (!panel && !open) return;
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'examCalculatorPanel';
    panel.className = 'card-beautiful exam-calculator-panel';
    Object.assign(panel.style, {
      position: 'fixed',
      left: '16px',
      top: '96px',
      width: 'min(360px, calc(100vw - 24px))',
      zIndex: '12000',
      display: 'none',
      padding: '12px'
    });
    document.body.appendChild(panel);
  }
  panel.innerHTML = `
    <div class="exam-calculator-header" style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px">
      <div class="webcam-drag-handle" style="font-weight:800;color:#0F172A;user-select:none">${calculatorType === 'scientific' ? 'Scientific Calculator' : 'Basic Calculator'}</div>
      <button type="button" id="closeExamCalculator" class="btn btn-ghost btn-sm">Close</button>
    </div>
    <div class="exam-calculator-screen" style="border:1px solid #CBD5E1;border-radius:14px;padding:12px 14px;background:#0F172A;color:#F8FAFC;margin-bottom:12px">
      <div style="font-size:12px;letter-spacing:.08em;color:#CBD5E1">${calculatorType === 'scientific' ? `${_calculatorMode} • ` : ''}MEM ${formatCalculatorValue(_calculatorMemory)}</div>
      <div style="font-size:24px;font-weight:800;line-height:1.25;word-break:break-all;min-height:32px">${escapeHtml(_calculatorExpression || '0')}</div>
    </div>
    <div class="exam-calculator-grid" style="display:grid;gap:8px">
      ${getCalculatorButtonLayout(calculatorType).map((row) => `
        <div style="display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px">
          ${row.map((button) => `
            <button
              type="button"
              class="btn-secondary exam-calculator-btn"
              data-action="${button.action || ''}"
              data-value="${button.value || ''}"
              style="${button.wide ? 'grid-column:span 3;' : ''};padding:10px 8px;min-height:42px;font-size:13px;font-weight:800"
            >${button.label}</button>
          `).join('')}
        </div>
      `).join('')}
    </div>
  `;
  panel.style.display = open ? 'block' : panel.style.display;
  makeFloatingPanelDraggable(panel, panel.querySelector('.webcam-drag-handle'));
  document.getElementById('closeExamCalculator').onclick = () => {
    panel.style.display = 'none';
  };
  panel.querySelectorAll('.exam-calculator-btn').forEach((button) => {
    button.onclick = () => handleCalculatorAction(button.dataset.action || '', button.dataset.value || '');
  });
}

function renderQuizTake() {
  const q = state.currentQuiz;
  if (!q) return document.createElement('div');
  const calculatorType = getQuizCalculatorType(q);
  if (calculatorType === 'none') {
    const calculatorPanel = document.getElementById('examCalculatorPanel');
    if (calculatorPanel) calculatorPanel.style.display = 'none';
  }
  const preparedQuestions = getQuizQuestionsForTaking(q);
  if (!preparedQuestions.length) {
    const empty = document.createElement('div');
    empty.className = 'exam-shell';
    empty.innerHTML = `
      <div class="card-beautiful quiz-welcome-card">
        <h2>This quiz has no questions yet</h2>
        <p class="text-muted">Ask your teacher to upload or paste questions, then save the quiz again.</p>
        <button id="backToStudentEntry" class="btn-secondary">Back</button>
      </div>
    `;
    setTimeout(() => {
      document.getElementById('backToStudentEntry').onclick = () => { state.view = 'student'; state.currentQuiz = null; state.currentSubmission = null; render(); };
    }, 0);
    return empty;
  }
  if (!state.currentSubmission) {
    state.currentSubmission = { quizId: q.id, answers: {}, flagged: {}, allQuestions: preparedQuestions, currentIndex: 0, startedAt: '', snapshots: [] };
  }
  if (!state.currentSubmission.allQuestions || !state.currentSubmission.allQuestions.length) {
    state.currentSubmission.allQuestions = preparedQuestions;
  }
  if (!state.currentSubmission.examStarted) return renderQuizWelcome(q, state.currentSubmission.allQuestions);
  const initialSections = buildQuestionSubjectSections(state.currentSubmission.allQuestions || preparedQuestions);
  // disable text selection while in exam
  try{ document.body.classList.add('exam-no-select'); }catch(e){}

  // Main wrapper
  const wrapper = document.createElement('div');
  wrapper.className = 'exam-shell';
  wrapper.innerHTML = `
    <div class="exam-header card exam-topbar" style="margin-bottom:var(--space-3);">
      <div class="exam-meta">
        <div>
          <div class="h2 exam-title">${escapeHtml(q.title)}</div>
          <div class="small" id="examInstitutionLine">${escapeHtml(q.examName || '')}${initialSections.length ? ` • ${initialSections.length} subject(s)` : ''}</div>
          <div class="small" id="examSubjectMeta" style="margin-top:4px"></div>
        </div>
      </div>
      <div class="exam-status" style="display:flex;align-items:center;gap:12px">
        <div class="small" id="examAnswered">0 answered</div>
        <div class="small" id="examPercent">0.0%</div>
        <div class="timer" id="examTimer">--:--</div>
        ${calculatorType !== 'none' ? '<button id="openExamCalculator" class="btn btn-ghost btn-sm" type="button">Calc</button>' : ''}
      </div>
    </div>
    <div class="exam-progress"><span id="examProgress"></span></div>
    ${initialSections.length > 1 ? '<div id="examSubjectTabs" style="display:flex;gap:10px;flex-wrap:wrap;margin:14px 0 18px"></div>' : ''}

    <div class="exam-layout" style="display:flex;gap:var(--space-3);align-items:flex-start">
      <div class="exam-main" style="flex:1;min-width:320px">
        <div id="questionArea"></div>
      </div>
      <div id="rightPalette" class="palette exam-palette hidden md:block"></div>
    </div>

    <div class="exam-bottom-nav">
      <button id="examPrev" class="exam-nav-btn previous">Previous</button>
      <button id="submitExam" class="exam-nav-btn submit">Submit</button>
      <button id="examNext" class="exam-nav-btn next">Next</button>
    </div>

    <button class="fab-palette md:hidden" id="openPaletteFab" title="Open question palette">Q</button>
    <div id="paletteDrawer" class="card" style="position:fixed;right:12px;bottom:210px;width:260px;display:none;z-index:160"></div>
  `;

  setTimeout(()=> {
    // Prepare submission state if not yet created (existing logic)
    if (!state.currentSubmission || state.currentSubmission.quizId !== q.id) {
      // reuse existing 'proceedToQuiz' logic but simpler: flatten questions
      const allQuestions = preparedQuestions;
      state.currentSubmission = {
        quizId: q.id,
        name: state.currentSubmission?.name || '',
        email: state.currentSubmission?.email || '',
        answers: {},
        flagged: {},
        allQuestions,
        currentIndex: 0,
        examStarted: true,
        startedAt: new Date().toISOString()
      };
    }

    const qa = document.getElementById('questionArea');
    const sub = state.currentSubmission;
    const subjectSections = buildQuestionSubjectSections(sub.allQuestions || []);
    if (!subjectSections.length) {
      qa.innerHTML = '<div class="question-card"><div class="h3">No question found</div><p class="text-muted">Please go back and ask the teacher to check the quiz questions.</p></div>';
      return;
    }
    if (!sub.allQuestions[sub.currentIndex]) sub.currentIndex = subjectSections[0].firstIndex;
    if (!Number.isInteger(sub.currentSubjectIndex) || !subjectSections[sub.currentSubjectIndex]) {
      sub.currentSubjectIndex = getSubjectSectionIndexForQuestion(subjectSections, sub.currentIndex);
    }

    const getCurrentSection = () => subjectSections[sub.currentSubjectIndex] || subjectSections[0];
    const syncSubjectIndexToCurrentQuestion = () => {
      sub.currentSubjectIndex = getSubjectSectionIndexForQuestion(subjectSections, sub.currentIndex);
    };
    const renderSubjectTabs = () => {
      const host = document.getElementById('examSubjectTabs');
      if (!host) return;
      host.innerHTML = subjectSections.map((section, index) => {
        const answeredCount = countAnsweredQuestionsInSection(section, sub.answers || {});
        const isActive = index === sub.currentSubjectIndex;
        return `
          <button
            type="button"
            class="btn ${isActive ? 'btn-primary' : 'btn-ghost'} btn-sm"
            data-subject-tab="${index}"
            style="justify-content:flex-start;text-align:left;border-radius:999px;padding:10px 14px"
          >
            ${escapeHtml(section.name)} (${answeredCount}/${section.total})
          </button>
        `;
      }).join('');
      host.querySelectorAll('[data-subject-tab]').forEach((button) => {
        button.onclick = () => {
          const nextSectionIndex = parseInt(button.dataset.subjectTab || '0', 10) || 0;
          const nextSection = subjectSections[nextSectionIndex];
          if (!nextSection) return;
          sub.currentSubjectIndex = nextSectionIndex;
          sub.currentIndex = nextSection.firstIndex;
          saveExamDraft(sub);
          if (q.verticalLayout) {
            renderVerticalSubjectView();
          } else {
            renderQuestion(sub.currentIndex);
          }
          renderQuestionPalette();
          updateExamChrome();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        };
      });
    };
    const updateExamChrome = () => {
      const total = (sub.allQuestions || []).length || 1;
      const answered = Object.keys(sub.answers || {}).filter(k => sub.answers[k]).length;
      const percent = Math.round((answered / total) * 1000) / 10;
      const progress = document.getElementById('examProgress'); if (progress) progress.style.width = percent + '%';
      const pct = document.getElementById('examPercent'); if (pct) pct.textContent = percent.toFixed(1) + '%';
      const ans = document.getElementById('examAnswered'); if (ans) ans.textContent = `${answered}/${total} answered`;
      const position = getQuestionPositionWithinSubject(subjectSections, sub.currentIndex);
      const currentSection = subjectSections[position.sectionIndex] || getCurrentSection();
      const subjectMeta = document.getElementById('examSubjectMeta');
      if (subjectMeta) {
        subjectMeta.textContent = `${currentSection.name} • Question ${position.localNumber} of ${position.totalInSubject} • ${countAnsweredQuestionsInSection(currentSection, sub.answers || {})}/${currentSection.total} answered in this subject`;
      }
      renderSubjectTabs();
    };
    const moveQuestion = (step) => {
      const position = getQuestionPositionWithinSubject(subjectSections, sub.currentIndex);
      const section = position.section;
      const nextLocalIndex = position.localIndex + step;
      if (nextLocalIndex >= 0 && nextLocalIndex < section.indices.length) {
        sub.currentIndex = section.indices[nextLocalIndex];
      } else if (step > 0 && subjectSections[position.sectionIndex + 1]) {
        sub.currentSubjectIndex = position.sectionIndex + 1;
        sub.currentIndex = subjectSections[sub.currentSubjectIndex].firstIndex;
      } else if (step < 0 && subjectSections[position.sectionIndex - 1]) {
        sub.currentSubjectIndex = position.sectionIndex - 1;
        sub.currentIndex = subjectSections[sub.currentSubjectIndex].lastIndex;
      } else {
        return false;
      }
      syncSubjectIndexToCurrentQuestion();
      saveExamDraft(sub);
      return true;
    };
    const renderQuestionPalette = () => {
      const pal = document.getElementById('rightPalette');
      const drawer = document.getElementById('paletteDrawer');
      const currentSection = getCurrentSection();
      const items = currentSection.indices.map((globalIndex, localIndex) => {
        const answered = !!sub.answers[globalIndex];
        const flagged = !!sub.flagged[globalIndex];
        const classes = ['palette-item'];
        if (answered) classes.push('palette-answered');
        if (flagged) classes.push('palette-flagged');
        if (globalIndex === sub.currentIndex) classes.push('palette-current');
        return `<div class="${classes.join(' ')}" data-index="${globalIndex}">${localIndex + 1}</div>`;
      });
      const heading = `Question Palette • ${escapeHtml(currentSection.name)}`;
      pal.innerHTML = `<div class="small" style="margin-bottom:8px">${heading}</div><div class="palette-grid">${items.join('')}</div>`;
      drawer.innerHTML = `<div class="small" style="margin-bottom:8px">${heading}</div><div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px">${items.join('')}</div>`;
      [pal, drawer].forEach((scope) => scope.querySelectorAll('.palette-item').forEach((el) => {
        el.onclick = (ev) => {
          const idx = parseInt(ev.currentTarget.dataset.index, 10);
          sub.currentIndex = idx;
          syncSubjectIndexToCurrentQuestion();
          saveExamDraft(sub);
          if (q.verticalLayout) {
            const card = document.getElementById(`questionCard-${idx}`);
            if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } else {
            renderQuestion(idx);
          }
          renderQuestionPalette();
          updateExamChrome();
          document.getElementById('paletteDrawer').style.display = 'none';
        };
      }));
    };
    if (q.verticalLayout) {
      function renderVerticalSubjectView() {
        const currentSection = getCurrentSection();
        qa.innerHTML = `
          <div class="card-beautiful" style="margin-bottom:14px;padding:14px 16px">
            <div class="small">Current subject</div>
            <div class="h3" style="margin-top:6px">${escapeHtml(currentSection.name)}</div>
            <div class="small" style="margin-top:4px">${currentSection.total} question(s) assigned in this subject</div>
          </div>
          ${currentSection.indices.map((globalIndex, localIndex) => {
            const qq = sub.allQuestions[globalIndex];
            const qType = normalizeQuestionType(qq.type);
            let widget = '';
            if (qType === 'mcq') {
              widget = (qq.options || []).map((opt, optionIndex) => {
                const letter = String.fromCharCode(65 + optionIndex);
                const checked = sub.answers[globalIndex] === letter ? 'checked' : '';
                return `<label style="display:block;padding:10px;border-radius:8px;border:1px solid var(--border);margin-top:8px"><input type="radio" name="opt-${globalIndex}" data-idx="${globalIndex}" value="${letter}" ${checked} /><div class="preserve-format rich-text-output" style="margin-left:28px">${letter}. ${renderRichTextHtml(opt)}</div></label>`;
              }).join('');
            } else if (qType === 'yesno') {
              const stored = (sub.answers[globalIndex] || '').toString();
              widget = ['Yes', 'No'].map((label) => {
                const checked = stored === label ? 'checked' : '';
                return `<label style="display:block;padding:10px;border-radius:8px;border:1px solid var(--border);margin-top:8px"><input type="radio" name="opt-${globalIndex}" data-idx="${globalIndex}" value="${label}" ${checked} /><span style="margin-left:28px">${label}</span></label>`;
              }).join('');
            } else if (qType === 'short') {
              const stored = escapeHtml((sub.answers[globalIndex] || '').toString());
              widget = `<input id="shortAns-${globalIndex}" data-idx="${globalIndex}" class="input-beautiful exam-short-input" type="text" value="${stored}" placeholder="Type your answer here" autocomplete="off" />`;
            } else if (qType === 'essay') {
              const stored = escapeHtml((sub.answers[globalIndex] || '').toString());
              widget = `<textarea id="essayAns-${globalIndex}" data-idx="${globalIndex}" class="input-beautiful exam-essay-input" rows="8" placeholder="Write your answer here. Your teacher will mark this manually.">${stored}</textarea>`;
            }
            return `
              <div class="question-card" id="questionCard-${globalIndex}" data-question-card="${globalIndex}" data-question-type="${qType}" style="margin-bottom:12px">
                <div class="small" style="color:#0F766E;font-weight:700">${escapeHtml(currentSection.name)}</div>
                <div class="h3">Question ${localIndex + 1} of ${currentSection.total}</div>
                ${renderQuestionMediaAssets(qq, 'before')}
                <div style="margin-top:8px" class="body preserve-format rich-text-output">${renderRichTextHtml(qq.question)}</div>
                ${renderQuestionMediaAssets(qq, 'after')}
                <div class="options" id="optionsList-${globalIndex}">${widget}</div>
              </div>
            `;
          }).join('')}
        `;
        currentSection.indices.forEach((globalIndex) => {
          const qType = normalizeQuestionType(sub.allQuestions[globalIndex].type);
          if (qType === 'mcq' || qType === 'yesno') {
            document.querySelectorAll(`input[name="opt-${globalIndex}"]`).forEach((input) => {
              input.onclick = (event) => {
                if (sub.answers[globalIndex] === input.value) {
                  event.preventDefault();
                  event.stopPropagation();
                  input.checked = false;
                  delete sub.answers[globalIndex];
                  saveExamDraft(sub);
                  renderQuestionPalette();
                  updateExamChrome();
                  renderVerticalSubjectView();
                }
              };
              input.onchange = (event) => {
                sub.currentIndex = globalIndex;
                sub.currentSubjectIndex = getSubjectSectionIndexForQuestion(subjectSections, globalIndex);
                sub.answers[globalIndex] = event.target.value;
                saveExamDraft(sub);
                renderQuestionPalette();
                updateExamChrome();
              };
            });
          } else if (qType === 'short' || qType === 'essay') {
            const input = document.getElementById(qType === 'short' ? `shortAns-${globalIndex}` : `essayAns-${globalIndex}`);
            if (input) {
              const persist = () => {
                const v = (input.value || '').toString();
                if (v.trim()) sub.answers[globalIndex] = v;
                else delete sub.answers[globalIndex];
                saveExamDraft(sub);
                renderQuestionPalette();
                updateExamChrome();
              };
              input.oninput = persist;
              input.onblur = persist;
            }
          }
        });
        qa.querySelectorAll('[data-question-card]').forEach((card) => {
          card.onclick = () => {
            const idx = parseInt(card.dataset.questionCard || '0', 10) || 0;
            sub.currentIndex = idx;
            syncSubjectIndexToCurrentQuestion();
            renderQuestionPalette();
            updateExamChrome();
          };
        });
        updateExamChrome();
      }
      renderVerticalSubjectView();
      renderQuestionPalette();
    } else {
      function renderQuestion(idx) {
        const qq = sub.allQuestions[idx];
        if (!qq) {
          qa.innerHTML = '<div class="question-card"><div class="h3">No question found</div><p class="text-muted">Please go back and ask the teacher to check the quiz questions.</p></div>';
          return;
        }
        syncSubjectIndexToCurrentQuestion();
        const position = getQuestionPositionWithinSubject(subjectSections, idx);
        const currentSection = subjectSections[position.sectionIndex] || getCurrentSection();
        const qType = normalizeQuestionType(qq.type);
        let answerWidget = '';
        if (qType === 'mcq') {
          answerWidget = (qq.options || []).map((opt, i) => {
            const letter = String.fromCharCode(65 + i);
            const checked = sub.answers[idx] === letter ? 'checked' : '';
            return `<label style="display:block;padding:10px;border-radius:8px;border:1px solid var(--border);margin-top:8px"><input type="radio" name="opt-${idx}" data-idx="${idx}" value="${letter}" ${checked} /><div class="preserve-format rich-text-output" style="margin-left:28px">${letter}. ${renderRichTextHtml(opt)}</div></label>`;
          }).join('');
        } else if (qType === 'yesno') {
          const stored = (sub.answers[idx] || '').toString();
          ['Yes', 'No'].forEach(() => {});
          answerWidget = ['Yes', 'No'].map((label) => {
            const checked = stored === label ? 'checked' : '';
            return `<label style="display:block;padding:10px;border-radius:8px;border:1px solid var(--border);margin-top:8px"><input type="radio" name="opt-${idx}" data-idx="${idx}" value="${label}" ${checked} /><span style="margin-left:28px">${label}</span></label>`;
          }).join('');
        } else if (qType === 'short') {
          const stored = escapeHtml((sub.answers[idx] || '').toString());
          answerWidget = `<input id="shortAns-${idx}" data-idx="${idx}" class="input-beautiful exam-short-input" type="text" value="${stored}" placeholder="Type your answer here" autocomplete="off" />`;
        } else if (qType === 'essay') {
          const stored = escapeHtml((sub.answers[idx] || '').toString());
          answerWidget = `<textarea id="essayAns-${idx}" data-idx="${idx}" class="input-beautiful exam-essay-input" rows="8" placeholder="Write your answer here. Your teacher will mark this manually.">${stored}</textarea>`;
        }

        qa.innerHTML = `
          <div class="question-card" style="margin-bottom:12px">
            <div class="small" style="color:#0F766E;font-weight:700">${escapeHtml(currentSection.name)}</div>
            <div class="h3">Question ${position.localNumber} of ${position.totalInSubject}</div>
            ${renderQuestionMediaAssets(qq, 'before')}
            <div style="margin-top:8px" class="body preserve-format rich-text-output">${renderRichTextHtml(qq.question)}</div>
            ${renderQuestionMediaAssets(qq, 'after')}
            <div class="options" id="optionsList-${idx}">${answerWidget}</div>
            <div class="question-inline-actions" style="display:flex;justify-content:space-between;margin-top:12px">
              <div>
                <button id="prevQ" class="btn btn-ghost btn-sm">Prev</button>
                <button id="nextQ" class="btn btn-ghost btn-sm">Next</button>
              </div>
              <div>
                <button id="flagBtn" class="btn btn-ghost btn-sm">${sub.flagged[idx] ? 'Flagged' : 'Flag'}</button>
                <button id="saveQ" class="btn btn-primary btn-sm">Save</button>
              </div>
            </div>
          </div>
        `;

        setTimeout(() => {
          updateExamChrome();
          if (qType === 'mcq' || qType === 'yesno') {
            document.querySelectorAll(`#optionsList-${idx} input[type="radio"]`).forEach(i => {
              i.onclick = (event) => {
                if (sub.answers[idx] === i.value) {
                  event.preventDefault();
                  event.stopPropagation();
                  i.checked = false;
                  delete sub.answers[idx];
                  saveExamDraft(sub);
                  renderQuestionPalette();
                  updateExamChrome();
                  renderQuestion(idx);
                }
              };
              i.onchange = (e) => { sub.answers[idx] = e.target.value; saveExamDraft(sub); renderQuestionPalette(); updateExamChrome(); };
            });
          } else if (qType === 'short' || qType === 'essay') {
            const input = document.getElementById(qType === 'short' ? `shortAns-${idx}` : `essayAns-${idx}`);
            if (input) {
              const persist = () => {
                const v = (input.value || '').toString();
                if (v.trim()) sub.answers[idx] = v;
                else delete sub.answers[idx];
                saveExamDraft(sub);
                renderQuestionPalette();
                updateExamChrome();
              };
              input.oninput = persist;
              input.onblur = persist;
            }
          }
          const prev = document.getElementById('prevQ'); if (prev) prev.onclick = () => { if (moveQuestion(-1)) { renderQuestion(sub.currentIndex); renderQuestionPalette(); updateExamChrome(); } };
          const next = document.getElementById('nextQ'); if (next) next.onclick = () => { if (moveQuestion(1)) { renderQuestion(sub.currentIndex); renderQuestionPalette(); updateExamChrome(); } };
          const saveBtn = document.getElementById('saveQ'); if (saveBtn) saveBtn.onclick = () => { showNotification('Saved locally', 'success'); };
          const flag = document.getElementById('flagBtn'); if (flag) flag.onclick = () => { sub.flagged[idx] = !sub.flagged[idx]; saveExamDraft(sub); flag.textContent = sub.flagged[idx] ? 'Flagged' : 'Flag'; renderQuestionPalette(); };
        }, 0);
      }
      renderQuestion(sub.currentIndex);
      renderQuestionPalette();
    }

    const examPrev = document.getElementById('examPrev');
    const examNext = document.getElementById('examNext');
    const openCalc = document.getElementById('openExamCalculator');
    if (openCalc) openCalc.onclick = () => {
      renderExamCalculatorWidget(true);
      const panel = document.getElementById('examCalculatorPanel');
      if (panel) panel.style.display = 'block';
    };
    if (examPrev) examPrev.onclick = () => {
      if (q.verticalLayout) {
        window.scrollBy({ top: -window.innerHeight * 0.75, behavior: 'smooth' });
      } else {
        document.getElementById('prevQ')?.click();
      }
      updateExamChrome();
    };
    if (examNext) examNext.onclick = () => {
      if (q.verticalLayout) {
        window.scrollBy({ top: window.innerHeight * 0.75, behavior: 'smooth' });
      } else {
        document.getElementById('nextQ')?.click();
      }
      updateExamChrome();
    };
    updateExamChrome();

    // mobile FAB open
    document.getElementById('openPaletteFab').onclick = ()=>{
      const d = document.getElementById('paletteDrawer');
      d.style.display = d.style.display === 'none' ? 'block' : 'none';
    };

    // submit button
    document.getElementById('submitExam').onclick = async ()=> {
      if (examSubmissionIntent.confirmOpen || examSubmissionIntent.manualSubmitInFlight) return;
      const confirmed = await showExamSubmitConfirmModal();
      if (!confirmed) return;
      examSubmissionIntent.manualSubmitInFlight = true;
      collectAndSubmit({ manual: true });
    };

    // timer display (reuse existing timer logic when exam starts)
    const timerEl = document.getElementById('examTimer');
    // if timeRemaining already set, update display; otherwise compute from q.timeLimit
    if (!timeRemaining || state.currentSubmission.quizId !== q.id) {
      let totalMinutes = q.timeLimit || 0;
      timeRemaining = (totalMinutes || 0) * 60;
      startTime = Date.now();
    }
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(()=> {
      const elapsed = Math.floor((Date.now() - startTime)/1000);
      const remaining = timeRemaining - elapsed;
      if (remaining <= 0) { timerEl.textContent = '00:00'; clearInterval(timerInterval); autoSubmit(); return; }
      const mins = Math.floor(remaining/60), secs = remaining%60;
      timerEl.textContent = `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
    },1000);

  },0);

  return wrapper;
}

// ============================================================================
// TEACHER RESULTS
// ============================================================================

function createPdfDocument(title, bodyHtml) {
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#0B1220;background:#fff;padding:24px;line-height:1.45">
      <div style="border-bottom:2px solid #0F1724;padding-bottom:12px;margin-bottom:16px">
        <div style="font-size:12px;text-transform:uppercase;color:#07A3A3;font-weight:700">OPE Assessor</div>
        <h1 style="font-size:24px;margin:4px 0 0;color:#0F1724">${escapeHtml(title)}</h1>
      </div>
      ${bodyHtml}
    </div>
  `;
}

const DEFAULT_SERVER_HTML_PDF_TIMEOUT_MS = 8000;

function isServerPdfExportDisabledError(statusCode, message = '') {
  const status = Number(statusCode) || 0;
  const text = (message || '').toString().trim().toLowerCase();
  return status === 404 || status === 405 || status === 501 || /not[_\s-]?found|server pdf export is not available/.test(text);
}

function markServerPdfExportAvailability(isAvailable) {
  serverPdfExportUnavailable = isAvailable === false;
}

function canUseServerRoutePdfExport() {
  if (serverPdfExportUnavailable) return false;
  return canUseNetworkSync() || /^https?:$/i.test(window.location.protocol || '');
}

function canUseServerHtmlPdfExport(exportOptions = {}) {
  const serverReady = canUseServerRoutePdfExport();
  return serverReady && exportOptions && exportOptions.disableServerHtmlExport !== true;
}

async function runServerHtmlPdfExport(task, exportOptions = {}) {
  const timeoutMarker = Symbol('server-html-pdf-timeout');
  const result = await withTimeout(
    Promise.resolve().then(task),
    Math.max(1500, Number(exportOptions.serverHtmlTimeoutMs) || DEFAULT_SERVER_HTML_PDF_TIMEOUT_MS),
    timeoutMarker
  );
  if (result === timeoutMarker) {
    throw new Error('Server HTML PDF export timed out');
  }
  return result;
}

function downloadPdfFromHtml(html, filename, successMessage = 'PDF downloaded', exportOptions = {}) {
  if (canUseServerHtmlPdfExport(exportOptions)) {
    return runServerHtmlPdfExport(
      () => downloadPdfThroughServer(html, filename, successMessage, exportOptions),
      exportOptions
    )
      .catch((error) => {
        console.warn('Server PDF export failed. Falling back to browser rendering.', error);
        return downloadPdfFromHtmlClientFallback(html, filename, successMessage, exportOptions);
      });
  }
  return downloadPdfFromHtmlClientFallback(html, filename, successMessage, exportOptions);
}

function normalizePdfExportMargins(exportOptions = {}) {
  const margins = exportOptions.marginsMm && typeof exportOptions.marginsMm === 'object'
    ? exportOptions.marginsMm
    : {};
  const fallback = Number(exportOptions.marginMm);
  if (Number.isFinite(fallback)) return { top: fallback, right: fallback, bottom: fallback, left: fallback };
  return {
    top: Number(margins.top) >= 0 ? Number(margins.top) : 10,
    right: Number(margins.right) >= 0 ? Number(margins.right) : 10,
    bottom: Number(margins.bottom) >= 0 ? Number(margins.bottom) : 10,
    left: Number(margins.left) >= 0 ? Number(margins.left) : 10
  };
}

function triggerBlobDownload(blob, filename = 'ope-export.pdf') {
  if (typeof saveAs === 'function') {
    saveAs(blob, filename);
    return;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
}

async function requestServerPdfExport(html, filename, exportOptions = {}, requestOptions = {}) {
  const response = await fetch(buildApiUrl('/api/export/pdf'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      html,
      filename,
      inline: !!requestOptions.inline,
      options: {
        title: exportOptions.title || filename.replace(/\.pdf$/i, ''),
        orientation: exportOptions.orientation === 'l' || exportOptions.orientation === 'landscape' ? 'landscape' : 'portrait',
        margins: normalizePdfExportMargins(exportOptions)
      }
    })
  });
  if (!response.ok) {
    let message = 'PDF export failed';
    try {
      const payload = await response.json();
      if (payload && payload.error) message = payload.error;
    } catch (error) {}
    if (isServerPdfExportDisabledError(response.status, message)) {
      markServerPdfExportAvailability(false);
    }
    throw new Error(message);
  }
  markServerPdfExportAvailability(true);
  return response.blob();
}

function buildStudentResultPdfRoute(submission = {}) {
  const shareKey = getSubmissionShareKey(submission);
  return `/pdf/result-summary/${encodeURIComponent(shareKey)}`;
}

function buildStudentCorrectionPdfRoute(submission = {}, options = {}) {
  const shareKey = getSubmissionShareKey(submission);
  const params = new URLSearchParams();
  const subjectName = (options.subjectName || '').toString().trim();
  if (subjectName) params.set('subject', subjectName);
  return `/pdf/student-correction/${encodeURIComponent(shareKey)}${params.toString() ? `?${params.toString()}` : ''}`;
}

function buildFacilityIndexPdfRoute(quiz = {}, options = {}) {
  const params = new URLSearchParams();
  const subjectName = (options.subjectName || '').toString().trim();
  if (subjectName) params.set('subject', subjectName);
  return `/pdf/facility-index/${encodeURIComponent(quiz.id || '')}${params.toString() ? `?${params.toString()}` : ''}`;
}

function buildTeacherSummaryPdfRoute(quiz = {}, options = {}) {
  const params = new URLSearchParams();
  const format = (options.format || '').toString().trim();
  if (format) params.set('format', format);
  return `/pdf/teacher-summary/${encodeURIComponent(quiz.id || '')}${params.toString() ? `?${params.toString()}` : ''}`;
}

function getPublicAppBaseUrl() {
  const pdfBootstrap = getPdfBootstrapPayload();
  const configuredBase = (pdfBootstrap?.verificationBaseUrl || '').toString().trim();
  if (configuredBase) return new URL('/', configuredBase).toString();
  if (typeof window !== 'undefined' && window.location && window.location.href) {
    return new URL('/', window.location.href).toString();
  }
  return '/';
}

// Build a complete standalone HTML document and write it into a new window.
// Used by the correction and facility-index "PDF" buttons — instead of
// generating a PDF in this tab (which had blank-page failures) we open a
// print-ready report. Browser "Print > Save as PDF" gives a clean PDF.
function openPrintableDocumentInNewWindow(title, innerHtml) {
  if (typeof window === 'undefined') return false;
  let win = null;
  try { win = window.open('', '_blank'); } catch (e) { win = null; }
  if (!win) {
    showNotification('Pop-up blocked. Allow pop-ups for this site, then click again.', 'error', 9000);
    return false;
  }
  const safeTitle = (title || 'OPE Assessor Report').toString();
  const escapedTitle = safeTitle
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapedTitle}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    @page { size: A4 portrait; margin: 12mm 10mm; }
    html, body {
      margin: 0;
      padding: 0;
      background: #E5E7EB;
      color: #0F172A;
      font-family: "Inter","Segoe UI","Noto Sans","DejaVu Sans","Arial Unicode MS","Liberation Sans",Arial,sans-serif;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    * { box-sizing: border-box; }
    .ope-print-toolbar {
      position: sticky;
      top: 0;
      z-index: 50;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 22px;
      background: #0F172A;
      color: #ffffff;
      box-shadow: 0 2px 6px rgba(15,23,42,0.18);
    }
    .ope-print-toolbar h1 {
      margin: 0;
      font-size: 14pt;
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    .ope-print-toolbar-actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .ope-print-toolbar button {
      appearance: none;
      border: 0;
      cursor: pointer;
      padding: 9px 18px;
      border-radius: 999px;
      font-weight: 700;
      font-size: 13pt;
      font-family: inherit;
    }
    .ope-print-toolbar .primary { background: #2F80ED; color: #ffffff; }
    .ope-print-toolbar .primary:hover { background: #1D6FE0; }
    .ope-print-toolbar .ghost { background: rgba(255,255,255,0.12); color: #ffffff; }
    .ope-print-toolbar .ghost:hover { background: rgba(255,255,255,0.22); }
    .ope-print-page {
      background: #ffffff;
      width: 210mm;
      min-height: 297mm;
      margin: 16px auto 32px;
      padding: 12mm 10mm;
      box-shadow: 0 8px 24px rgba(15,23,42,0.12);
      color: #000000;
      overflow: visible;
      font-size: 16pt;
      line-height: 1.6;
      text-align: justify;
      hyphens: auto;
      -webkit-hyphens: auto;
    }
    .ope-print-page img, .ope-print-page svg, .ope-print-page canvas { max-width: 100%; height: auto; }
    .ope-print-page table { width: 100%; table-layout: fixed; border-collapse: collapse; }
    .ope-print-page th, .ope-print-page td { word-wrap: break-word; overflow-wrap: break-word; }
    .avoid-break,
    .pdf-question-card,
    .pdf-summary-card,
    .pdf-meta-card,
    .facility-question-card,
    .facility-summary-card,
    .facility-band-section,
    .facility-band-heading {
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .long-card { break-inside: auto; page-break-inside: auto; }
    @media print {
      @page { size: A4 portrait; margin: 12mm 10mm; }
      html, body { background: #ffffff !important; }
      .ope-print-toolbar { display: none !important; }
      .ope-print-page {
        width: auto;
        min-height: 0;
        margin: 0;
        padding: 0;
        box-shadow: none;
        font-size: 16pt;
      }
    }
  </style>
</head>
<body>
  <div class="ope-print-toolbar">
    <h1>${escapedTitle}</h1>
    <div class="ope-print-toolbar-actions">
      <button class="primary" type="button" onclick="window.print()">Print / Save as PDF</button>
      <button class="ghost" type="button" onclick="window.close()">Close</button>
    </div>
  </div>
  <article class="ope-print-page">${innerHtml}</article>
  <script>
    document.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        window.print();
      }
    });
  <\/script>
</body>
</html>`;
  try {
    win.document.open();
    win.document.write(html);
    win.document.close();
    return true;
  } catch (e) {
    showNotification('Could not write the report into the new tab. Please try again.', 'error', 9000);
    try { win.close(); } catch (err) {}
    return false;
  }
}

// Print-route payload helpers. The source tab writes a one-shot payload here
// (typed by route + id), and the destination tab reads + clears it on render
// so the print view is instant even without shared sync.
const PRINT_PAYLOAD_PREFIX = 'ope_print_payload_';

function writePrintPayload(type, id, data) {
  if (typeof localStorage === 'undefined' || !type || !id) return;
  try {
    const key = `${PRINT_PAYLOAD_PREFIX}${type}_${id}`;
    localStorage.setItem(key, JSON.stringify({ ...(data || {}), savedAt: Date.now() }));
  } catch (e) { /* quota or serialization error — fall back to lookup */ }
}

function readPrintPayload(type, id) {
  if (typeof localStorage === 'undefined' || !type || !id) return null;
  const key = `${PRINT_PAYLOAD_PREFIX}${type}_${id}`;
  let payload = null;
  try {
    const raw = localStorage.getItem(key);
    if (raw) payload = JSON.parse(raw);
  } catch (e) { payload = null; }
  // Clean up: payload is single-use. If user reloads the print tab, we'll fall
  // through to shared-state lookup which is also fine.
  try { localStorage.removeItem(key); } catch (e) {}
  return payload;
}

function parsePrintRouteFromLocation() {
  if (typeof window === 'undefined' || !window.location) return null;
  const pathname = (window.location.pathname || '').replace(/\/+$/, '');
  const correctionMatch = pathname.match(/^\/student-correction\/([^/]+)$/);
  if (correctionMatch) {
    const params = new URLSearchParams(window.location.search || '');
    return {
      type: 'student-correction',
      shareKey: decodeURIComponent(correctionMatch[1] || ''),
      subject: (params.get('subject') || '').toString().trim(),
      showNegativePenalty: params.get('showNegativePenalty') !== '0'
    };
  }
  const facilityMatch = pathname.match(/^\/facility-index\/([^/]+)$/);
  if (facilityMatch) {
    const params = new URLSearchParams(window.location.search || '');
    return {
      type: 'facility-index',
      quizId: decodeURIComponent(facilityMatch[1] || ''),
      subject: (params.get('subject') || '').toString().trim() || 'General'
    };
  }
  return null;
}

function parsePdfRoutePathOnClient(routePath = '') {
  try {
    const url = new URL((routePath || '').toString(), getPublicAppBaseUrl());
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'pdf' || parts.length < 3) return null;
    return {
      url,
      type: parts[1],
      recordId: decodeURIComponent(parts.slice(2).join('/'))
    };
  } catch (error) {
    return null;
  }
}

function findSubmissionByShareKey(shareKey = '') {
  const key = (shareKey || '').toString().trim().toLowerCase();
  if (!key) return null;
  const matches = getAllSubmissions().filter((item) => {
    const candidate = (item.shareKey || buildSubmissionShareKeyCandidate(item)).toString().trim().toLowerCase();
    return candidate === key;
  });
  return matches.length ? matches.slice().sort(sortSubmissionRecords)[matches.length - 1] : null;
}

function findSubmissionBySubmissionKey(quizId = '', submissionKey = '') {
  const id = (quizId || '').toString().trim();
  const key = (submissionKey || '').toString().trim();
  if (!id || !key) return null;
  const subs = getAllSubmissions().filter((item) => item.quizId === id && (item.submissionId || buildSubmissionIdentity(item)) === key);
  return subs.length ? subs.slice().sort(sortSubmissionRecords)[subs.length - 1] : null;
}

function buildClientPdfBootstrapPayload(routePath = '') {
  const parsed = parsePdfRoutePathOnClient(routePath);
  if (!parsed) return null;
  const quizzes = getAllQuizzes();
  const submissions = getAllSubmissions();
  const verificationBaseUrl = getPublicAppBaseUrl();
  const pagePortrait = {
    orientation: 'portrait',
    rootWidthMm: 190,
    marginsMm: { top: 12, right: 10, bottom: 12, left: 10 }
  };
  const pagePortraitWide = {
    orientation: 'portrait',
    rootWidthMm: 194,
    marginsMm: { top: 10, right: 8, bottom: 10, left: 8 }
  };

  if (parsed.type === 'result-summary') {
    const submission = findSubmissionByShareKey(parsed.recordId);
    const quiz = submission ? quizzes[submission.quizId] : null;
    if (!submission || !quiz) return null;
    const shareUrl = buildCertificateVerificationUrl(quiz, submission);
    return {
      type: 'result-summary',
      title: 'Student Result Summary PDF',
      quiz,
      submission,
      rankValue: getSubmissionRank(submission, computeRankingForQuiz(submission.quizId)) || '-',
      verificationBaseUrl,
      verificationQrSvg: buildCertificateVerificationQrSvg(shareUrl),
      page: pagePortrait
    };
  }

  if (parsed.type === 'student-correction') {
    const submission = findSubmissionByShareKey(parsed.recordId);
    const quiz = submission ? quizzes[submission.quizId] : null;
    if (!submission || !quiz) return null;
    return {
      type: 'student-correction',
      title: 'Student Correction PDF',
      quiz,
      submission,
      subjectName: (parsed.url.searchParams.get('subject') || '').trim(),
      showNegativePenalty: true,
      verificationBaseUrl,
      page: pagePortraitWide
    };
  }

  if (parsed.type === 'facility-index') {
    const quiz = quizzes[parsed.recordId];
    if (!quiz) return null;
    return {
      type: 'facility-index',
      title: 'Facility Index PDF',
      quiz,
      submissions: submissions.filter((item) => item && item.quizId === quiz.id),
      subjectName: (parsed.url.searchParams.get('subject') || '').trim(),
      verificationBaseUrl,
      page: pagePortraitWide
    };
  }

  if (parsed.type === 'teacher-summary') {
    const quiz = quizzes[parsed.recordId];
    if (!quiz) return null;
    const format = (parsed.url.searchParams.get('format') || '').trim();
    const subjectCount = Array.isArray(quiz.subjects) ? quiz.subjects.length : 0;
    const useLandscape = format === 'separate' && subjectCount > 4;
    return {
      type: 'teacher-summary',
      title: 'Teacher Result Summary PDF',
      quiz,
      submissions: submissions.filter((item) => item && item.quizId === quiz.id),
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

function buildServerPdfDownloadUrl(routePath = '', filename = '', options = {}) {
  const apiPath = buildApiUrl('/api/export/pdf');
  const baseUrl = getPublicAppBaseUrl();
  const url = /^https?:\/\//i.test(apiPath) ? new URL(apiPath) : new URL(apiPath, baseUrl);
  if (routePath) url.searchParams.set('routePath', routePath);
  if (filename) url.searchParams.set('filename', filename);
  if (options.inline !== false) url.searchParams.set('inline', '1');
  return url.toString();
}

async function requestServerPdfRouteExport(routePath, filename, exportOptions = {}, requestOptions = {}) {
  const syncKeys = Array.isArray(requestOptions.syncKeys) ? requestOptions.syncKeys.filter(Boolean) : [];
  if (syncKeys.length && canUseNetworkSync()) {
    const keysNeedingFlush = syncKeys.filter((key) => dirtyNetworkKeys.has(key) || pendingNetworkWrites.has(key));
    if (keysNeedingFlush.length) {
      await flushPendingNetworkWrites(keysNeedingFlush, { pullAfter: false });
    }
  }
  const bootstrapPayload = requestOptions.bootstrap || buildClientPdfBootstrapPayload(routePath);
  const response = await fetch(buildApiUrl('/api/export/pdf'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      routePath,
      filename,
      inline: !!requestOptions.inline,
      bootstrap: bootstrapPayload || undefined,
      options: {
        title: exportOptions.title || filename.replace(/\.pdf$/i, ''),
        orientation: exportOptions.orientation === 'l' || exportOptions.orientation === 'landscape' ? 'landscape' : 'portrait',
        margins: normalizePdfExportMargins(exportOptions)
      }
    })
  });
  if (!response.ok) {
    let message = 'PDF export failed';
    try {
      const payload = await response.json();
      if (payload && payload.error) message = payload.error;
    } catch (error) {}
    if (isServerPdfExportDisabledError(response.status, message)) {
      markServerPdfExportAvailability(false);
    }
    throw new Error(message);
  }
  markServerPdfExportAvailability(true);
  return response.blob();
}

async function downloadPdfThroughServer(html, filename, successMessage = 'PDF downloaded', exportOptions = {}) {
  const blob = await requestServerPdfExport(html, filename, exportOptions);
  triggerBlobDownload(blob, filename);
  if (successMessage) showNotification(successMessage, 'success');
  return true;
}

async function openServerPdfPreview(html, filename, exportOptions = {}) {
  const blob = await requestServerPdfExport(html, filename, exportOptions, { inline: true });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank', 'noopener');
  if (!win) {
    URL.revokeObjectURL(url);
    throw new Error('Unable to open PDF preview window');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
  showNotification('PDF preview opened in a new tab', 'success', 5000);
  return true;
}

async function downloadPdfRouteThroughServer(routePath, filename, successMessage = 'PDF downloaded', exportOptions = {}, requestOptions = {}) {
  const blob = await requestServerPdfRouteExport(routePath, filename, exportOptions, requestOptions);
  triggerBlobDownload(blob, filename);
  if (successMessage) showNotification(successMessage, 'success');
  return true;
}

async function openServerPdfRoutePreview(routePath, filename, exportOptions = {}, requestOptions = {}) {
  const blob = await requestServerPdfRouteExport(routePath, filename, exportOptions, {
    ...requestOptions,
    inline: true
  });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank', 'noopener');
  if (!win) {
    URL.revokeObjectURL(url);
    throw new Error('Unable to open PDF preview window');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
  showNotification('PDF preview opened in a new tab', 'success', 5000);
  return true;
}

function downloadPdfFromHtmlClientFallback(html, filename, successMessage = 'PDF downloaded', exportOptions = {}) {
  const sourceId = 'pdf-content-source';
  const paddingPx = exportOptions.paddingPx == null ? 24 : exportOptions.paddingPx;
  const sourceWidthPx = Math.max(320, Math.round(Number(exportOptions.sourceWidthPx) || 794));
  const sourceContentWidthPx = Math.max(240, sourceWidthPx - (paddingPx * 2));
  let source = document.getElementById(sourceId);
  if (source) source.remove();
  source = document.createElement('div');
  source.id = sourceId;
  source.innerHTML = html;
  Object.assign(source.style, {
    position: 'absolute',
    left: '-99999px',
    top: '0',
    width: `${sourceContentWidthPx}px`,
    background: '#ffffff',
    overflow: 'visible',
    display: 'block'
  });
  document.body.appendChild(source);
  return exportElementToPDF({ sourceSelector: `#${sourceId}`, filename, ...exportOptions })
    .then(() => { source.remove(); if (successMessage) showNotification(successMessage, 'success'); return true; })
    .catch(err => {
      source.remove();
      showNotification('Error generating PDF', 'error');
      throw err;
    });
}

function downloadPagedPdfFromHtml(html, filename, successMessage = 'PDF downloaded', exportOptions = {}) {
  if (canUseServerHtmlPdfExport(exportOptions)) {
    return runServerHtmlPdfExport(
      () => downloadPdfThroughServer(html, filename, successMessage, exportOptions),
      exportOptions
    )
      .catch((error) => {
        console.warn('Server paged PDF export failed. Falling back to browser rendering.', error);
        return downloadPagedPdfFromHtmlClientFallback(html, filename, successMessage, exportOptions);
      });
  }
  return downloadPagedPdfFromHtmlClientFallback(html, filename, successMessage, exportOptions);
}

function downloadPagedPdfFromHtmlClientFallback(html, filename, successMessage = 'PDF downloaded', exportOptions = {}) {
  const sourceId = 'paged-pdf-content-source';
  const scale = Math.max(1.5, Number(exportOptions.scale) || 2.4);
  const contentWidthMm = Math.max(120, Number(exportOptions.contentWidthMm) || 180);
  const marginsMm = exportOptions.marginsMm || { top: 18, right: 15, bottom: 18, left: 15 };
  const avoid = Array.isArray(exportOptions.pagebreakAvoid) && exportOptions.pagebreakAvoid.length
    ? exportOptions.pagebreakAvoid
    : ['.avoid-break', '.pdf-section-card', '.pdf-question-card', '.pdf-summary-card', '.pdf-meta-card'];
  const before = Array.isArray(exportOptions.pagebreakBefore) ? exportOptions.pagebreakBefore : [];
  const after = Array.isArray(exportOptions.pagebreakAfter) ? exportOptions.pagebreakAfter : [];
  let source = document.getElementById(sourceId);
  if (source) source.remove();
  source = document.createElement('div');
  source.id = sourceId;
  source.innerHTML = html;
  Object.assign(source.style, {
    position: 'absolute',
    left: '-99999px',
    top: '0',
    width: `${contentWidthMm}mm`,
    minWidth: `${contentWidthMm}mm`,
    maxWidth: `${contentWidthMm}mm`,
    background: '#ffffff',
    overflow: 'visible',
    display: 'block'
  });
  document.body.appendChild(source);
  if (exportOptions.preferCanvasSnapshot) {
    const marginCandidates = [marginsMm.top, marginsMm.right, marginsMm.bottom, marginsMm.left]
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= 0);
    const snapshotMarginMm = Number.isFinite(Number(exportOptions.marginMm))
      ? Number(exportOptions.marginMm)
      : (marginCandidates.length ? Math.min(...marginCandidates) : 10);
    return exportElementToPDF({
      sourceSelector: `#${sourceId}`,
      filename,
      title: exportOptions.title || filename.replace(/\.pdf$/i, ''),
      orientation: exportOptions.orientation === 'l' || exportOptions.orientation === 'landscape' ? 'l' : 'p',
      paddingPx: exportOptions.paddingPx == null ? 0 : Number(exportOptions.paddingPx),
      marginMm: snapshotMarginMm,
      singlePage: false,
      sourceWidthPx: Math.max(700, Number(exportOptions.sourceWidthPx) || Math.round(contentWidthMm * 4.8)),
      renderScale: Math.max(1.5, Number(exportOptions.renderScale) || Math.max(2, scale))
    })
      .then(() => {
        if (source && source.parentNode) source.remove();
        if (successMessage) showNotification(successMessage, 'success');
        return true;
      })
      .catch((error) => {
        if (source && source.parentNode) source.remove();
        showNotification('Error generating PDF', 'error');
        throw error;
      });
  }
  if (typeof html2pdf === 'undefined') {
    return downloadPdfFromHtml(html, filename, successMessage, exportOptions)
      .finally(() => { if (source && source.parentNode) source.remove(); });
  }
  return Promise.resolve()
    .then(async () => {
      const sandboxState = await preparePdfExportSandbox({
        sourceNode: source,
        widthCss: `${contentWidthMm}mm`,
        paddingCss: '0',
        renderDelayMs: Number(exportOptions.renderDelayMs) || 300
      });
      const exportSize = measurePdfExportSize(sandboxState.exportRoot, sandboxState.clonedContent, sandboxState.clonedContent?.firstElementChild || null);
      const exportWidth = Math.max(exportSize.width, 1200);
      const exportHeight = Math.max(exportSize.height, 1200);
      try {
        return await html2pdf().set({
          margin: [marginsMm.top, marginsMm.left, marginsMm.bottom, marginsMm.right],
          filename,
          image: { type: 'jpeg', quality: 1 },
          html2canvas: {
            scale,
            useCORS: true,
            allowTaint: false,
            backgroundColor: '#ffffff',
            logging: false,
            windowWidth: exportWidth,
            windowHeight: exportHeight,
            scrollX: 0,
            scrollY: 0
          },
          jsPDF: {
            unit: 'mm',
            format: 'a4',
            orientation: 'portrait',
            compress: true
          },
          pagebreak: {
            mode: ['css', 'legacy'],
            avoid,
            before,
            after
          }
        }).from(sandboxState.exportRoot).save();
      } finally {
        sandboxState.cleanup();
      }
    })
    .then(() => {
      if (source && source.parentNode) source.remove();
      if (successMessage) showNotification(successMessage, 'success');
      return true;
    })
    .catch((error) => {
      if (source && source.parentNode) source.remove();
      showNotification('Error generating PDF', 'error');
      throw error;
    });
}

function makeSafeFilenamePart(value, fallback = 'student') {
  const cleaned = (value || '').toString().trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || fallback;
}

function getStudentResultPdfFilename(submission, quizId, prefix = '') {
  const studentName = makeSafeFilenamePart(submission?.name || submission?.registrationNo || submission?.email, 'student');
  const safeQuizId = makeSafeFilenamePart(quizId || submission?.quizId, 'quiz');
  const safePrefix = prefix ? `${makeSafeFilenamePart(prefix, prefix)}-` : '';
  return `${safePrefix}${studentName}-result-${safeQuizId}.pdf`;
}

function measurePdfExportSize(...nodes) {
  return (nodes || []).filter(Boolean).reduce((largest, node) => {
    const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : { width: 0, height: 0 };
    const nextWidth = Math.max(
      Math.ceil(node.scrollWidth || 0),
      Math.ceil(node.offsetWidth || 0),
      Math.ceil(node.clientWidth || 0),
      Math.ceil(rect.width || 0)
    );
    const nextHeight = Math.max(
      Math.ceil(node.scrollHeight || 0),
      Math.ceil(node.offsetHeight || 0),
      Math.ceil(node.clientHeight || 0),
      Math.ceil(rect.height || 0)
    );
    return {
      width: Math.max(largest.width, nextWidth),
      height: Math.max(largest.height, nextHeight)
    };
  }, { width: 0, height: 0 });
}

async function renderElementToCanvas({
  sourceSelector,
  title = '',
  paddingPx = 24,
  debug = false,
  sourceWidthPx = 794,
  scale = 2
}) {
  const source = document.querySelector(sourceSelector);
  if (!source) throw new Error(`Export source not found: ${sourceSelector}`);
  if (typeof html2canvas === 'undefined') throw new Error('html2canvas is not loaded.');
  const exportSourceWidth = Math.max(320, Math.round(Number(sourceWidthPx) || 794));
  let sandboxState = null;
  try {
    sandboxState = await preparePdfExportSandbox({
      sourceNode: source,
      widthCss: `${exportSourceWidth}px`,
      paddingCss: `${paddingPx}px`,
      title
    });

    const exportSize = measurePdfExportSize(sandboxState.exportRoot, sandboxState.clonedContent, sandboxState.clonedContent?.firstElementChild || null);
    const exportWidth = exportSize.width;
    const exportHeight = exportSize.height;
    if (debug) {
      console.log('Export root width:', exportWidth);
      console.log('Export root height:', exportHeight);
    }
    const canvas = await html2canvas(sandboxState.exportRoot, {
      scale: Math.max(1, Number(scale) || 2),
      useCORS: true,
      allowTaint: false,
      backgroundColor: '#ffffff',
      logging: !!debug,
      width: exportWidth,
      height: exportHeight,
      windowWidth: exportWidth,
      windowHeight: exportHeight,
      scrollX: 0,
      scrollY: 0
    });
    sandboxState.cleanup();
    return canvas;
  } catch (error) {
    if (sandboxState) sandboxState.cleanup();
    throw error;
  }
}

async function exportElementToPDF({
  sourceSelector,
  filename = 'export.pdf',
  title = '',
  orientation = 'p',
  paddingPx = 24,
  marginMm = 10,
  singlePage = false,
  debug = false,
  sourceWidthPx = 794,
  renderScale = 2
}) {
  if (!window.jspdf || !window.jspdf.jsPDF) throw new Error('jsPDF is not loaded.');
  try {
    const canvas = await renderElementToCanvas({ sourceSelector, title, paddingPx, debug, sourceWidthPx, scale: renderScale });
    const getCanvasImagePayload = () => {
      try {
        return { format: 'JPEG', data: canvas.toDataURL('image/jpeg', 0.98) };
      } catch (error) {
        return { format: 'PNG', data: canvas.toDataURL('image/png') };
      }
    };
    const imagePayload = getCanvasImagePayload();
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation, unit: 'mm', format: 'a4', compress: true });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = marginMm;
    const usableWidth = pageWidth - margin * 2;
    const usableHeight = pageHeight - margin * 2;
    const widthScale = usableWidth / canvas.width;
    const heightScale = usableHeight / canvas.height;
    const fitScale = Math.min(widthScale, heightScale);
    const imgWidth = canvas.width * fitScale;
    const imgHeight = canvas.height * fitScale;
    if (singlePage) {
      const offsetX = margin + ((usableWidth - imgWidth) / 2);
      const offsetY = margin + ((usableHeight - imgHeight) / 2);
      pdf.addImage(imagePayload.data, imagePayload.format, offsetX, offsetY, imgWidth, imgHeight, undefined, 'FAST');
    } else {
      const pageImgWidth = usableWidth;
      const pageImgHeight = (canvas.height * pageImgWidth) / canvas.width;
      let heightLeft = pageImgHeight;
      let currentY = margin;
      pdf.addImage(imagePayload.data, imagePayload.format, margin, currentY, pageImgWidth, pageImgHeight, undefined, 'FAST');
      heightLeft -= usableHeight;
      while (heightLeft > 0) {
        pdf.addPage();
        currentY = margin - (pageImgHeight - heightLeft);
        pdf.addImage(imagePayload.data, imagePayload.format, margin, currentY, pageImgWidth, pageImgHeight, undefined, 'FAST');
        heightLeft -= usableHeight;
      }
    }
    pdf.save(filename);
    return true;
  } catch (error) {
    console.error('PDF export failed:', error);
    throw error;
  }
}

function sanitizeExportClone(root) {
  const all = [root, ...root.querySelectorAll('*')];
  all.forEach((el) => {
    el.classList.remove(
      'print-container',
      'sticky',
      'fixed',
      'hidden',
      'collapse',
      'collapsed',
      'is-hidden',
      'is-collapsed',
      'animate-in',
      'animate-out',
      'animated'
    );
    const style = el.style;
    if (!style) return;
    if (style.display === 'none') style.display = 'block';
    if (style.position === 'fixed' || style.position === 'sticky') style.position = 'static';
    if (style.overflow === 'hidden') style.overflow = 'visible';
    if (style.contentVisibility) style.contentVisibility = 'visible';
    if (style.contain) style.contain = 'none';
    if (style.transform) style.transform = 'none';
    if (style.clipPath) style.clipPath = 'none';
    if (style.clip) style.clip = 'auto';
    if (style.filter) style.filter = 'none';
    if (style.maxHeight === '0px' || style.height === '0px') {
      style.maxHeight = '';
      style.height = '';
    }
    if (style.opacity === '0') style.opacity = '1';
    if (style.visibility === 'hidden') style.visibility = 'visible';
    if (style.left || style.right) {
      style.left = '';
      style.right = '';
    }
  });
}

function copyFormValues(sourceRoot, cloneRoot) {
  const sourceFields = sourceRoot.querySelectorAll('input, textarea, select');
  const cloneFields = cloneRoot.querySelectorAll('input, textarea, select');
  sourceFields.forEach((src, index) => {
    const dest = cloneFields[index];
    if (!dest) return;
    if (src.tagName === 'SELECT') dest.value = src.value;
    else if (src.type === 'checkbox' || src.type === 'radio') dest.checked = src.checked;
    else {
      dest.value = src.value;
      dest.setAttribute('value', src.value);
    }
  });
}

async function waitForImages(root) {
  const images = Array.from(root.querySelectorAll('img'));
  await Promise.all(images.map((img) => {
    if (img.complete && img.naturalWidth > 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => resolve();
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    });
  }));
}

function waitForNextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

async function printHtmlAsSinglePage(html, options = {}) {
  const filename = `${makeSafeFilenamePart(options.title || 'print-preview', 'print-preview')}.pdf`;
  if (canUseServerHtmlPdfExport(options)) {
    try {
      return await runServerHtmlPdfExport(
        () => openServerPdfPreview(html, filename, options),
        options
      );
    } catch (error) {
      console.warn('Server print preview failed. Falling back to browser canvas print.', error);
    }
  }
  const win = window.open('', '_blank', 'width=960,height=760');
  if (!win) throw new Error('Unable to open print window');
  win.document.write('<html><head><title>Preparing Print...</title></head><body style="font-family:Arial,sans-serif;padding:24px">Preparing print preview...</body></html>');
  win.document.close();

  const sourceId = 'print-html-source';
  let source = document.getElementById(sourceId);
  if (source) source.remove();
  source = document.createElement('div');
  source.id = sourceId;
  source.innerHTML = html;
  Object.assign(source.style, {
    position: 'absolute',
    left: '-99999px',
    top: '0',
    width: '794px',
    background: '#ffffff',
    overflow: 'visible',
    display: 'block'
  });
  document.body.appendChild(source);

  try {
    const canvas = await renderElementToCanvas({
      sourceSelector: `#${sourceId}`,
      paddingPx: options.paddingPx == null ? 10 : options.paddingPx,
      debug: !!options.debug
    });
    source.remove();
    const imgData = canvas.toDataURL('image/png');
    const safeTitle = escapeHtml(options.title || 'Print Result');
    win.document.open();
    win.document.write(`
      <html>
        <head>
          <title>${safeTitle}</title>
          <style>
            @page{size:A4 portrait;margin:6mm}
            html,body{margin:0;padding:0;background:#fff}
            body{display:flex;justify-content:center;align-items:flex-start;background:#fff}
            .print-image-shell{width:198mm;height:285mm;display:flex;justify-content:center;align-items:flex-start;overflow:hidden}
            .print-image{display:block;max-width:100%;max-height:285mm;width:auto;height:auto}
            @media print{
              html,body{background:#fff}
              .print-image-shell{width:100%;height:285mm}
              .print-image{max-width:100%;max-height:285mm}
            }
          </style>
        </head>
        <body>
          <div class="print-image-shell">
            <img id="printResultImage" class="print-image" src="${imgData}" alt="${safeTitle}" />
          </div>
          <script>
            (function () {
              var img = document.getElementById('printResultImage');
              function doPrint() {
                setTimeout(function () {
                  window.focus();
                  window.print();
                }, 180);
              }
              if (img && img.complete) doPrint();
              else if (img) {
                img.addEventListener('load', doPrint, { once: true });
                img.addEventListener('error', doPrint, { once: true });
              } else {
                doPrint();
              }
            })();
          </script>
        </body>
      </html>
    `);
    win.document.close();
    return true;
  } catch (error) {
    if (source && source.parentNode) source.remove();
    try { win.close(); } catch (e) {}
    console.error('Print render failed:', error);
    throw error;
  }
}

function optionText(question, letter) {
  const idx = (letter || '').toString().toUpperCase().charCodeAt(0) - 65;
  return (question.options || [])[idx] || letter || '';
}

function toSuperscriptText(value = '') {
  const map = {
    '0': '⁰',
    '1': '¹',
    '2': '²',
    '3': '³',
    '4': '⁴',
    '5': '⁵',
    '6': '⁶',
    '7': '⁷',
    '8': '⁸',
    '9': '⁹',
    '-': '⁻',
    '−': '⁻',
    '+': '⁺'
  };
  return (value || '').toString().split('').map((char) => map[char] || char).join('');
}

function sanitizeScientificText(value = '') {
  let text = decodeHtmlEntitiesDeep(value);
  text = text.replace(/\u00A0/g, ' ');
  text = text.replace(/©/g, 'Ω');
  text = text.replace(/¼F/gi, 'µF');
  text = text.replace(/μ/g, 'µ');
  text = text.replace(/uF\b/g, 'µF');
  text = text.replace(/([0-9])\s*[xX]\s*10\s*(?:\^|\{)\s*([+\-−]?\d+)/g, (_, base, exponent) => `${base} × 10${toSuperscriptText(exponent)}`);
  text = text.replace(/10\s*(?:\^|\{)\s*([+\-−]?\d+)/g, (_, exponent) => `10${toSuperscriptText(exponent)}`);
  text = text.replace(/\bdeg\s*C\b/gi, '°C');
  return text;
}

function decodeHtmlEntityReference(entity = '') {
  const raw = (entity || '').toString();
  const normalized = raw.toLowerCase();
  const named = {
    amp: '&',
    apos: "'",
    quot: '"',
    lt: '<',
    gt: '>',
    nbsp: ' ',
    '#39': "'"
  };
  if (Object.prototype.hasOwnProperty.call(named, normalized)) return named[normalized];
  if (normalized.startsWith('#x')) {
    const code = parseInt(normalized.slice(2), 16);
    if (Number.isFinite(code)) return String.fromCodePoint(code);
  } else if (normalized.startsWith('#')) {
    const code = parseInt(normalized.slice(1), 10);
    if (Number.isFinite(code)) return String.fromCodePoint(code);
  }
  return `&${raw};`;
}

function decodeHtmlEntitiesDeep(value = '', maxPasses = 4) {
  let text = value == null ? '' : String(value);
  for (let pass = 0; pass < maxPasses; pass++) {
    const decoded = text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (_, entity) => decodeHtmlEntityReference(entity));
    if (decoded === text) break;
    text = decoded;
  }
  return text;
}

function getDisplayOptionText(question, letter) {
  return sanitizeScientificText(optionText(question, letter));
}

function getSanitizedQuestionOptions(question = {}) {
  return (question.options || []).map((option) => sanitizeScientificText(option || ''));
}

function normalizeComparableOptionText(value = '') {
  return sanitizeScientificText((value || '').toString()).replace(/\s+/g, ' ').trim().toLowerCase();
}

function buildCorrectionPdfHtml(submission, quiz, opts = {}) {
  const showNegativePenalty = !!opts.showNegativePenalty;
  const questions = submission.allQuestions || [];
  const scoreNote = hasManualScoreOverride(submission) ? 'Teacher-adjusted score applied' : '';
  const liveQuestionMap = quiz ? getQuizLiveQuestionMap(quiz) : null;
  const answerMap = quiz ? getQuizAnswerMap(quiz) : null;
  const rows = questions.map((question, idx) => {
    const chosen = submission.answers && submission.answers[idx] ? submission.answers[idx] : '';
    const sourceId = (question && question._sourceId) || makeQuestionId(question, idx);
    const liveQuestion = liveQuestionMap ? liveQuestionMap[sourceId] : null;
    // Re-grade against the live quiz so post-edit corrections show the current
    // correct answer and updated correct/incorrect verdict.
    const verdict = evaluateAnswerForQuestion(question, chosen, answerMap, idx, liveQuestionMap);
    const isCorrect = verdict === 'correct';
    const liveCorrectLetter = ((liveQuestion && liveQuestion.answer) || question.answer || '').toString().toUpperCase();
    const correctOptionText = liveQuestion && Array.isArray(liveQuestion.options)
      ? (liveQuestion.options[liveCorrectLetter.charCodeAt(0) - 65] || '')
      : optionText(question, liveCorrectLetter);
    return `
      <tr>
        <td style="padding:8px;border:1px solid #CBD5E1;vertical-align:top">Q${idx + 1}</td>
        <td style="padding:8px;border:1px solid #CBD5E1;vertical-align:top;white-space:normal;word-break:break-word;overflow-wrap:anywhere">${renderRichTextHtml((liveQuestion && liveQuestion.question) || question.question || '')}</td>
        <td style="padding:8px;border:1px solid #CBD5E1;vertical-align:top;white-space:normal;word-break:break-word;overflow-wrap:anywhere">${renderRichTextHtml(optionText(question, chosen))}</td>
        <td style="padding:8px;border:1px solid #CBD5E1;vertical-align:top;white-space:normal;word-break:break-word;overflow-wrap:anywhere">${renderRichTextHtml(correctOptionText || liveCorrectLetter)}</td>
        <td style="padding:8px;border:1px solid #CBD5E1;vertical-align:top;color:${isCorrect ? '#047857' : '#B91C1C'};font-weight:700">${isCorrect ? 'Correct' : 'Incorrect'}</td>
      </tr>
    `;
  }).join('');
  return createPdfDocument(`Correction: ${submission.name || submission.email}`, `
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:18px">
      <div><strong>Quiz:</strong> ${escapeHtml(quiz.title || submission.quizId)}</div>
      <div><strong>Student:</strong> ${escapeHtml(submission.name || '')}</div>
      <div><strong>Email/ID:</strong> ${escapeHtml(submission.email || '')}</div>
      <div><strong>Score:</strong> ${formatScoreValue(submission.score || 0)}/${questions.length} (${submission.percent || 0}%)</div>
      ${showNegativePenalty ? `<div><strong>Negative penalty:</strong> ${submission.negativePenalty || 0}</div>` : ''}
      ${scoreNote ? `<div><strong>Score note:</strong> ${escapeHtml(scoreNote)}</div>` : ''}
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead>
        <tr style="background:#0F1724;color:#fff">
          <th style="padding:8px;border:1px solid #0F1724;text-align:left">#</th>
          <th style="padding:8px;border:1px solid #0F1724;text-align:left">Question</th>
          <th style="padding:8px;border:1px solid #0F1724;text-align:left">Your Answer</th>
          <th style="padding:8px;border:1px solid #0F1724;text-align:left">Correct Answer</th>
          <th style="padding:8px;border:1px solid #0F1724;text-align:left">Status</th>
        </tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="5" style="padding:12px;border:1px solid #CBD5E1">No questions recorded for this submission.</td></tr>'}</tbody>
    </table>
  `);
}

function buildCorrectionQuestionEntries(submission, opts = {}) {
  const requestedSubject = normalizeSubjectName(opts.subjectName || '');
  // When a quiz reference is supplied, overlay live question content (stem,
  // options, correct answer, explanation, learning point, etc.) on top of the
  // snapshot stored on the submission. That way teacher edits made after a
  // student submitted are reflected in their correction view next time they
  // open it. The student's recorded answer letter is preserved (it lives on
  // submission.answers), and the snapshot's _subject / _sourceId are kept so
  // grading + subject filtering still work.
  const liveQuestionMap = opts.quiz ? getQuizLiveQuestionMap(opts.quiz) : null;
  const entries = (submission?.allQuestions || []).map((question, index) => {
    const sourceId = (question && question._sourceId) || makeQuestionId(question, index);
    const liveQuestion = liveQuestionMap ? liveQuestionMap[sourceId] : null;
    const merged = liveQuestion
      ? { ...question, ...liveQuestion, _subject: question._subject || liveQuestion._subject, _sourceId: sourceId }
      : question;
    return {
      question: merged,
      snapshotQuestion: question,
      originalIndex: index,
      subject: getQuestionSubjectLabel(merged)
    };
  });
  if (!requestedSubject) return { entries, subjectName: '', matchedRequestedSubject: true };
  const filtered = entries.filter((entry) => normalizeSubjectName(entry.subject) === requestedSubject);
  return {
    entries: filtered.length ? filtered : entries,
    subjectName: filtered.length ? filtered[0].subject : '',
    matchedRequestedSubject: filtered.length > 0
  };
}

function getPdfExportTextLength(value = '') {
  return normalizeRichText(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .length;
}

function isPdfExportLongCard(...values) {
  const totalLength = values.reduce((sum, value) => sum + getPdfExportTextLength(value || ''), 0);
  return totalLength > 900;
}

function buildPdfOptionListHtml(question = {}, options = {}) {
  const selectedAnswer = (options.selectedAnswer || '').toString().trim().toUpperCase();
  const correctAnswer = (options.correctAnswer || question.answer || '').toString().trim().toUpperCase();
  const optionRows = getSanitizedQuestionOptions(question).map((option, index) => {
    const letter = String.fromCharCode(65 + index);
    const stateClasses = [
      letter === correctAnswer ? 'is-correct' : '',
      selectedAnswer && letter === selectedAnswer ? 'is-selected' : ''
    ].filter(Boolean).join(' ');
    return `
      <div class="pdf-option-row ${stateClasses}">
        <span class="pdf-option-letter">${letter}.</span>
        <div class="pdf-option-text rich-text-output">${renderRichTextHtml(option)}</div>
      </div>
    `;
  }).join('');
  return `
    <div class="pdf-option-list">
      ${optionRows || '<div class="pdf-option-row"><span class="pdf-option-text">No options provided.</span></div>'}
    </div>
  `;
}

function buildCorrectionPdfDocumentHtml(submission, quiz, opts = {}) {
  const correctionView = buildCorrectionQuestionEntries(submission, { subjectName: opts.subjectName || '', quiz });
  const entries = correctionView.entries.slice();
  // The merged `question` carries live edits (topic, explanation, etc.) but
  // its `options` and `answer` are in LIVE order — which doesn't match the
  // student's stored letter when the quiz used shuffled options. The
  // snapshot question is what the student actually saw, so we use it for
  // anything index/letter-sensitive (verdict, option highlighting, "student
  // answer" text). Live data still drives the explanatory metadata.
  const liveQuestionMapForVerdict = quiz ? getQuizLiveQuestionMap(quiz) : null;
  const resolvedSubjectName = correctionView.subjectName;
  const breakdown = computeSubmissionSubjectBreakdown(quiz, submission);
  const subjectSummary = resolvedSubjectName
    ? (breakdown.find((item) => normalizeSubjectName(item.name) === normalizeSubjectName(resolvedSubjectName)) || null)
    : null;
  const displayScore = subjectSummary ? subjectSummary.score : (submission.score || 0);
  const displayTotalMarks = subjectSummary ? subjectSummary.totalMarks : getSubmissionTotalMarks(submission, quiz);
  const displayPercent = subjectSummary ? subjectSummary.percent : (submission.percent || 0);
  const displayCorrect = subjectSummary ? subjectSummary.correct : (submission.correctCount || 0);
  const displayAttempted = subjectSummary ? subjectSummary.attempted : (submission.attemptedCount || 0);
  const displayWrong = subjectSummary ? subjectSummary.wrong : (submission.wrongCount || 0);
  const metaCards = [
    { label: 'Student', value: submission.name || 'Student' },
    { label: 'Email / ID', value: submission.email || submission.registrationNo || '' },
    { label: 'IP Address', value: getSubmissionIpAddress(submission) || 'Not captured' },
    { label: 'Quiz', value: quiz.title || submission.quizId || 'Quiz' },
    { label: 'Submitted', value: submission.submittedAt ? new Date(submission.submittedAt).toLocaleString() : 'N/A' },
    { label: 'Score', value: `${formatScoreValue(displayScore)} / ${formatScoreValue(displayTotalMarks)}` },
    { label: 'Percent', value: `${displayPercent || 0}%` },
    { label: 'Correct', value: `${displayCorrect || 0}` },
    { label: 'Attempted', value: `${displayAttempted || 0}` }
  ];
  if (opts.showNegativePenalty) metaCards.push({ label: 'Negative Penalty', value: formatScoreValue(submission.negativePenalty || 0) });
  const questionCards = entries.map((entry) => {
    const question = entry.question || {};
    const snapshotQuestion = entry.snapshotQuestion || question;
    const sourceId = (snapshotQuestion && snapshotQuestion._sourceId) || (question && question._sourceId) || makeQuestionId(snapshotQuestion, entry.originalIndex);
    const liveQuestion = liveQuestionMapForVerdict ? liveQuestionMapForVerdict[sourceId] : null;
    const qType = normalizeQuestionType(question.type);
    const rawChosen = submission.answers && submission.answers[entry.originalIndex] != null ? submission.answers[entry.originalIndex] : '';
    const chosen = rawChosen == null ? '' : rawChosen.toString();
    // Verdict against the SNAPSHOT (the student's view). Pass the live map so
    // the evaluator's text-comparison branch fires; that's the same branch the
    // summary/regrade uses, so the per-question verdicts and the score line up.
    const evaluatorMap = liveQuestion ? { [sourceId]: liveQuestion } : null;
    const verdict = evaluateAnswerForQuestion(snapshotQuestion, chosen, null, entry.originalIndex, evaluatorMap);
    let statusText = 'Incorrect';
    if (verdict === 'correct') statusText = 'Correct';
    else if (verdict === 'pending') statusText = 'Pending Review';
    else if (verdict === 'unanswered') statusText = chosen ? 'Incorrect' : 'No answer';
    // Metadata (topic / explanation / learning point) still tracks live edits.
    const topic = question.topic || entry.subject || 'General';
    const keyConcept = question.keyConcept || question.topic || entry.subject || 'General';
    const explanation = question.explanation || 'No explanation provided yet.';
    const learningPoint = question.learningPoint || question.explanation || question.topic || 'Review the correct answer again.';
    const longCardClass = isPdfExportLongCard(question.question || '', explanation, learningPoint) ? ' long-card' : '';
    // Per-type student/correct answer text + the optional options listing.
    let studentAnswerText = '';
    let correctAnswerText = '';
    let optionsBlock = '';
    if (qType === 'mcq') {
      // Visual layout matches the previous PDF design: options listed in the
      // LIVE order (post-edit canonical view), correct answer = live letter.
      // Verdict came from the evaluator above with text-based comparison so
      // shuffled-option submissions still get marked right.
      const liveCorrectLetter = ((liveQuestion && liveQuestion.answer) || question.answer || '').toString().toUpperCase();
      const chosenLetter = (chosen || '').toString().toUpperCase();
      // The chosen letter indexes into the SNAPSHOT options (what the student
      // actually saw at exam time). Look the text up there so "Student answer"
      // displays the option they actually picked, not whatever option happens
      // to occupy that letter slot in today's live order.
      const studentChosenText = chosenLetter
        ? getDisplayOptionText(snapshotQuestion, chosenLetter)
        : '';
      // The PDF renders the canonical LIVE option list, so the "Student
      // answer" line and the selected option highlight should use the LIVE
      // letter for the chosen text. That keeps the statement lines consistent
      // with the option block the reader is looking at.
      const liveOptionsArr = Array.isArray(question.options) ? question.options : [];
      const studentLiveIdx = studentChosenText
        ? liveOptionsArr.findIndex((option) => normalizeComparableOptionText(option || '') === normalizeComparableOptionText(studentChosenText))
        : -1;
      const studentLiveLetter = studentLiveIdx >= 0
        ? String.fromCharCode(65 + studentLiveIdx)
        : (chosenLetter || '');
      studentAnswerText = chosen
        ? `${studentLiveLetter || chosenLetter}. ${studentChosenText || chosen}`
        : 'No answer';
      correctAnswerText = liveCorrectLetter
        ? `${liveCorrectLetter}. ${getDisplayOptionText(question, liveCorrectLetter)}`
        : 'Not set';
      optionsBlock = `<div class="pdf-meta-line"><strong>Options:</strong></div>${buildPdfOptionListHtml(question, { selectedAnswer: studentLiveLetter, correctAnswer: liveCorrectLetter })}`;
    } else if (qType === 'yesno') {
      studentAnswerText = chosen || 'No answer';
      correctAnswerText = (question.answer || 'Not set').toString();
    } else if (qType === 'short') {
      studentAnswerText = chosen || 'No answer';
      const accepted = Array.isArray(question.acceptedAnswers) ? question.acceptedAnswers.filter(Boolean) : [];
      correctAnswerText = accepted.length ? accepted.join(' / ') : 'Not set';
    } else if (qType === 'essay') {
      studentAnswerText = chosen || 'No answer';
      correctAnswerText = 'Manually graded by teacher';
    }
    // Essay-specific score + remarks (visible to the student in the result
    // modal and in the correction PDF).
    let essayScoreLine = '';
    let essayRemarksLine = '';
    if (qType === 'essay') {
      const sid = (question && question._sourceId) || makeQuestionId(question, entry.originalIndex);
      const recordedScore = ((submission && submission.essayScores) || {})[sid];
      const teacherComment = (((submission && submission.essayComments) || {})[sid] || '').toString().trim();
      const breakdownEntry = (Array.isArray(submission && submission.subjectBreakdown) ? submission.subjectBreakdown : [])
        .find((item) => normalizeSubjectName(item.name || '') === normalizeSubjectName(entry.subject || question.subject || 'General'));
      const maxMarks = breakdownEntry && breakdownEntry.markPerQuestion ? breakdownEntry.markPerQuestion : '';
      const scoreText = recordedScore != null && Number.isFinite(Number(recordedScore))
        ? `${formatScoreValue(Number(recordedScore))}${maxMarks ? ` / ${formatScoreValue(maxMarks)}` : ''}`
        : 'Pending teacher review';
      essayScoreLine = `<div class="pdf-meta-line"><strong>Essay score:</strong> ${escapeHtml(scoreText)}</div>`;
      if (teacherComment) {
        essayRemarksLine = `<div class="pdf-meta-line pdf-writeup"><strong>Teacher's remarks:</strong> <div style="white-space:pre-wrap">${escapeHtml(teacherComment)}</div></div>`;
      }
    }
    const statusClass = statusText === 'Correct' ? 'status-correct'
      : statusText === 'Pending Review' ? 'status-pending'
      : 'status-incorrect';
    return `
      <section class="pdf-question-card ${statusClass} avoid-break${longCardClass}">
        <div class="pdf-question-head">
          <div class="pdf-question-number">Question ${entry.originalIndex + 1}</div>
          <div class="pdf-question-status">${statusText}</div>
        </div>
        ${renderQuestionMediaAssets(question, 'before')}
        <div class="pdf-question-text rich-text-output">${renderRichTextHtml(question.question || '')}</div>
        ${renderQuestionMediaAssets(question, 'after')}
        <div class="pdf-meta-line"><strong>Status:</strong> ${escapeHtml(statusText)}</div>
        <div class="pdf-meta-line"><strong>Type:</strong> ${escapeHtml(qType === 'mcq' ? 'Multiple Choice' : qType === 'yesno' ? 'Yes / No' : qType === 'short' ? 'Short Answer' : 'Long Answer (Essay)')}</div>
        <div class="pdf-meta-line"><strong>Key concept:</strong> <div class="rich-text-output">${renderRichTextHtml(keyConcept)}</div></div>
        ${breakdown.length > 1 ? `<div class="pdf-meta-line"><strong>Subject:</strong> ${escapeHtml(sanitizeScientificText(entry.subject || 'General'))}</div>` : ''}
        ${optionsBlock}
        <div class="pdf-meta-line"><strong>Student answer:</strong> <div style="white-space:pre-wrap">${escapeHtml(studentAnswerText)}</div></div>
        <div class="pdf-meta-line"><strong>Correct answer:</strong> ${escapeHtml(correctAnswerText)}</div>
        ${essayScoreLine}
        ${essayRemarksLine}
        <div class="pdf-meta-line"><strong>Topic:</strong> <div class="rich-text-output">${renderRichTextHtml(topic)}</div></div>
        <div class="pdf-meta-line pdf-writeup"><strong>Explanation:</strong> <div class="rich-text-output">${renderRichTextHtml(explanation)}</div></div>
        <div class="pdf-meta-line pdf-writeup"><strong>Learning point:</strong> <div class="rich-text-output">${renderRichTextHtml(learningPoint)}</div></div>
      </section>
    `;
  }).join('');

  return `
    <div class="pdf-doc-root correction-pdf-root">
      <style>
        .pdf-doc-root{font-family:"Segoe UI","Noto Sans","DejaVu Sans","Arial Unicode MS","Liberation Sans",Arial,sans-serif;color:#000;background:#fff;line-height:1.6;font-size:16pt;text-align:justify;hyphens:auto;-webkit-hyphens:auto}
        .pdf-doc-root *{box-sizing:border-box}
        .pdf-doc-shell{display:flex;flex-direction:column;gap:14px}
        .pdf-hero{border:2px solid #2F80ED;border-radius:18px;padding:18px 18px 16px;background:linear-gradient(180deg,#fff 0%,#F8FAFC 100%);text-align:left}
        .pdf-brand{font-size:16pt;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#2F80ED}
        .pdf-title{font-size:22pt;font-weight:900;line-height:1.25;color:#1F2937;margin-top:8px;text-transform:uppercase}
        .pdf-subtitle{font-size:16pt;color:#000;margin-top:6px;line-height:1.5}
        .pdf-section-card{border:1px solid #CBD5E1;border-radius:16px;padding:14px;background:#fff}
        .pdf-section-heading{font-size:18pt;font-weight:900;letter-spacing:.06em;text-transform:uppercase;color:#2F80ED;margin-bottom:10px;text-align:left}
        .pdf-meta-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
        .pdf-meta-card{border:1px solid #CBD5E1;border-radius:12px;background:#F8FAFC;padding:10px 12px;text-align:left}
        .pdf-meta-card strong{display:block;font-size:16pt;letter-spacing:.05em;text-transform:uppercase;color:#2F80ED;margin-bottom:6px}
        .pdf-meta-card span{display:block;color:#000;font-size:16pt;line-height:1.55;word-break:break-word}
        .pdf-question-card{border:1px solid #CBD5E1;border-radius:14px;background:#fff;padding:14px 14px 12px;page-break-inside:avoid;break-inside:avoid}
        .pdf-question-card.long-card{page-break-inside:auto !important;break-inside:auto !important}
        .pdf-question-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap;text-align:left}
        .pdf-question-number{font-size:17pt;font-weight:900;color:#1F2937}
        .pdf-question-status{padding:4px 10px;border-radius:999px;background:#EFF6FF;color:#000;font-size:16pt;font-weight:800;text-transform:uppercase;letter-spacing:.06em}
        .pdf-question-card.status-correct .pdf-question-status{background:#DCFCE7}
        .pdf-question-card.status-incorrect .pdf-question-status{background:#FEE2E2}
        .pdf-question-text{margin-top:10px;color:#000;font-size:16pt;line-height:1.6;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;text-align:justify;hyphens:auto;-webkit-hyphens:auto}
        .pdf-meta-line{margin-top:8px;color:#000;font-size:16pt;line-height:1.6;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;text-align:justify;hyphens:auto;-webkit-hyphens:auto}
        .pdf-meta-line strong{color:#000}
        .pdf-writeup{color:#000}
        .pdf-option-list{display:grid;grid-template-columns:1fr;gap:8px;margin-top:8px}
        .pdf-option-row{display:flex;gap:10px;align-items:flex-start;border:1px solid #E2E8F0;border-radius:10px;padding:8px 10px;background:#fff;text-align:left}
        .pdf-option-row.is-correct{border-color:#93C5FD;background:#EFF6FF}
        .pdf-option-row.is-selected{box-shadow:inset 0 0 0 1px rgba(47,128,237,.22)}
        .pdf-option-letter{font-weight:900;color:#000;min-width:22px;font-size:16pt}
        .pdf-option-text{color:#000;font-size:16pt;line-height:1.55;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;text-align:left}
        .rich-text-output{display:block;white-space:normal;word-break:break-word;overflow-wrap:anywhere;text-align:justify;hyphens:auto;-webkit-hyphens:auto}
        .rich-text-output > :first-child{margin-top:0}
        .rich-text-output > :last-child{margin-bottom:0}
        .rich-text-output p,.rich-text-output div,.rich-text-output ul,.rich-text-output ol{margin:0 0 .45em}
        .rich-text-output li{margin:0 0 .2em;text-align:justify;hyphens:auto;-webkit-hyphens:auto}
        @media(max-width:640px){.pdf-meta-grid{grid-template-columns:1fr}}
      </style>
      <div class="pdf-doc-shell">
        <section class="pdf-hero avoid-break">
          <div class="pdf-brand">OPE Assessor</div>
          <div class="pdf-title">Student Correction PDF</div>
          <div class="pdf-subtitle">${escapeHtml(sanitizeScientificText(quiz.title || submission.quizId || 'Quiz'))}${resolvedSubjectName ? ` • ${escapeHtml(sanitizeScientificText(resolvedSubjectName))}` : ''}</div>
        </section>
        <section class="pdf-section-card pdf-summary-card avoid-break">
          <div class="pdf-section-heading">Student Performance Summary</div>
          <div class="pdf-meta-grid">
            ${metaCards.map((item) => `
              <div class="pdf-meta-card">
                <strong>${escapeHtml(item.label)}</strong>
                <span>${escapeHtml(sanitizeScientificText(item.value || ''))}</span>
              </div>
            `).join('')}
          </div>
          <div class="pdf-meta-line"><strong>Total Wrong:</strong> ${displayWrong || 0}</div>
        </section>
        <section class="pdf-section-card">
          <div class="pdf-section-heading">Question Corrections</div>
          <div class="pdf-doc-shell">
            ${questionCards || '<div class="pdf-meta-line">No questions recorded for this submission.</div>'}
          </div>
        </section>
      </div>
    </div>
  `;
}

function downloadCorrectionPdfFast(submission, quiz, opts = {}) {
  // Build the full A4-styled HTML in this tab (where we have all the data) and
  // write it directly into a new window. No URL routing, no shared-state pull,
  // no localStorage hand-off — the destination tab opens already rendered.
  if (!submission || !quiz) {
    showNotification('Cannot open correction view — submission or quiz data is missing.', 'error');
    return Promise.resolve(false);
  }
  const correctionView = buildCorrectionQuestionEntries(submission, { subjectName: opts.subjectName || '', quiz });
  const resolvedSubjectName = correctionView.subjectName;
  const title = `Correction · ${submission.name || submission.email || 'Student'}${resolvedSubjectName ? ` · ${resolvedSubjectName}` : ''}`;
  const innerHtml = buildCorrectionPdfDocumentHtml(submission, quiz, {
    showNegativePenalty: opts.showNegativePenalty !== false,
    subjectName: resolvedSubjectName
  });
  const ok = openPrintableDocumentInNewWindow(title, innerHtml);
  if (ok) showNotification('Correction view opened in a new tab. Use "Print > Save as PDF" for a copy.', 'success', 6000);
  return Promise.resolve(ok);
}

async function markSubmissionCorrectionShared(quizId, email, submittedAt, patch = {}) {
  const all = getAllSubmissions();
  const index = findSubmissionIndexByIdentity(all, quizId, email, submittedAt || '');
  if (index < 0) return false;
  all[index] = {
    ...all[index],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  saveAllSubmissions(all);
  // Per-quiz submissions push (bulk PUT /api/state/submissions is now blocked
  // for teacher sessions). Falls through silently if quizId is unknown.
  if (quizId) {
    const quizSubs = getAllSubmissions({ includeDeleted: true }).filter((s) => s && s.quizId === quizId);
    await pushSingleQuizSubmissionsToCloud(quizId, quizSubs);
  }
  return true;
}

async function markCorrectionPdfDownloaded(submission) {
  if (!submission) return false;
  const downloadedAt = new Date().toISOString();
  await markSubmissionCorrectionShared(submission.quizId, submission.email, submission.submittedAt, {
    correctionStatus: 'downloaded',
    correctionDownloadedAt: downloadedAt,
    _correctionDownloaded: true
  });
  submission.correctionStatus = 'downloaded';
  submission.correctionDownloadedAt = downloadedAt;
  submission._correctionDownloaded = true;
  return true;
}

async function sendCorrectionByEmail(submission, quiz) {
  const contact = getSubmissionCorrectionContact(submission);
  const targetEmail = contact.email || ((submission.email || '').includes('@') ? submission.email : '');
  if (!targetEmail) {
    showNotification('This student did not provide an email contact for corrections.', 'error');
    return false;
  }
  try {
    const sharedSyncOk = await syncSharedKeys([STORAGE_KEYS.submissions, STORAGE_KEYS.quizzes]);
    if (!sharedSyncOk) {
      showNotification(getSharedSyncWarningMessage(), 'error', 8000);
      return false;
    }
    const subject = encodeURIComponent(`Correction for ${quiz.title || submission.quizId}`);
    const body = encodeURIComponent(buildCorrectionShareMessage(submission, quiz));
    window.location.href = `mailto:${encodeURIComponent(targetEmail)}?subject=${subject}&body=${body}`;
    await markSubmissionCorrectionShared(submission.quizId, submission.email, submission.submittedAt, {
      correctionStatus: 'emailed',
      correctionEmailedAt: new Date().toISOString()
    });
    showNotification('Email draft opened with correction links for the student.', 'success', 7000);
    return true;
  } catch (error) {
    console.error(error);
    showNotification('Error preparing correction email', 'error');
    return false;
  }
}

async function shareCorrectionViaWhatsapp(submission, quiz, options = {}) {
  const contact = getSubmissionCorrectionContact(submission);
  const phone = contact.whatsapp || normalizeWhatsappNumber(submission.whatsappNumber || '');
  if (!phone) {
    showNotification('This student did not provide a WhatsApp number for corrections.', 'error');
    return false;
  }
  try {
    const sharedSyncOk = await syncSharedKeys([STORAGE_KEYS.submissions, STORAGE_KEYS.quizzes]);
    if (!sharedSyncOk) {
      showNotification(getSharedSyncWarningMessage(), 'error', 8000);
      return false;
    }
    const message = buildCorrectionShareMessage(submission, quiz);
    openWhatsappChat(phone, message);
    await markSubmissionCorrectionShared(submission.quizId, submission.email, submission.submittedAt, {
      correctionStatus: 'whatsapp-opened',
      correctionWhatsappAt: new Date().toISOString()
    });
    if (!options.suppressSuccess) {
      showNotification('WhatsApp opened with correction links for the student.', 'success', 7000);
    }
    return true;
  } catch (error) {
    console.error(error);
    showNotification('Error preparing WhatsApp correction share', 'error');
    return false;
  }
}

function openRequestedCorrectionsShareModal(quiz, submissions = []) {
  const requested = (submissions || []).filter((submission) => !!submission.correctionRequested);
  let modal = document.getElementById('requestedCorrectionsShareModal');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'requestedCorrectionsShareModal';
  modal.className = 'student-result-modal';
  const inner = document.createElement('div');
  inner.className = 'card-beautiful admin-modal-card';
  inner.style.width = 'min(960px, 96vw)';
  inner.innerHTML = `
    <div class="page-heading">
      <div>
        <div class="h2">Share Requested Corrections</div>
        <div class="small">${escapeHtml(quiz.title || quiz.id || 'Quiz')}</div>
      </div>
      <button id="closeRequestedCorrectionsShareModal" class="btn btn-ghost">Close</button>
    </div>
    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
      <div class="small">Only students who requested correction are listed here.</div>
      <button id="bulkWhatsappCorrections" class="btn btn-primary btn-sm"${requested.some((item) => getSubmissionCorrectionContact(item).whatsapp) ? '' : ' disabled'}>Open All WhatsApp Chats</button>
    </div>
    <div class="table-wrap">
      <table class="table-dense">
        <thead><tr><th>Name</th><th>Email / ID</th><th>Preferred Contact</th><th>Status</th><th>Request</th><th>Actions</th></tr></thead>
        <tbody>
          ${requested.map((submission) => {
            const contact = getSubmissionCorrectionContact(submission);
            const shareMeta = getSubmissionCorrectionShareMeta(submission);
            const shareStamp = formatCorrectionActivityStamp(shareMeta.timestamp);
            return `<tr>
              <td>${escapeHtml(submission.name || '')}</td>
              <td>${escapeHtml(submission.email || submission.registrationNo || '')}</td>
              <td>${escapeHtml(contact.label || 'Not provided')}</td>
              <td>${escapeHtml(shareMeta.label)}${shareStamp ? `<div class="small">${escapeHtml(shareStamp)}</div>` : ''}</td>
              <td>${escapeHtml(submission.correctionMessage || 'Correction review requested.')}</td>
              <td>
                <div class="row-action-shell">
                  <button type="button" class="btn btn-ghost btn-sm btnShareCorrectionEmail" data-email="${encodeURIComponent(submission.email || '')}" data-submitted="${escapeHtml(submission.submittedAt || '')}">Email</button>
                  <button type="button" class="btn btn-primary btn-sm btnShareCorrectionWhatsapp" data-email="${encodeURIComponent(submission.email || '')}" data-submitted="${escapeHtml(submission.submittedAt || '')}">WhatsApp</button>
                </div>
              </td>
            </tr>`;
          }).join('') || '<tr><td colspan="6">No correction requests yet.</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
  modal.appendChild(inner);
  document.body.appendChild(modal);
  modal.onclick = (event) => { if (event.target === modal) modal.remove(); };
  document.getElementById('closeRequestedCorrectionsShareModal').onclick = () => modal.remove();
  const resolveSubmission = (button) => {
    const email = decodeURIComponent(button.dataset.email || '');
    const submittedAt = button.dataset.submitted || '';
    const all = getAllSubmissions();
    const index = findSubmissionIndexByIdentity(all, quiz.id, email, submittedAt);
    return index >= 0 ? all[index] : null;
  };
  inner.querySelectorAll('.btnShareCorrectionEmail').forEach((button) => {
    button.onclick = async () => {
      const submission = resolveSubmission(button);
      if (!submission) return showNotification('Submission not found', 'error');
      await sendCorrectionByEmail(submission, quiz);
    };
  });
  inner.querySelectorAll('.btnShareCorrectionWhatsapp').forEach((button) => {
    button.onclick = async () => {
      const submission = resolveSubmission(button);
      if (!submission) return showNotification('Submission not found', 'error');
      await shareCorrectionViaWhatsapp(submission, quiz);
    };
  });
  const bulkBtn = document.getElementById('bulkWhatsappCorrections');
  if (bulkBtn) bulkBtn.onclick = async () => {
    const whatsappTargets = requested.filter((submission) => !!getSubmissionCorrectionContact(submission).whatsapp);
    if (!whatsappTargets.length) return showNotification('No requested correction has a WhatsApp number yet.', 'error');
    if (!confirmTeacherAction(`Open WhatsApp chats for ${whatsappTargets.length} requested correction(s)?`)) return;
    for (const submission of whatsappTargets) {
      await shareCorrectionViaWhatsapp(submission, quiz, { forceLinkMode: true, suppressSuccess: true });
    }
    showNotification('Requested WhatsApp correction chats opened with the correction links.', 'success', 7000);
  };
}

function buildFacilityIndexPdfDocumentHtml(quiz, data, options = {}) {
  const subjectName = sanitizeScientificText((options.subjectName || '').toString().trim() || 'General');
  const summary = getFacilityAnalysisSummary(data);
  const orderedSections = [
    'Very Difficult',
    'Difficult',
    'Moderate',
    'Easy',
    'Very Easy'
  ].map((label) => ({
    label,
    items: (data || []).filter((item) => getFacilityDifficultyBand(item.facilityIndex).label === label)
      .sort((left, right) => (left.facilityIndex ?? 1) - (right.facilityIndex ?? 1))
  })).filter((section) => section.items.length);
  const noAttemptItems = (data || []).filter((item) => item.facilityIndex == null);
  if (noAttemptItems.length) orderedSections.push({ label: 'No Attempts', items: noAttemptItems });
  return `
    <div class="pdf-doc-root facility-pdf-root">
      <style>
        .facility-pdf-root{font-family:"Segoe UI","Noto Sans","DejaVu Sans","Arial Unicode MS","Liberation Sans",Arial,sans-serif;color:#000;background:#fff;line-height:1.6;font-size:16pt;text-align:justify;hyphens:auto;-webkit-hyphens:auto}
        .facility-pdf-root *{box-sizing:border-box}
        .facility-shell{display:flex;flex-direction:column;gap:14px}
        .facility-hero{border:2px solid #2F80ED;border-radius:18px;padding:18px;background:linear-gradient(180deg,#fff 0%,#F8FAFC 100%);text-align:left}
        .facility-brand{font-size:16pt;font-weight:900;letter-spacing:.12em;text-transform:uppercase;color:#2F80ED}
        .facility-title{font-size:22pt;font-weight:900;line-height:1.25;color:#1F2937;margin-top:8px;text-transform:uppercase}
        .facility-subtitle{font-size:16pt;color:#000;margin-top:6px;line-height:1.5}
        .facility-summary{border:1px solid #CBD5E1;border-radius:16px;background:#fff;padding:14px}
        .facility-section-heading{font-size:18pt;font-weight:900;letter-spacing:.06em;text-transform:uppercase;color:#2F80ED;margin-bottom:10px;text-align:left}
        .facility-summary-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
        .facility-summary-card{border:1px solid #CBD5E1;border-radius:12px;background:#F8FAFC;padding:10px 12px;text-align:left}
        .facility-summary-card strong{display:block;font-size:16pt;letter-spacing:.05em;text-transform:uppercase;color:#2F80ED;margin-bottom:6px}
        .facility-summary-card span{display:block;color:#000;font-size:16pt;line-height:1.55}
        .facility-band-section{display:flex;flex-direction:column;gap:10px}
        .facility-band-heading{padding:10px 14px;border-radius:14px;font-size:16pt;font-weight:900;letter-spacing:.05em;text-transform:uppercase;color:#000;border:1px solid var(--band-accent);background:var(--band-fill);text-align:left}
        .facility-question-card{border:1px solid #CBD5E1;border-left:4px solid var(--band-accent);border-radius:14px;background:#fff;padding:14px 14px 12px;page-break-inside:avoid;break-inside:avoid}
        .facility-question-card.long-card{page-break-inside:auto !important;break-inside:auto !important}
        .facility-question-head{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start;text-align:left}
        .facility-question-title{font-size:17pt;font-weight:900;color:#1F2937}
        .facility-question-chip{padding:4px 10px;border-radius:999px;background:var(--band-fill);color:#000;font-size:16pt;font-weight:800}
        .facility-question-text{margin-top:10px;color:#000;font-size:16pt;line-height:1.6;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;text-align:justify;hyphens:auto;-webkit-hyphens:auto}
        .facility-meta-line{margin-top:8px;color:#000;font-size:16pt;line-height:1.6;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;text-align:justify;hyphens:auto;-webkit-hyphens:auto}
        .facility-meta-line strong{color:#000}
        .facility-writeup{color:#000}
        .rich-text-output{display:block;white-space:normal;word-break:break-word;overflow-wrap:anywhere;text-align:justify;hyphens:auto;-webkit-hyphens:auto}
        .rich-text-output > :first-child{margin-top:0}
        .rich-text-output > :last-child{margin-bottom:0}
        .rich-text-output p,.rich-text-output div,.rich-text-output ul,.rich-text-output ol{margin:0 0 .45em}
        .rich-text-output li{margin:0 0 .2em;text-align:justify;hyphens:auto;-webkit-hyphens:auto}
        @media(max-width:640px){.facility-summary-grid{grid-template-columns:1fr}}
      </style>
      <div class="facility-shell">
        <section class="facility-hero avoid-break">
          <div class="facility-brand">OPE Assessor</div>
          <div class="facility-title">Facility Index PDF</div>
          <div class="facility-subtitle">${escapeHtml(subjectName)} • ${escapeHtml(sanitizeScientificText(quiz.title || quiz.id || 'Quiz'))}</div>
        </section>
        <section class="facility-summary avoid-break">
          <div class="facility-section-heading">Summary</div>
          <div class="facility-summary-grid">
            <div class="facility-summary-card"><strong>Average Facility Index</strong><span>${summary.average}%</span></div>
            <div class="facility-summary-card"><strong>Total Questions</strong><span>${summary.totalQuestions}</span></div>
            <div class="facility-summary-card"><strong>Easy / Moderate / Difficult</strong><span>${summary.percentages.easy}% / ${summary.percentages.moderate}% / ${summary.percentages.difficult}%</span></div>
          </div>
        </section>
        ${orderedSections.map((section) => {
          const band = section.label === 'No Attempts'
            ? { color: '#F8FAFC', accent: '#CBD5E1' }
            : getFacilityDifficultyBand(section.items[0].facilityIndex);
          return `
            <section class="facility-band-section">
              <div class="facility-band-heading avoid-break" style="--band-fill:${band.color};--band-accent:${band.accent}">${escapeHtml(section.label)}${section.label === 'No Attempts' ? '' : ` (${band.min}-${band.max}%)`}</div>
              ${section.items.map((item) => {
                const percentText = item.facilityIndex == null ? 'No attempts' : `${Math.round(item.facilityIndex * 100)}%`;
                const correctAnswerText = item.answer ? `${item.answer}. ${getDisplayOptionText(item, item.answer)}` : 'Not set';
                const optionCounts = (item.optionCounts || []).map((option) => `${option.letter}: ${option.count}`).join(' • ');
                const longCardClass = isPdfExportLongCard(item.question || '', item.explanation || '', item.learningPoint || item.keyConcept || '') ? ' long-card' : '';
                return `
                  <article class="facility-question-card avoid-break${longCardClass}" style="--band-fill:${band.color};--band-accent:${band.accent}">
                    <div class="facility-question-head">
                      <div class="facility-question-title">Question ${item.index} • ${percentText} • ${escapeHtml(section.label)}</div>
                      <div class="facility-question-chip">${escapeHtml(section.label)}</div>
                    </div>
                    ${renderQuestionMediaAssets(item, 'before')}
                    <div class="facility-question-text rich-text-output">${renderRichTextHtml(item.question || '')}</div>
                    ${renderQuestionMediaAssets(item, 'after')}
                    <div class="facility-meta-line"><strong>Options:</strong></div>
                    ${buildPdfOptionListHtml(item, { correctAnswer: item.answer || '' })}
                    <div class="facility-meta-line"><strong>Correct answer:</strong> ${escapeHtml(correctAnswerText)}</div>
                    <div class="facility-meta-line"><strong>Seen:</strong> ${item.seen} • <strong>Attempted:</strong> ${item.attempted} • <strong>Correct:</strong> ${item.correct} • <strong>Wrong:</strong> ${Math.max(0, item.attempted - item.correct)}</div>
                    <div class="facility-meta-line"><strong>Topic:</strong> <div class="rich-text-output">${renderRichTextHtml(item.topic || 'Not set')}</div></div>
                    <div class="facility-meta-line"><strong>Option counts:</strong> ${escapeHtml(optionCounts || 'No option counts yet.')}</div>
                    <div class="facility-meta-line facility-writeup"><strong>Explanation:</strong> <div class="rich-text-output">${renderRichTextHtml(item.explanation || 'No explanation provided yet.')}</div></div>
                  </article>
                `;
              }).join('')}
            </section>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function downloadFacilityIndexPdfText(quiz, data, options = {}) {
  // Same approach as the correction PDF: render the full A4-styled HTML here
  // and document.write it into a new window. No URL routing, no race.
  if (!quiz || !quiz.id) {
    showNotification('Quiz information is missing — facility index cannot be opened.', 'error');
    return Promise.resolve(false);
  }
  const subjectName = (options.subjectName || '').toString().trim() || 'General';
  const title = `Facility Index · ${quiz.title || quiz.id} · ${subjectName}`;
  const innerHtml = buildFacilityIndexPdfDocumentHtml(quiz, Array.isArray(data) ? data : [], { subjectName });
  const ok = openPrintableDocumentInNewWindow(title, innerHtml);
  if (ok && options.successMessage !== '') {
    showNotification('Facility index opened in a new tab. Use "Print > Save as PDF" for a copy.', 'success', 6000);
  }
  return Promise.resolve(ok);
}

function getTeacherSummaryQuestionCount(quiz, submissions = []) {
  const maxFromSubmissions = (submissions || []).reduce((max, item) => {
    const questionCount = Array.isArray(item?.allQuestions) ? item.allQuestions.length : 0;
    return Math.max(max, questionCount);
  }, 0);
  const configuredMax = Number(quiz && quiz.maxGrade);
  const subjectTotal = Array.isArray(quiz?.subjects) ? quiz.subjects.reduce((sum, subject) => {
    const configuredCount = Number(subject?.questionCount);
    if (Number.isFinite(configuredCount) && configuredCount > 0) return sum + configuredCount;
    const bankCount = Array.isArray(subject?.bankQuestions) ? subject.bankQuestions.length : 0;
    const questionCount = Array.isArray(subject?.questions) ? subject.questions.length : 0;
    return sum + Math.max(bankCount, questionCount);
  }, 0) : 0;
  return Math.max(maxFromSubmissions, Number.isFinite(configuredMax) ? configuredMax : 0, subjectTotal);
}

function getTeacherSummaryStatus(submission, quiz) {
  const fallback = (submission?.percent || 0) >= (quiz?.passMark || 50) ? 'Pass' : 'Fail';
  const raw = (submission?.resultStatus || fallback || '').toString().trim().toLowerCase();
  return raw === 'pass' ? 'Pass' : 'Fail';
}

function formatOrdinal(value) {
  const num = parseInt(value, 10);
  if (!Number.isFinite(num) || num <= 0) return '-';
  const mod10 = num % 10;
  const mod100 = num % 100;
  if (mod10 === 1 && mod100 !== 11) return `${num}st`;
  if (mod10 === 2 && mod100 !== 12) return `${num}nd`;
  if (mod10 === 3 && mod100 !== 13) return `${num}rd`;
  return `${num}th`;
}

function getTeacherSummaryRankTheme(rank) {
  const num = parseInt(rank, 10);
  if (!Number.isFinite(num) || num <= 0) {
    return { label: '-', bg: '#eef4ff', color: '#1f2a44', border: 'rgba(31,42,68,0.10)' };
  }
  if (num === 1) {
    return { label: formatOrdinal(num), bg: '#fff1b8', color: '#7a5400', border: 'rgba(122,84,0,0.18)' };
  }
  if (num === 2) {
    return { label: formatOrdinal(num), bg: '#edf2f7', color: '#475569', border: 'rgba(71,85,105,0.16)' };
  }
  if (num === 3) {
    return { label: formatOrdinal(num), bg: '#f7dfcf', color: '#8a4b2b', border: 'rgba(138,75,43,0.16)' };
  }
  return { label: formatOrdinal(num), bg: '#e7f0ff', color: '#1f2a44', border: 'rgba(31,42,68,0.10)' };
}

function getTeacherSummaryIcon(kind) {
  const icons = {
    users: `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M16.5 13.5A3.5 3.5 0 1 0 13 10a3.5 3.5 0 0 0 3.5 3.5Zm-9 0A3 3 0 1 0 4.5 10a3 3 0 0 0 3 3.5Zm0 1.75c-2.7 0-4.9 1.4-4.9 3.15 0 .33.27.6.6.6h7.02a5.15 5.15 0 0 1 3.37-4.68 8.02 8.02 0 0 0-2.09-.27Zm9 0c-2.93 0-5.35 1.53-5.35 3.4 0 .33.27.6.6.6h9.5a.6.6 0 0 0 .6-.6c0-1.87-2.42-3.4-5.35-3.4Z" fill="currentColor"/>
      </svg>
    `,
    chart: `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M5 19.25A1.25 1.25 0 0 1 3.75 18V5.5a.75.75 0 0 1 1.5 0v11.75H20a.75.75 0 0 1 0 1.5H5Zm3.2-3a.85.85 0 0 1-.85-.85v-4.3a.85.85 0 0 1 1.7 0v4.3a.85.85 0 0 1-.85.85Zm4.8 0a.85.85 0 0 1-.85-.85V8.2a.85.85 0 0 1 1.7 0v7.2a.85.85 0 0 1-.85.85Zm4.8 0a.85.85 0 0 1-.85-.85V6.1a.85.85 0 0 1 1.7 0v9.3a.85.85 0 0 1-.85.85Z" fill="currentColor"/>
      </svg>
    `,
    percent: `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M7.1 9.25a2.35 2.35 0 1 0 0-4.7 2.35 2.35 0 0 0 0 4.7Zm9.8 10.2a2.35 2.35 0 1 0 0-4.7 2.35 2.35 0 0 0 0 4.7ZM6.12 19.2a.75.75 0 0 1-.54-1.27L17.34 5.16a.75.75 0 1 1 1.08 1.04L6.66 18.97a.75.75 0 0 1-.54.23Z" fill="currentColor"/>
      </svg>
    `
  };
  return icons[kind] || icons.chart;
}

function getSubmissionSubjectBreakdownForDisplay(quiz, submission) {
  if (Array.isArray(submission?.subjectBreakdown) && submission.subjectBreakdown.length) return submission.subjectBreakdown;
  return computeSubmissionSubjectBreakdown(quiz, submission || {});
}

function getTeacherSummarySubjectColumns(quiz, submissions = []) {
  const seen = new Map();
  (quiz?.subjects || []).forEach((subject, index) => {
    const name = (subject?.name || `Subject ${index + 1}`).toString().trim() || `Subject ${index + 1}`;
    seen.set(normalizeSubjectName(name), name);
  });
  (submissions || []).forEach((submission) => {
    getSubmissionSubjectBreakdownForDisplay(quiz, submission).forEach((item) => {
      const key = normalizeSubjectName(item.name);
      if (!seen.has(key)) seen.set(key, item.name);
    });
  });
  return Array.from(seen.values());
}

function buildSubmissionSubjectScoreLines(quiz, submission, options = {}) {
  const joiner = options.joiner || '<br />';
  const fallback = options.fallback || 'No subject score';
  const breakdown = getSubmissionSubjectBreakdownForDisplay(quiz, submission);
  if (!breakdown.length) return fallback;
  return breakdown.map((item) => `${escapeHtml(item.name)}: ${formatScoreValue(item.score)} / ${formatScoreValue(item.totalMarks || item.total)}`).join(joiner);
}

function computeTeacherSummaryRanks(submissions = []) {
  const ordered = (submissions || []).slice().sort((a, b) =>
    (b.percent || 0) - (a.percent || 0) ||
    (a.timeSpent || 0) - (b.timeSpent || 0) ||
    (a.name || '').localeCompare(b.name || '')
  );
  // Same dual-keying scheme as computeRankingForQuiz: submissionId is the
  // authoritative key (so duplicate / blank emails don't collide), and an
  // email-keyed fallback is populated for legacy lookups.
  const ranks = {};
  ordered.forEach((item, index) => {
    const rank = index + 1;
    ranks[buildSubmissionIdentity(item, index)] = rank;
    const emailKey = normalizeEmail(item?.email);
    if (emailKey && ranks[emailKey] == null) ranks[emailKey] = rank;
  });
  return ranks;
}

function buildTeacherSummaryPdfHtml(quiz, submissions, options = {}) {
  const ranks = computeTeacherSummaryRanks(submissions);
  const questionCount = getTeacherSummaryQuestionCount(quiz, submissions);
  const totalMarks = getQuizTotalMarks(quiz);
  const avgScore = submissions.length ? Math.round(submissions.reduce((a, s) => a + (s.score || 0), 0) / submissions.length) : 0;
  const avgPercent = submissions.length ? Math.round(submissions.reduce((a, s) => a + (s.percent || 0), 0) / submissions.length) : 0;
  const institutionName = escapeHtml(((quiz && quiz.examName) || '').toString().trim());
  const quizTitle = escapeHtml(((quiz && quiz.title) || 'ENGLISH TEST').toString().trim().toUpperCase());
  const subjectColumns = getTeacherSummarySubjectColumns(quiz, submissions);
  const hasMultiSubject = subjectColumns.length > 1;
  const displayFormat = !hasMultiSubject ? 'single' : (options.format === 'separate' ? 'separate' : options.format === 'grouped' ? 'grouped' : 'grouped');
  const rowThemes = [
    { bg: '#e8f8f2', edge: '#d6efe6' },
    { bg: '#fff0e6', edge: '#ffe0d1' },
    { bg: '#f0eaff', edge: '#dfd4ff' },
    { bg: '#e7f0ff', edge: '#d5e4ff' }
  ];
  const sortedSubmissions = (submissions || []).slice().sort((left, right) => {
    const leftRank = Number(getSubmissionRank(left, ranks)) || Number.MAX_SAFE_INTEGER;
    const rightRank = Number(getSubmissionRank(right, ranks)) || Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    if ((right.percent || 0) !== (left.percent || 0)) return (right.percent || 0) - (left.percent || 0);
    return (left.name || '').localeCompare(right.name || '');
  });
  const rows = sortedSubmissions.map((s, idx) => {
    const tone = rowThemes[idx % rowThemes.length];
    const status = getTeacherSummaryStatus(s, quiz);
    const rankTheme = getTeacherSummaryRankTheme(getSubmissionRank(s, ranks) || '');
    const emailOrId = (s.email || s.registrationNo || '').toString().trim();
    const scoreBase = getSubmissionTotalMarks(s, quiz) || totalMarks || questionCount;
    const subjectBreakdown = getSubmissionSubjectBreakdownForDisplay(quiz, s);
    const averageSubjectPercent = getSubmissionAveragePercent(s, quiz);
    if (displayFormat === 'grouped') {
      return `
        <tr>
          <td class="summary-cell summary-cell-rank" style="--row-bg:${tone.bg};--row-edge:${tone.edge}">
            <span class="summary-rank-badge" style="background:${rankTheme.bg};color:${rankTheme.color};border-color:${rankTheme.border}">${escapeHtml(rankTheme.label)}</span>
          </td>
          <td class="summary-cell summary-cell-name" style="--row-bg:${tone.bg};--row-edge:${tone.edge}">
            <div class="summary-name">${escapeHtml(s.name || '') || 'Unnamed Student'}</div>
          </td>
          <td class="summary-cell summary-cell-subjects" style="--row-bg:${tone.bg};--row-edge:${tone.edge}">
            <div class="summary-subject-lines">${buildSubmissionSubjectScoreLines(quiz, s)}</div>
          </td>
          <td class="summary-cell summary-cell-score" style="--row-bg:${tone.bg};--row-edge:${tone.edge}">
            <span class="summary-score">${formatScoreValue(s.score || 0)}/${formatScoreValue(scoreBase || 0)}</span>
          </td>
          <td class="summary-cell summary-cell-percent" style="--row-bg:${tone.bg};--row-edge:${tone.edge}">
            <span class="summary-percent">${averageSubjectPercent}%</span>
          </td>
        </tr>
      `;
    }
    if (displayFormat === 'separate') {
      const subjectCells = subjectColumns.map((subjectName) => {
        const subjectEntry = subjectBreakdown.find((item) => normalizeSubjectName(item.name) === normalizeSubjectName(subjectName));
        return `
          <td class="summary-cell summary-cell-subject-score" style="--row-bg:${tone.bg};--row-edge:${tone.edge}">
            <span class="summary-score">${subjectEntry ? formatScoreValue(subjectEntry.score) : '-'}</span>
          </td>
        `;
      }).join('');
      return `
        <tr>
          <td class="summary-cell summary-cell-rank" style="--row-bg:${tone.bg};--row-edge:${tone.edge}">
            <span class="summary-rank-badge" style="background:${rankTheme.bg};color:${rankTheme.color};border-color:${rankTheme.border}">${escapeHtml(rankTheme.label)}</span>
          </td>
          <td class="summary-cell summary-cell-name" style="--row-bg:${tone.bg};--row-edge:${tone.edge}">
            <div class="summary-name">${escapeHtml(s.name || '') || 'Unnamed Student'}</div>
          </td>
          ${subjectCells}
          <td class="summary-cell summary-cell-score" style="--row-bg:${tone.bg};--row-edge:${tone.edge}">
            <span class="summary-score">${formatScoreValue(s.score || 0)}/${formatScoreValue(scoreBase || 0)}</span>
          </td>
          <td class="summary-cell summary-cell-percent" style="--row-bg:${tone.bg};--row-edge:${tone.edge}">
            <span class="summary-percent">${averageSubjectPercent}%</span>
          </td>
        </tr>
      `;
    }
    return `
      <tr>
        <td class="summary-cell summary-cell-rank" style="--row-bg:${tone.bg};--row-edge:${tone.edge}">
          <span class="summary-rank-badge" style="background:${rankTheme.bg};color:${rankTheme.color};border-color:${rankTheme.border}">${escapeHtml(rankTheme.label)}</span>
        </td>
        <td class="summary-cell summary-cell-name" style="--row-bg:${tone.bg};--row-edge:${tone.edge}">
          <div class="summary-name">${escapeHtml(s.name || '') || 'Unnamed Student'}</div>
        </td>
        <td class="summary-cell summary-cell-score" style="--row-bg:${tone.bg};--row-edge:${tone.edge}">
          <span class="summary-score">${formatScoreValue(s.score || 0)}/${formatScoreValue(scoreBase || 0)}</span>
        </td>
        <td class="summary-cell summary-cell-percent" style="--row-bg:${tone.bg};--row-edge:${tone.edge}">
          <span class="summary-percent">${clampPercent(s.percent || 0)}%</span>
        </td>
        <td class="summary-cell summary-cell-status" style="--row-bg:${tone.bg};--row-edge:${tone.edge}">
          <span class="summary-status-badge ${status === 'Pass' ? 'summary-status-pass' : 'summary-status-fail'}">${status}</span>
        </td>
      </tr>
    `;
  }).join('');
  const tableColgroup = displayFormat === 'grouped'
    ? '<colgroup><col><col><col><col><col></colgroup>'
    : displayFormat === 'separate'
      ? `<colgroup><col><col>${subjectColumns.map(() => '<col>').join('')}<col><col></colgroup>`
      : '<colgroup><col><col><col><col><col></colgroup>';
  const tableHead = displayFormat === 'grouped'
    ? `
      <tr>
        <th class="th-center">Position</th>
        <th>Name</th>
        <th>Subjects &amp; Scores</th>
        <th class="th-right">Total / ${formatScoreValue(totalMarks || questionCount || 0)}</th>
        <th class="th-right">Average</th>
      </tr>
    `
    : displayFormat === 'separate'
      ? `
        <tr>
          <th class="th-center">Position</th>
          <th>Name</th>
          ${subjectColumns.map((subjectName) => `<th class="th-right">${escapeHtml(subjectName)}</th>`).join('')}
          <th class="th-right">Total / ${formatScoreValue(totalMarks || questionCount || 0)}</th>
          <th class="th-right">Average</th>
        </tr>
      `
      : `
        <tr>
          <th class="th-center">Rank</th>
          <th>Name</th>
          <th class="th-right">Score</th>
          <th class="th-right">Percent</th>
          <th class="th-center">Status</th>
        </tr>
      `;

  return `
    <div class="summary-pdf-root ${displayFormat === 'separate' ? 'summary-pdf-separate' : displayFormat === 'grouped' ? 'summary-pdf-grouped' : ''}">
      <style>
        .summary-pdf-root{
          --navy:#1f2a44;
          --text:#263238;
          --muted:#6b7280;
          --pastel-blue:#e7f0ff;
          --pastel-mint:#e8f8f2;
          --pastel-peach:#fff0e6;
          --pastel-lavender:#f0eaff;
          --pastel-yellow:#fff7d6;
          --success-bg:#dff7e8;
          --success-text:#157347;
          --danger-bg:#ffe1e1;
          --danger-text:#b42318;
          color:var(--text);
          background:#ffffff;
          font-family:"Trebuchet MS","Segoe UI",Arial,sans-serif;
          line-height:1.45;
        }
        .summary-pdf-root *{box-sizing:border-box}
        .summary-sheet{
          width:100%;
          padding:16px 18px 18px;
          background:
            radial-gradient(circle at top left, rgba(231,240,255,0.55), transparent 36%),
            radial-gradient(circle at top right, rgba(240,234,255,0.5), transparent 34%),
            linear-gradient(180deg, #ffffff 0%, #fdfefe 100%);
          border-radius:26px;
        }
        .summary-header-card{
          margin-bottom:18px;
          padding:22px 26px 24px;
          text-align:center;
          border-radius:24px;
          background:linear-gradient(135deg, rgba(231,240,255,0.95) 0%, rgba(232,248,242,0.96) 34%, rgba(240,234,255,0.96) 68%, rgba(255,240,230,0.95) 100%);
          border:1px solid rgba(255,255,255,0.92);
          box-shadow:0 18px 34px rgba(31,42,68,0.08);
        }
        .summary-header-badge{
          display:inline-flex;
          align-items:center;
          justify-content:center;
          gap:8px;
          padding:7px 16px;
          border-radius:999px;
          background:rgba(255,255,255,0.78);
          color:var(--navy);
          font-size:11px;
          font-weight:700;
          letter-spacing:0.08em;
          text-transform:uppercase;
        }
        .summary-header-brand{
          margin:16px 0 6px;
          font-size:13px;
          font-weight:800;
          letter-spacing:0.26em;
          color:var(--navy);
        }
        .summary-header-school{
          margin:6px 0 0;
          font-size:31px;
          font-weight:800;
          letter-spacing:0.04em;
          color:var(--navy);
        }
        .summary-header-title{
          margin:0;
          font-weight:800;
          letter-spacing:0.02em;
          color:var(--navy);
        }
        .summary-header-title.with-school{font-size:20px}
        .summary-header-title.solo{font-size:30px}
        .summary-header-subtitle{
          margin:8px 0 0;
          font-size:12px;
          color:var(--muted);
          font-weight:600;
        }
        .summary-stat-grid{
          display:grid;
          grid-template-columns:repeat(3, minmax(0, 1fr));
          gap:16px;
          margin-bottom:18px;
        }
        .summary-stat-card{
          display:flex;
          align-items:center;
          gap:14px;
          padding:18px 18px 17px;
          border-radius:22px;
          border:1px solid rgba(255,255,255,0.88);
          box-shadow:0 14px 28px rgba(31,42,68,0.07);
        }
        .summary-stat-card.card-blue{background:linear-gradient(180deg, #edf4ff 0%, #e7f0ff 100%)}
        .summary-stat-card.card-mint{background:linear-gradient(180deg, #eefbf6 0%, #e8f8f2 100%)}
        .summary-stat-card.card-lavender{background:linear-gradient(180deg, #f5f1ff 0%, #f0eaff 100%)}
        .summary-stat-icon{
          width:46px;
          height:46px;
          border-radius:16px;
          display:flex;
          align-items:center;
          justify-content:center;
          color:var(--navy);
          background:rgba(255,255,255,0.76);
          box-shadow:inset 0 1px 0 rgba(255,255,255,0.6);
          flex:0 0 46px;
        }
        .summary-stat-icon svg{width:22px;height:22px;display:block}
        .summary-stat-label{
          margin:0 0 4px;
          font-size:11px;
          font-weight:700;
          color:var(--muted);
          letter-spacing:0.08em;
          text-transform:uppercase;
        }
        .summary-stat-value{
          margin:0;
          font-size:28px;
          line-height:1;
          font-weight:800;
          color:var(--navy);
          white-space:nowrap;
        }
        .summary-table-card{
          padding:18px 18px 14px;
          border-radius:24px;
          background:#ffffff;
          border:1px solid rgba(31,42,68,0.06);
          box-shadow:0 16px 30px rgba(31,42,68,0.08);
        }
        .summary-table-head{
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:16px;
          margin-bottom:12px;
        }
        .summary-table-title{
          margin:0;
          font-size:19px;
          font-weight:800;
          color:var(--navy);
        }
        .summary-table-note{
          font-size:12px;
          font-weight:600;
          color:var(--muted);
        }
        .summary-table{
          width:100%;
          border-collapse:separate;
          border-spacing:0 10px;
          table-layout:fixed;
        }
        .summary-pdf-root:not(.summary-pdf-grouped):not(.summary-pdf-separate) .summary-table col:nth-child(1){width:12%}
        .summary-pdf-root:not(.summary-pdf-grouped):not(.summary-pdf-separate) .summary-table col:nth-child(2){width:38%}
        .summary-pdf-root:not(.summary-pdf-grouped):not(.summary-pdf-separate) .summary-table col:nth-child(3){width:18%}
        .summary-pdf-root:not(.summary-pdf-grouped):not(.summary-pdf-separate) .summary-table col:nth-child(4){width:14%}
        .summary-pdf-root:not(.summary-pdf-grouped):not(.summary-pdf-separate) .summary-table col:nth-child(5){width:18%}
        .summary-pdf-grouped .summary-table col:nth-child(1){width:12%}
        .summary-pdf-grouped .summary-table col:nth-child(2){width:24%}
        .summary-pdf-grouped .summary-table col:nth-child(3){width:34%}
        .summary-pdf-grouped .summary-table col:nth-child(4){width:16%}
        .summary-pdf-grouped .summary-table col:nth-child(5){width:14%}
        .summary-table th{
          padding:0 14px 6px;
          text-align:left;
          font-size:11px;
          font-weight:800;
          letter-spacing:0.08em;
          text-transform:uppercase;
          color:var(--muted);
        }
        .summary-table th.th-right{text-align:right}
        .summary-table th.th-center{text-align:center}
        .summary-cell{
          padding:13px 14px;
          font-size:12.5px;
          vertical-align:middle;
          background:var(--row-bg);
          border-top:1px solid rgba(255,255,255,0.85);
          border-bottom:1px solid rgba(255,255,255,0.85);
          box-shadow:inset 0 1px 0 rgba(255,255,255,0.45);
        }
        .summary-cell:first-child{
          border-left:4px solid var(--row-edge);
          border-top-left-radius:18px;
          border-bottom-left-radius:18px;
        }
        .summary-cell:last-child{
          border-top-right-radius:18px;
          border-bottom-right-radius:18px;
        }
        .summary-cell-rank,
        .summary-cell-status{text-align:center}
        .summary-cell-score,
        .summary-cell-percent{text-align:right}
        .summary-name{
          font-size:14px;
          font-weight:700;
          color:var(--navy);
        }
        .summary-email{
          font-size:11.5px;
          line-height:1.4;
          color:#44515c;
          white-space:normal;
          word-break:break-word;
          overflow-wrap:break-word;
        }
        .summary-score,
        .summary-percent{
          font-size:13px;
          font-weight:800;
          color:var(--navy);
          white-space:nowrap;
        }
        .summary-subject-lines{
          font-size:12px;
          line-height:1.55;
          color:#334155;
          white-space:normal;
        }
        .summary-cell-subject-score{text-align:right}
        .summary-pdf-separate .summary-table{
          table-layout:auto;
        }
        .summary-pdf-separate .summary-table th,
        .summary-pdf-separate .summary-cell{
          padding-left:10px;
          padding-right:10px;
          font-size:11.5px;
        }
        .summary-status-badge,
        .summary-rank-badge{
          display:inline-flex;
          align-items:center;
          justify-content:center;
          min-width:74px;
          padding:7px 12px;
          border-radius:999px;
          font-size:11.5px;
          font-weight:800;
          border:1px solid transparent;
          white-space:nowrap;
        }
        .summary-status-pass{
          background:var(--success-bg);
          color:var(--success-text);
        }
        .summary-status-fail{
          background:var(--danger-bg);
          color:var(--danger-text);
        }
        .summary-empty{
          padding:18px;
          border-radius:18px;
          background:var(--pastel-yellow);
          color:var(--navy);
          text-align:center;
          font-weight:700;
        }
      </style>
      <div class="summary-sheet">
        <div class="summary-header-card">
          <div class="summary-header-badge">Generated Result Summary</div>
          <div class="summary-header-brand">OPE ASSESSOR</div>
          ${institutionName ? `<div class="summary-header-school">${institutionName}</div>` : ''}
          <h1 class="summary-header-title ${institutionName ? 'with-school' : 'solo'}">${quizTitle} &mdash; Result Summary</h1>
          <div class="summary-header-subtitle">Clean assessment broadsheet for parents, management, and school records.</div>
        </div>

        <div class="summary-stat-grid">
          <div class="summary-stat-card card-blue">
            <div class="summary-stat-icon">${getTeacherSummaryIcon('users')}</div>
            <div>
              <p class="summary-stat-label">Submissions</p>
              <p class="summary-stat-value">${submissions.length}</p>
            </div>
          </div>
          <div class="summary-stat-card card-mint">
            <div class="summary-stat-icon">${getTeacherSummaryIcon('chart')}</div>
            <div>
              <p class="summary-stat-label">Average Score</p>
              <p class="summary-stat-value">${avgScore} / ${formatScoreValue(totalMarks || questionCount || 0)}</p>
            </div>
          </div>
          <div class="summary-stat-card card-lavender">
            <div class="summary-stat-icon">${getTeacherSummaryIcon('percent')}</div>
            <div>
              <p class="summary-stat-label">Average Percent</p>
              <p class="summary-stat-value">${avgPercent}%</p>
            </div>
          </div>
        </div>

        <div class="summary-table-card">
          <div class="summary-table-head">
            <h2 class="summary-table-title">Result Broadsheet</h2>
            <div class="summary-table-note">${displayFormat === 'separate' && subjectColumns.length > 4 ? 'A4 landscape layout used automatically because the subject columns are many.' : 'A4 portrait layout with automatic page flow for clean printing.'}</div>
          </div>
          <table class="summary-table">
            ${tableColgroup}
            <thead>
              ${tableHead}
            </thead>
            <tbody>
              ${rows || `<tr><td colspan="${displayFormat === 'grouped' ? 5 : displayFormat === 'separate' ? 4 + subjectColumns.length : 5}"><div class="summary-empty">No submissions yet.</div></td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function showTeacherSummaryPdfFormatModal(quiz, submissions) {
  let modal = document.getElementById('teacherSummaryPdfFormatModal');
  if (modal) modal.remove();
  const subjectColumns = getTeacherSummarySubjectColumns(quiz, submissions);
  modal = document.createElement('div');
  modal.id = 'teacherSummaryPdfFormatModal';
  modal.className = 'student-result-modal';
  modal.innerHTML = `
    <div class="card-beautiful admin-modal-card" style="width:min(620px,94vw)">
      <div class="page-heading">
        <div>
          <div class="h2">Choose Result Summary Format</div>
          <div class="small">${escapeHtml(quiz.title || quiz.id || 'Quiz')} • ${subjectColumns.length} subjects</div>
        </div>
        <button id="closeTeacherSummaryPdfFormatModal" class="btn btn-ghost">Close</button>
      </div>
      <div class="small" style="line-height:1.7;margin-bottom:16px">Choose how you want subject scores arranged in the broadsheet PDF. Single-subject quizzes still use the normal summary automatically.</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px">
        <button id="summaryPdfGrouped" class="btn btn-secondary" style="min-height:96px;text-align:left;justify-content:flex-start">Grouped Subjects &amp; Scores</button>
        <button id="summaryPdfSeparate" class="btn btn-primary" style="min-height:96px;text-align:left;justify-content:flex-start">Separate Subject Columns</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.onclick = (event) => { if (event.target === modal) modal.remove(); };
  document.getElementById('closeTeacherSummaryPdfFormatModal').onclick = () => modal.remove();
  document.getElementById('summaryPdfGrouped').onclick = () => {
    modal.remove();
    const filename = `${makeSafeFilenamePart(quiz.title || 'result-summary', 'result-summary').toUpperCase()} RESULT (${quiz.id}) GROUPED.pdf`;
    const routePath = buildTeacherSummaryPdfRoute(quiz, { format: 'grouped' });
    const serverReady = canUseServerRoutePdfExport();
    if (serverReady) {
      downloadPdfRouteThroughServer(
        routePath,
        filename,
        'Teacher result summary PDF downloaded',
        { orientation: 'p', marginsMm: { top: 12, right: 10, bottom: 12, left: 10 } },
        { syncKeys: [STORAGE_KEYS.submissions, STORAGE_KEYS.quizzes] }
      ).catch((error) => {
        console.warn('Server teacher summary export failed. Falling back to browser rendering.', error);
        downloadPdfFromHtml(
          buildTeacherSummaryPdfHtml(quiz, submissions, { format: 'grouped' }),
          filename,
          'Teacher result summary PDF downloaded',
          { orientation: 'p', singlePage: false, marginMm: 8, paddingPx: 10, sourceWidthPx: 794, disableServerHtmlExport: true }
        );
      });
      return;
    }
    downloadPdfFromHtml(
      buildTeacherSummaryPdfHtml(quiz, submissions, { format: 'grouped' }),
      filename,
      'Teacher result summary PDF downloaded',
      { orientation: 'p', singlePage: false, marginMm: 8, paddingPx: 10, sourceWidthPx: 794 }
    );
  };
  document.getElementById('summaryPdfSeparate').onclick = () => {
    modal.remove();
    const useLandscape = subjectColumns.length > 4;
    const filename = `${makeSafeFilenamePart(quiz.title || 'result-summary', 'result-summary').toUpperCase()} RESULT (${quiz.id}) SEPARATE.pdf`;
    const routePath = buildTeacherSummaryPdfRoute(quiz, { format: 'separate' });
    const serverReady = canUseServerRoutePdfExport();
    if (serverReady) {
      downloadPdfRouteThroughServer(
        routePath,
        filename,
        'Teacher result summary PDF downloaded',
        { orientation: useLandscape ? 'l' : 'p', marginsMm: { top: 12, right: 10, bottom: 12, left: 10 } },
        { syncKeys: [STORAGE_KEYS.submissions, STORAGE_KEYS.quizzes] }
      ).catch((error) => {
        console.warn('Server teacher summary export failed. Falling back to browser rendering.', error);
        downloadPdfFromHtml(
          buildTeacherSummaryPdfHtml(quiz, submissions, { format: 'separate' }),
          filename,
          'Teacher result summary PDF downloaded',
          { orientation: useLandscape ? 'l' : 'p', singlePage: false, marginMm: 8, paddingPx: 10, sourceWidthPx: useLandscape ? 1120 : 794, disableServerHtmlExport: true }
        );
      });
      return;
    }
    downloadPdfFromHtml(
      buildTeacherSummaryPdfHtml(quiz, submissions, { format: 'separate' }),
      filename,
      'Teacher result summary PDF downloaded',
      { orientation: useLandscape ? 'l' : 'p', singlePage: false, marginMm: 8, paddingPx: 10, sourceWidthPx: useLandscape ? 1120 : 794 }
    );
  };
}

function getScoreTone(percent) {
  const p = parseFloat(percent || 0) || 0;
  if (p >= 70) return { key: 'good', color: '#059669', soft: '#ECFDF5' };
  if (p >= 50) return { key: 'warn', color: '#D97706', soft: '#FFFBEB' };
  return { key: 'bad', color: '#DC2626', soft: '#FEF2F2' };
}

function getPerformanceBandLabel(percent) {
  const value = clampPercent(percent);
  if (value >= 91) return 'Excellent';
  if (value >= 81) return 'Very Good';
  if (value >= 71) return 'Good';
  if (value >= 61) return 'Credit';
  if (value >= 50) return 'Pass';
  if (value >= 45) return 'Borderline';
  if (value >= 40) return 'Poor';
  return 'Fail';
}

function getCertificateGradeProfile(percent) {
  const value = clampPercent(percent);
  if (value >= 91) return { label: 'Excellent', range: '91 - 100', remark: 'You have shown outstanding mastery with very high accuracy and a complete understanding of the work.' };
  if (value >= 81) return { label: 'Very Good', range: '81 - 90', remark: 'You have shown strong performance with solid understanding and only minor errors.' };
  if (value >= 71) return { label: 'Good', range: '71 - 80', remark: 'You have shown above average performance and you understand most concepts, though a few gaps still remain.' };
  if (value >= 61) return { label: 'Credit', range: '61 - 70', remark: 'You have met the required standard with a satisfactory and reasonable understanding of the work.' };
  if (value >= 50) return { label: 'Pass', range: '50 - 60', remark: 'You have shown basic acceptable performance, but you still need noticeable improvement.' };
  if (value >= 45) return { label: 'Borderline', range: '45 - 49', remark: 'You have partial understanding, but you need significant revision to become more secure.' };
  if (value >= 40) return { label: 'Poor', range: '40 - 44', remark: 'You have major gaps at the moment and you need clear remedial support and extra practice.' };
  return { label: 'Fail', range: '0 - 39', remark: 'You have not yet met the minimum standard, so you need serious revision and closer support.' };
}

function formatScoreValue(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';
  return Number.isInteger(num) ? String(num) : num.toFixed(2).replace(/\.?0+$/, '');
}

function clampPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function normalizeCertificateSignatories(signatories = []) {
  return (Array.isArray(signatories) ? signatories : []).map((item) => {
    if (typeof item === 'string') return { name: item.trim(), title: '', showNameOnCertificate: true };
    return {
      name: (item && item.name ? item.name : '').toString().trim(),
      title: (item && item.title ? item.title : '').toString().trim(),
      showNameOnCertificate: item && item.showNameOnCertificate === false ? false : true
    };
  }).filter((item) => item.name || item.title);
}

function hasManualScoreOverride(submission) {
  if (!submission || submission.manualScoreOverride === '' || submission.manualScoreOverride == null) return false;
  return Number.isFinite(Number(submission.manualScoreOverride));
}

function submissionHasPendingEssay(submission) {
  if (!submission || !Array.isArray(submission.allQuestions)) return false;
  const answers = submission.answers || {};
  const essayScores = submission.essayScores || {};
  return submission.allQuestions.some((question, index) => {
    if (normalizeQuestionType(question && question.type) !== 'essay') return false;
    const ans = (answers[index] || '').toString().trim();
    if (!ans) return false; // unanswered essay doesn't need grading
    const sid = (question && question._sourceId) || makeQuestionId(question, index);
    const recorded = essayScores[sid];
    return recorded == null || !Number.isFinite(Number(recorded));
  });
}

function buildSubmissionGradeState(submission, quiz, baseGrade = gradeSubmissionForQuiz(submission, quiz)) {
  const passMark = parseFloat((quiz && quiz.passMark) || submission.passMark || 50) || 50;
  const pending = submissionHasPendingEssay(submission);
  if (!hasManualScoreOverride(submission)) {
    return {
      ...baseGrade,
      passMark,
      // If any essay answer is awaiting the teacher's manual score, the
      // overall status is "Pending Review" rather than Pass/Fail.
      resultStatus: pending ? 'Pending Review' : (baseGrade.percent >= passMark ? 'Pass' : 'Fail'),
      manualOverride: false,
      pendingEssayReview: pending
    };
  }
  const maxScore = getQuizTotalMarks(quiz, submission.allQuestions || []);
  const roundedScore = Math.round(Number(submission.manualScoreOverride) * 100) / 100;
  const score = Math.max(0, Math.min(maxScore, roundedScore));
  const percent = maxScore ? clampPercent((score / maxScore) * 100) : 0;
  const averagePercent = baseGrade.subjectBreakdown && baseGrade.subjectBreakdown.length
    ? Math.round(baseGrade.subjectBreakdown.reduce((sum, item) => sum + (item.percent || 0), 0) / baseGrade.subjectBreakdown.length)
    : percent;
  return {
    ...baseGrade,
    score,
    percent,
    totalMarks: maxScore,
    averagePercent,
    passMark,
    resultStatus: percent >= passMark ? 'Pass' : 'Fail',
    manualOverride: true,
    pendingEssayReview: false
  };
}

// Build an inline essay-grading panel that lists every essay answer in this
// submission with the student's text and a numeric "Score: __ / N" input.
// Saved scores live on `submission.essayScores[sourceId]`. Saving regrades
// the submission and re-syncs.
function buildEssayGradingPanelHtml(quiz, submission) {
  const questions = Array.isArray(submission && submission.allQuestions) ? submission.allQuestions : [];
  const answers = (submission && submission.answers) || {};
  const essayScores = (submission && submission.essayScores) || {};
  const essayComments = (submission && submission.essayComments) || {};
  const breakdown = computeSubmissionSubjectBreakdown(quiz, submission);
  const subjectMaxBySection = new Map();
  breakdown.forEach((section) => subjectMaxBySection.set(normalizeSubjectName(section.name), section.markPerQuestion || 0));
  const essayItems = [];
  questions.forEach((q, index) => {
    if (normalizeQuestionType(q && q.type) !== 'essay') return;
    const studentAnswer = (answers[index] || '').toString();
    if (!studentAnswer.trim()) return;
    const sid = (q && q._sourceId) || makeQuestionId(q, index);
    const sectionName = normalizeSubjectName(q.subject || q._subject || 'General');
    const maxMarks = Math.round((subjectMaxBySection.get(sectionName) || 1) * 100) / 100 || 1;
    const recorded = essayScores[sid];
    const comment = essayComments[sid] || '';
    essayItems.push({ index, sourceId: sid, question: q, studentAnswer, maxMarks, recorded, comment });
  });
  if (!essayItems.length) return '';
  const rows = essayItems.map((item) => `
    <div class="card-beautiful essay-grade-row" data-source-id="${escapeHtml(item.sourceId)}" style="padding:14px;margin-top:12px">
      <div class="small" style="color:#475569;margin-bottom:4px">Question ${item.index + 1} • Long Answer (Essay)</div>
      <div class="rich-text-output" style="margin-bottom:8px;font-weight:600">${renderRichTextHtml(item.question.question || '')}</div>
      <div class="small" style="color:#475569">Student answer:</div>
      <div style="white-space:pre-wrap;border:1px solid #E2E8F0;border-radius:10px;padding:10px;background:#F8FAFC;margin-top:6px;line-height:1.55">${escapeHtml(item.studentAnswer)}</div>
      <div style="display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap">
        <label class="small">Score</label>
        <input type="number" min="0" max="${item.maxMarks}" step="0.5" class="input-beautiful essay-grade-score" value="${item.recorded != null && Number.isFinite(Number(item.recorded)) ? Number(item.recorded) : ''}" style="max-width:120px" />
        <span class="small">/ ${item.maxMarks}</span>
      </div>
      <div style="margin-top:10px">
        <label class="small">Remarks / comments for the student</label>
        <textarea class="input-beautiful essay-grade-comment" rows="3" placeholder="Feedback the student will see in their result and the correction PDF.">${escapeHtml(item.comment || '')}</textarea>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn btn-primary btn-sm essay-grade-save">Save Score &amp; Remarks</button>
      </div>
    </div>
  `).join('');
  return `
    <div class="card-beautiful" id="essayGradingPanel" style="margin-top:18px;padding:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div>
          <div class="h3" style="margin:0">Essay Grading</div>
          <div class="small" style="margin-top:6px;color:#475569;line-height:1.55">
            Long-answer questions are not auto-marked. Enter a score and remarks for each essay, then click Save.
            The student's overall result stays "Pending Review" until every essay has a score.
            Remarks are visible to the student on their result screen and inside the correction PDF.
          </div>
        </div>
        <button type="button" id="essayGradeDownloadDoc" class="btn btn-secondary btn-sm">Download Essays (Word .doc)</button>
      </div>
      ${rows}
    </div>
  `;
}

function wireEssayGradingPanel(quiz, submission) {
  const panel = document.getElementById('essayGradingPanel');
  if (!panel) return;
  panel.querySelectorAll('.essay-grade-row').forEach((row) => {
    const sourceId = row.dataset.sourceId || '';
    const scoreInput = row.querySelector('.essay-grade-score');
    const commentInput = row.querySelector('.essay-grade-comment');
    const saveBtn = row.querySelector('.essay-grade-save');
    if (!sourceId || !scoreInput || !saveBtn) return;
    saveBtn.onclick = () => {
      const raw = (scoreInput.value || '').toString().trim();
      const numeric = raw === '' ? null : Number(raw);
      if (raw !== '' && (!Number.isFinite(numeric) || numeric < 0)) {
        showNotification('Enter a valid score (0 or higher).', 'error');
        return;
      }
      const commentValue = commentInput ? (commentInput.value || '').toString() : '';
      // Update the source-of-truth submission stored in localStorage so the
      // grade survives reloads and sync.
      const all = getAllSubmissions();
      const idx = findSubmissionIndexByIdentity(all, submission.quizId, submission.email, submission.submittedAt || '');
      if (idx < 0) {
        showNotification('Could not locate this submission in storage.', 'error');
        return;
      }
      const target = { ...all[idx] };
      target.essayScores = { ...(target.essayScores || {}) };
      target.essayComments = { ...(target.essayComments || {}) };
      if (numeric == null) delete target.essayScores[sourceId];
      else target.essayScores[sourceId] = numeric;
      const trimmedComment = commentValue.trim();
      if (!trimmedComment) delete target.essayComments[sourceId];
      else target.essayComments[sourceId] = commentValue;
      const grade = buildSubmissionGradeState(target, quiz);
      applyGradeToSubmission(target, grade);
      target.updatedAt = new Date().toISOString();
      all[idx] = target;
      saveAllSubmissions(all);
      // Reflect on the in-memory submission too.
      submission.essayScores = target.essayScores;
      submission.essayComments = target.essayComments;
      applyGradeToSubmission(submission, grade);
      // Per-quiz submissions push (bulk submissions PUT is blocked for teachers).
      if (submission.quizId) {
        const quizSubs = getAllSubmissions({ includeDeleted: true }).filter((s) => s && s.quizId === submission.quizId);
        pushSingleQuizSubmissionsToCloud(submission.quizId, quizSubs).catch(() => {});
      }
      showNotification('Essay score & remarks saved.', 'success', 4000);
      // Re-render the result modal to refresh score / Pending Review status.
      const modal = document.getElementById('studentResultModal');
      if (modal) modal.remove();
      showStudentResultModalFromSubmission(quiz, target, true);
    };
  });
  const downloadBtn = document.getElementById('essayGradeDownloadDoc');
  if (downloadBtn) downloadBtn.onclick = () => downloadSubmissionEssaysAsDoc(submission, quiz);
}

// Download every essay answer in a submission as a Word-readable .doc file.
// Uses the long-standing Word HTML format trick (application/msword + an
// HTML body) — works in MS Word, Google Docs, LibreOffice, and on phones.
function downloadSubmissionEssaysAsDoc(submission, quiz) {
  if (!submission) return showNotification('No submission to export.', 'error');
  const questions = Array.isArray(submission.allQuestions) ? submission.allQuestions : [];
  const answers = submission.answers || {};
  const essayScores = submission.essayScores || {};
  const essayComments = submission.essayComments || {};
  const breakdown = computeSubmissionSubjectBreakdown(quiz, submission);
  const maxBySection = new Map();
  breakdown.forEach((s) => maxBySection.set(normalizeSubjectName(s.name), s.markPerQuestion || 0));
  const essays = questions.map((q, idx) => ({ q, idx })).filter(({ q, idx }) => {
    if (normalizeQuestionType(q && q.type) !== 'essay') return false;
    return (answers[idx] || '').toString().trim();
  });
  if (!essays.length) {
    showNotification('No essay answers in this submission to download.', 'info');
    return;
  }
  const studentName = (submission.name || submission.email || 'Student').toString();
  const studentEmail = (submission.email || submission.registrationNo || '').toString();
  const quizTitle = (quiz && (quiz.title || quiz.id)) || submission.quizId || 'Quiz';
  const submittedAt = submission.submittedAt ? new Date(submission.submittedAt).toLocaleString() : '';
  const essayBlocks = essays.map(({ q, idx }) => {
    const sid = (q && q._sourceId) || makeQuestionId(q, idx);
    const sectionName = normalizeSubjectName(q.subject || q._subject || 'General');
    const maxMarks = Math.round((maxBySection.get(sectionName) || 1) * 100) / 100 || 1;
    const score = essayScores[sid];
    const comment = essayComments[sid] || '';
    const studentAnswer = (answers[idx] || '').toString();
    return `
      <h2 style="font-size:14pt;margin:18pt 0 6pt 0">Question ${idx + 1}</h2>
      <p style="font-weight:bold;margin:0 0 8pt 0">${escapeHtml(getRichTextPlainText(q.question || ''))}</p>
      <p style="margin:0 0 4pt 0;font-size:11pt;color:#444">Subject: ${escapeHtml(q.subject || q._subject || 'General')} &nbsp;|&nbsp; Max marks: ${maxMarks} &nbsp;|&nbsp; Score: ${score != null && Number.isFinite(Number(score)) ? Number(score) : 'Not graded yet'}</p>
      <div style="white-space:pre-wrap;border:1pt solid #888;padding:10pt;margin-bottom:6pt;line-height:1.5;font-size:12pt">${escapeHtml(studentAnswer)}</div>
      ${comment ? `<p style="margin:6pt 0 0 0;font-size:11pt"><strong>Teacher remarks:</strong> ${escapeHtml(comment)}</p>` : ''}
    `;
  }).join('');
  const doc = `
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(`${studentName} — Essay Answers`)}</title>
  <!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
  <style>
    body { font-family: Calibri, Arial, sans-serif; font-size: 12pt; color: #000; line-height: 1.5; }
    h1 { font-size: 18pt; margin: 0 0 10pt 0; }
    p { margin: 0 0 6pt 0; }
    @page { size: A4; margin: 1in; }
  </style>
</head>
<body>
  <h1>Essay Answers — ${escapeHtml(quizTitle)}</h1>
  <p>Student: <strong>${escapeHtml(studentName)}</strong></p>
  ${studentEmail ? `<p>Email / ID: ${escapeHtml(studentEmail)}</p>` : ''}
  ${submittedAt ? `<p>Submitted: ${escapeHtml(submittedAt)}</p>` : ''}
  <hr />
  ${essayBlocks}
</body>
</html>
  `.trim();
  const blob = new Blob(['﻿', doc], { type: 'application/msword' });
  const safeName = `${studentName} - essays - ${quizTitle}`.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
  const filename = `${safeName || 'essays'}.doc`;
  if (typeof saveAs === 'function') {
    saveAs(blob, filename);
  } else {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
  }
  showNotification('Essay answers downloaded as Word document.', 'success', 5000);
}

function applyGradeToSubmission(submission, grade) {
  submission.score = grade.score;
  submission.percent = grade.percent;
  submission.totalMarks = grade.totalMarks;
  submission.averagePercent = grade.averagePercent;
  submission.correctCount = grade.correctCount;
  submission.wrongCount = grade.wrongCount;
  submission.attemptedCount = grade.attemptedCount;
  submission.negativePenalty = grade.negativePenalty;
  submission.subjectBreakdown = Array.isArray(grade.subjectBreakdown) ? grade.subjectBreakdown.map((item) => ({ ...item })) : [];
  submission.passMark = grade.passMark;
  submission.resultStatus = grade.resultStatus;
  submission.pendingEssayReview = !!grade.pendingEssayReview;
}

function buildCertificateBrandMarkup() {
  return `
    <div class="cert-brand-lockup" aria-label="OPE Assessor logo">
      <div class="cert-logo-badge"><img src="${APP_LOGO_SRC}" alt="OPE Assessor logo" /></div>
      <div class="cert-logo-text">
        <strong>OPE Assessor</strong>
        <span>Verified Result Certificate</span>
      </div>
    </div>
  `;
}

function buildCertificateSignatureSvg(item, index = 0) {
  const rawName = ((item && item.name) || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Signature';
  const chars = rawName.slice(0, 28).split('');
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  let x = 10;
  let path = 'M 10 36';
  const accentParts = [];
  let drawnLetters = 0;

  chars.forEach((char, idx) => {
    if (char === ' ') {
      x += 7;
      return;
    }
    const upper = char.toUpperCase();
    const code = upper.charCodeAt(0);
    const isWordStart = idx === 0 || chars[idx - 1] === ' ';
    const hasAscender = /[BDFHKLT]/.test(upper);
    const hasDescender = /[GJPQY]/.test(upper);
    const rounded = /[COAESUG]/.test(upper);
    const wide = /[MW]/.test(upper);
    const narrow = /[IJT]/.test(upper);
    const looped = /[ABDEGOPQR]/.test(upper);
    const width = isWordStart ? 15 : wide ? 13 : narrow ? 8.5 : 10.5;
    const topY = isWordStart ? 8 + (code % 3) : hasAscender ? 12 + (code % 4) : rounded ? 19 + (code % 3) : 16 + (code % 4);
    const midY = 28 + ((code + idx) % 5) - 2;
    const baseY = hasDescender ? 43 + (code % 2) : 33 + (code % 4);

    if (isWordStart) {
      path += ` C ${x + 1.5} 31, ${x + 1.5} ${topY}, ${x + 5} ${topY}`;
      path += ` C ${x + 8.5} ${topY + 1.5}, ${x + 7.2} ${midY}, ${x + 4.8} ${baseY - 1}`;
      accentParts.push(`M ${x + 4} ${midY - 5} C ${x + 6} ${topY + 1}, ${x + 10} ${topY + 2}, ${x + 10.5} ${midY - 1}`);
    } else {
      path += ` C ${x + width * 0.18} ${midY - 6}, ${x + width * 0.2} ${topY}, ${x + width * 0.34} ${topY + 1}`;
    }

    path += ` C ${x + width * 0.5} ${topY + 8}, ${x + width * 0.42} ${baseY}, ${x + width * 0.62} ${baseY - 1}`;
    path += ` C ${x + width * 0.82} ${baseY - 2}, ${x + width * 0.78} ${midY - 2}, ${x + width} ${midY + ((code % 3) - 1)}`;

    if (looped && !isWordStart) {
      accentParts.push(`M ${x + width * 0.28} ${midY - 1} C ${x + width * 0.4} ${topY + 4}, ${x + width * 0.58} ${topY + 5}, ${x + width * 0.58} ${midY + 1}`);
    }

    x += width;
    drawnLetters += 1;
  });

  const flourishEndX = clamp(x + 18, 158, 208);
  const flourishStartX = clamp(18 + drawnLetters * 1.5, 28, 74);
  const flourish = `M ${flourishStartX} 39 C ${clamp(flourishStartX + 26, 40, 92)} 43, ${clamp(flourishEndX - 42, 92, 164)} 43, ${flourishEndX} ${clamp(29 + ((index + drawnLetters) % 4), 28, 34)}`;
  const accent = accentParts.join(' ');
  return `
    <svg class="cert-signature-svg" viewBox="0 0 224 56" aria-hidden="true" focusable="false">
      <path d="${path}" fill="none" stroke="#101821" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="${flourish}" fill="none" stroke="#101821" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.92"/>
      ${accent ? `<path d="${accent}" fill="none" stroke="#101821" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" opacity="0.62"/>` : ''}
    </svg>
  `;
}

function buildCertificateVerificationUrl(quiz, submission, options = {}) {
  const pdfBootstrap = getPdfBootstrapPayload();
  const configuredBase = pdfBootstrap && pdfBootstrap.verificationBaseUrl
    ? pdfBootstrap.verificationBaseUrl
    : '';
  const base = (configuredBase || window.location.href.split('?')[0]).toString().replace(/\?.*$/, '');
  const shareKey = getSubmissionShareKey(submission);
  const params = new URLSearchParams();
  params.set('r', shareKey);
  if (options.downloadCorrection) params.set('c', '1');
  const correctionSubject = (options.correctionSubject || '').toString().trim();
  if (correctionSubject) params.set('s', correctionSubject);
  return `${base}?${params.toString()}`;
}

function buildCertificateVerificationQrSvg(url) {
  try {
    if (typeof window === 'undefined' || typeof window.qrcode !== 'function' || !url) return '';
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    return qr.createSvgTag(3, 0);
  } catch (error) {
    console.warn('QR generation failed', error);
    return '';
  }
}

function renderCertificateVerificationMarkup(quiz, submission) {
  const url = buildCertificateVerificationUrl(quiz, submission);
  const pdfBootstrap = getPdfBootstrapPayload();
  const qrSvg = (pdfBootstrap && pdfBootstrap.verificationQrSvg) || buildCertificateVerificationQrSvg(url);
  const shareKey = getSubmissionShareKey(submission, { persist: false }).toUpperCase();
  const submittedAt = submission?.submittedAt ? new Date(submission.submittedAt).toLocaleString() : 'N/A';
  return `
    <div class="cert-verification">
      <div class="cert-verification-copy">
        <div class="cert-verification-label">RESULT AUTHENTICATION</div>
        <div class="cert-verification-text">Scan the QR code to reopen this verified result directly in OPE Assessor.</div>
        <div class="cert-verification-text"><strong>Reference:</strong> ${escapeHtml(shareKey)}<br><strong>Submitted:</strong> ${escapeHtml(submittedAt)}</div>
      </div>
      <div class="cert-verification-qr" aria-label="Certificate verification QR code">
        ${qrSvg || '<div class="cert-verification-fallback">QR unavailable</div>'}
      </div>
    </div>
  `;
}

function renderCertificateSignatories(signatories = []) {
  const items = normalizeCertificateSignatories(signatories);
  if (!items.length) return '';
  return `
    <div class="cert-signatures">
      ${items.map((item, index) => {
        const seed = item.name.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
        const tilt = (((seed + index * 17) % 11) - 5) * 0.6;
        return `
          <div class="cert-signature-card">
            <div class="cert-signature-script" style="transform:rotate(${tilt}deg)">${buildCertificateSignatureSvg(item, index)}</div>
            <span></span>
            ${item.showNameOnCertificate && item.name ? `<p class="cert-signatory-name">${escapeHtml(item.name)}</p>` : ''}
            ${item.title ? `<div class="cert-signatory-title">${escapeHtml(item.title)}</div>` : ''}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function getSubmissionTotalMarks(submission, quiz) {
  if (Number.isFinite(Number(submission?.totalMarks)) && Number(submission.totalMarks) > 0) {
    return Math.round(Number(submission.totalMarks) * 100) / 100;
  }
  const breakdown = Array.isArray(submission?.subjectBreakdown) && submission.subjectBreakdown.length
    ? submission.subjectBreakdown
    : computeSubmissionSubjectBreakdown(quiz, submission || {});
  const total = breakdown.reduce((sum, item) => sum + (item.totalMarks || 0), 0);
  return total > 0 ? Math.round(total * 100) / 100 : getQuizTotalMarks(quiz, submission?.allQuestions || []);
}

function getSubmissionAveragePercent(submission, quiz) {
  if (Number.isFinite(Number(submission?.averagePercent))) return Math.round(Number(submission.averagePercent));
  const breakdown = Array.isArray(submission?.subjectBreakdown) && submission.subjectBreakdown.length
    ? submission.subjectBreakdown
    : computeSubmissionSubjectBreakdown(quiz, submission || {});
  if (!breakdown.length) return clampPercent(submission?.percent || 0);
  return Math.round(breakdown.reduce((sum, item) => sum + (item.percent || 0), 0) / breakdown.length);
}

function buildStudentTopicBreakdownHtml(quiz, submission) {
  if (!quiz?.showTopicsAfterSubmission) return '';
  const subjectBreakdown = computeSubmissionTopicBreakdown(quiz, submission);
  const visibleSubjects = subjectBreakdown.filter((item) => Array.isArray(item.topics) && item.topics.length);
  if (!visibleSubjects.length) return '';
  return `
    <div id="topicBreakdown" class="cert-topic-section">
      <div class="cert-section-ribbon cert-section-ribbon-secondary">TOPIC BREAKDOWN</div>
      <div class="cert-topic-groups">
        ${visibleSubjects.map((subjectEntry) => `
          <div class="cert-topic-group avoid-break">
            <div class="cert-topic-group-title">${escapeHtml(sanitizeScientificText(subjectEntry.subjectName || 'General'))}</div>
            <div class="cert-topic-list">
              ${subjectEntry.topics.map((topic) => {
                const total = Number(topic.total || 0) || 0;
                const correct = Number(topic.correct || topic.passed || 0) || 0;
                const attempted = Number(topic.attempted || 0) || 0;
                const wrong = Number(topic.wrong || Math.max(0, attempted - correct)) || 0;
                const unanswered = Number(topic.unanswered || Math.max(0, total - attempted)) || 0;
                const percent = Number(topic.percent || (total ? Math.round((correct / total) * 100) : 0)) || 0;
                return `
                  <div class="cert-topic-card avoid-break">
                    <div class="cert-topic-head">
                      <div class="cert-topic-name">${escapeHtml(sanitizeScientificText(topic.name || 'General'))}</div>
                      <div class="cert-topic-percent">${percent}%</div>
                    </div>
                    <div class="cert-topic-bar"><i style="width:${Math.max(0, Math.min(100, percent))}%"></i></div>
                    <div class="cert-topic-meta">${correct} correct • ${wrong} wrong • ${unanswered} unanswered • ${total} total</div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function getResultInfoIconSvg(kind = 'file') {
  const icons = {
    submitted: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 2.75a.75.75 0 0 1 1.5 0V4h7V2.75a.75.75 0 0 1 1.5 0V4h1.25A2.75 2.75 0 0 1 21 6.75v11.5A2.75 2.75 0 0 1 18.25 21H5.75A2.75 2.75 0 0 1 3 18.25V6.75A2.75 2.75 0 0 1 5.75 4H7V2.75ZM4.5 9.5v8.75c0 .69.56 1.25 1.25 1.25h12.5c.69 0 1.25-.56 1.25-1.25V9.5H4.5Zm1.25-4C5.06 5.5 4.5 6.06 4.5 6.75V8h15V6.75c0-.69-.56-1.25-1.25-1.25H5.75Z" fill="currentColor"/></svg>`,
    answered: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 2.5a9.5 9.5 0 1 0 9.5 9.5A9.51 9.51 0 0 0 12 2.5Zm4.02 7.94-4.77 5.24a.75.75 0 0 1-1.1.03L7.7 13.36a.75.75 0 1 1 1.1-1.02l1.9 2.04 4.2-4.62a.75.75 0 1 1 1.12 1.01Z" fill="currentColor"/></svg>`,
    email: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4.75 5A2.75 2.75 0 0 0 2 7.75v8.5A2.75 2.75 0 0 0 4.75 19h14.5A2.75 2.75 0 0 0 22 16.25v-8.5A2.75 2.75 0 0 0 19.25 5H4.75Zm0 1.5h14.5c.43 0 .8.22 1.02.55l-7 4.95a2.25 2.25 0 0 1-2.54 0l-7-4.95c.22-.33.59-.55 1.02-.55Zm-1.25 9.75V8.83l6.34 4.48a3.75 3.75 0 0 0 4.32 0l6.34-4.48v7.42c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25Z" fill="currentColor"/></svg>`,
    quiz: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7.75 3A2.75 2.75 0 0 0 5 5.75v12.5A2.75 2.75 0 0 0 7.75 21h8.5A2.75 2.75 0 0 0 19 18.25V8.81a2.75 2.75 0 0 0-.81-1.94l-2.06-2.06A2.75 2.75 0 0 0 14.19 4H7.75Zm0 1.5h6.19c.33 0 .65.13.88.37l2.06 2.06c.23.23.37.55.37.88v10.44c0 .69-.56 1.25-1.25 1.25h-8.5c-.69 0-1.25-.56-1.25-1.25V5.75c0-.69.56-1.25 1.25-1.25Zm1.5 6.25a.75.75 0 0 1 .75-.75h4a.75.75 0 0 1 0 1.5h-4a.75.75 0 0 1-.75-.75Zm0 3.5a.75.75 0 0 1 .75-.75h4a.75.75 0 0 1 0 1.5h-4a.75.75 0 0 1-.75-.75Z" fill="currentColor"/></svg>`,
    device: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7.75 2h8.5A2.75 2.75 0 0 1 19 4.75v14.5A2.75 2.75 0 0 1 16.25 22h-8.5A2.75 2.75 0 0 1 5 19.25V4.75A2.75 2.75 0 0 1 7.75 2Zm0 1.5c-.69 0-1.25.56-1.25 1.25v14.5c0 .69.56 1.25 1.25 1.25h8.5c.69 0 1.25-.56 1.25-1.25V4.75c0-.69-.56-1.25-1.25-1.25h-8.5Zm2.5 2.25h3.5a.75.75 0 0 1 0 1.5h-3.5a.75.75 0 0 1 0-1.5Zm1.75 11.5a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2Z" fill="currentColor"/></svg>`,
    performance: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 2.5c-1.33 0-2.42.93-2.68 2.18a2.75 2.75 0 0 0-2.64 2.37 2.75 2.75 0 0 0-1.63 4.75 2.75 2.75 0 0 0 1.63 4.75 2.75 2.75 0 0 0 2.64 2.37A2.75 2.75 0 0 0 12 21.5c1.33 0 2.42-.93 2.68-2.18a2.75 2.75 0 0 0 2.64-2.37 2.75 2.75 0 0 0 1.63-4.75 2.75 2.75 0 0 0-1.63-4.75 2.75 2.75 0 0 0-2.64-2.37A2.75 2.75 0 0 0 12 2.5Zm0 6a3.5 3.5 0 1 1-3.5 3.5A3.5 3.5 0 0 1 12 8.5Z" fill="currentColor"/></svg>`
  };
  return icons[kind] || icons.quiz;
}

function buildPrimaryCertificateSignatureMarkup(quiz = {}) {
  const primary = normalizeCertificateSignatories(quiz.certificateSignatories)[0] || {
    name: getTeacherSignatureLabel(quiz.teacherId || state.teacherId),
    title: 'Teacher',
    showNameOnCertificate: true
  };
  const name = (primary.name || getTeacherSignatureLabel(quiz.teacherId || state.teacherId) || 'Teacher').toString().trim();
  const title = (primary.title || 'Teacher').toString().trim();
  return `
    <div class="cert-signature-block avoid-break">
      <div class="cert-signature-script">${buildCertificateSignatureSvg(primary, 0)}</div>
      <div class="cert-signature-line"></div>
      <div class="cert-signature-name">${escapeHtml(name.toUpperCase())}</div>
      <div class="cert-signature-role">${escapeHtml(title)}</div>
    </div>
  `;
}

function buildStudentResultSupplementHtml(quiz, submission) {
  const breakdown = Array.isArray(submission?.subjectBreakdown) && submission.subjectBreakdown.length
    ? submission.subjectBreakdown
    : computeSubmissionSubjectBreakdown(quiz, submission);
  const items = breakdown.length ? breakdown : [{
    name: getQuestionSubjectLabel((submission.allQuestions || [])[0] || {}),
    score: submission.score || 0,
    totalMarks: getSubmissionTotalMarks(submission, quiz),
    percent: getSubmissionAveragePercent(submission, quiz),
    correct: submission.correctCount || 0,
    attempted: submission.attemptedCount || 0,
    total: (submission.allQuestions || []).length,
    wrong: submission.wrongCount || 0
  }];
  const performanceHtml = items.length ? `
    <div class="cert-performance-section avoid-break">
      <div class="cert-section-ribbon cert-section-ribbon-secondary">PERFORMANCE SUMMARY</div>
      <div class="cert-performance-list ${items.length === 1 ? 'single' : ''}">
        ${items.map((item) => `
          <div class="cert-performance-card avoid-break">
            <div class="cert-performance-icon">${getResultInfoIconSvg('performance')}</div>
            <div class="cert-performance-copy">
              <div class="cert-performance-subject">${escapeHtml(sanitizeScientificText(item.name || 'General'))}</div>
              <div class="cert-performance-score">${formatScoreValue(item.score)} / ${formatScoreValue(item.totalMarks || item.total)} • ${item.percent || 0}%</div>
              <div class="cert-performance-meta">${item.correct || 0} correct • ${item.attempted || 0} attempted • ${item.total || 0} total${item.wrong ? ` • ${item.wrong} wrong` : ''}</div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  ` : '';
  const topicBreakdownHtml = buildStudentTopicBreakdownHtml(quiz, submission);
  const essayFeedbackHtml = buildStudentEssayFeedbackHtml(quiz, submission);
  return `${performanceHtml}${topicBreakdownHtml}${essayFeedbackHtml}`;
}

// Per-essay feedback shown on the student's result screen — score awarded
// and the teacher's remarks. Only renders if the submission has at least one
// essay answer.
function buildStudentEssayFeedbackHtml(quiz, submission) {
  const questions = Array.isArray(submission && submission.allQuestions) ? submission.allQuestions : [];
  const answers = (submission && submission.answers) || {};
  const essayScores = (submission && submission.essayScores) || {};
  const essayComments = (submission && submission.essayComments) || {};
  const breakdown = Array.isArray(submission && submission.subjectBreakdown) && submission.subjectBreakdown.length
    ? submission.subjectBreakdown
    : computeSubmissionSubjectBreakdown(quiz, submission);
  const maxBySection = new Map();
  breakdown.forEach((s) => maxBySection.set(normalizeSubjectName(s.name || ''), s.markPerQuestion || 0));
  const cards = [];
  questions.forEach((q, index) => {
    if (normalizeQuestionType(q && q.type) !== 'essay') return;
    const studentAnswer = (answers[index] || '').toString();
    if (!studentAnswer.trim()) return;
    const sid = (q && q._sourceId) || makeQuestionId(q, index);
    const recorded = essayScores[sid];
    const comment = (essayComments[sid] || '').toString().trim();
    const sectionName = normalizeSubjectName(q.subject || q._subject || 'General');
    const max = Math.round((maxBySection.get(sectionName) || 1) * 100) / 100 || 1;
    const scoreText = recorded != null && Number.isFinite(Number(recorded))
      ? `${formatScoreValue(Number(recorded))} / ${formatScoreValue(max)}`
      : 'Pending teacher review';
    cards.push(`
      <div class="cert-performance-card avoid-break" style="display:block">
        <div class="cert-performance-subject">Question ${index + 1} • Long Answer</div>
        <div class="cert-performance-score" style="margin-top:6px">Score: ${escapeHtml(scoreText)}</div>
        <div class="small" style="margin-top:8px;color:#475569">Your answer:</div>
        <div style="white-space:pre-wrap;border:1px solid #E2E8F0;border-radius:10px;padding:10px;background:#F8FAFC;margin-top:6px;line-height:1.55">${escapeHtml(studentAnswer)}</div>
        ${comment
          ? `<div class="small" style="margin-top:10px;color:#0F172A"><strong>Teacher's remarks:</strong></div><div style="white-space:pre-wrap;border:1px dashed #94A3B8;border-radius:10px;padding:10px;background:#FFFBEB;margin-top:4px;line-height:1.55">${escapeHtml(comment)}</div>`
          : '<div class="small" style="margin-top:10px;color:#475569">No remarks from your teacher yet.</div>'}
      </div>
    `);
  });
  if (!cards.length) return '';
  return `
    <div class="cert-performance-section avoid-break" style="margin-top:18px">
      <div class="cert-section-ribbon cert-section-ribbon-secondary">ESSAY FEEDBACK</div>
      <div class="cert-performance-list" style="display:grid;gap:12px">
        ${cards.join('')}
      </div>
    </div>
  `;
}

function buildStudentResultFullHtml(quiz, submission, rankValue, opts = {}) {
  const cardHtml = buildStudentResultSummaryCardHtml(quiz, submission, rankValue, opts);
  const supplementHtml = buildStudentResultSupplementHtml(quiz, submission);
  const actionsHtml = opts.includeActions ? buildStudentResultActionsHtml(submission) : '';
  const styles = opts.embedStyles === false ? '' : `<style>${getCertificateResultCss()}</style>`;
  return `${styles}<div class="student-result-full">${cardHtml}${supplementHtml}${actionsHtml}</div>`;
}

function buildCorrectionRequestStatusHtml(submission = {}) {
  const correctionRequested = !!submission.correctionRequested;
  const correctionContact = getSubmissionCorrectionContact(submission);
  if (!correctionRequested) return '<div class="small">No correction request yet.</div>';
  return `
    <span class="status-chip status-pending">Requested</span>
    <div class="small" style="margin-top:6px">${escapeHtml(submission.correctionRequestedAt ? new Date(submission.correctionRequestedAt).toLocaleString() : 'Awaiting teacher review')}</div>
    ${correctionContact.whatsapp ? `<div class="small" style="margin-top:4px">WhatsApp: ${escapeHtml(correctionContact.whatsapp)}</div>` : ''}
  `;
}

function buildStudentResultActionsHtml(submission = {}) {
  const correctionRequested = !!submission.correctionRequested;
  return `
    <div class="result-actions no-print">
      <div class="result-action-note">
        <div class="small">If you want a correction PDF, click Request Correction and enter the WhatsApp number where your teacher should send it. Your email or registration details from quiz start are already saved.</div>
        <div id="correctionRequestStatus" style="margin-top:8px">${buildCorrectionRequestStatusHtml(submission)}</div>
      </div>
      <button id="requestCorrectionBtn" class="btn btn-secondary">${correctionRequested ? 'Update Request' : 'Request Correction'}</button>
      <button id="downloadStudentResultPdf" class="btn btn-primary">Download PDF</button>
      <button id="printStudentResult" class="btn btn-secondary">Print Result</button>
      <button id="closeStudentResult" class="btn btn-secondary">Close</button>
    </div>
  `;
}

function buildStudentResultSummaryCardHtml(quiz, submission, rankValue, opts = {}) {
  const totalQuestions = (submission.allQuestions || []).length;
  const totalMarks = getSubmissionTotalMarks(submission, quiz);
  const attemptedCount = submission.attemptedCount || Object.keys(submission.answers || {}).filter(key => !!submission.answers[key]).length;
  const submittedText = submission.submittedAt ? new Date(submission.submittedAt).toLocaleString() : 'N/A';
  const scoreText = `${formatScoreValue(submission.score || 0)} / ${formatScoreValue(totalMarks)}`;
  const quizName = escapeHtml(sanitizeScientificText((quiz.title || submission.quizId || 'Quiz').toUpperCase()));
  const institutionName = escapeHtml(sanitizeScientificText(quiz.examName || quiz.institution || ''));
  const studentName = escapeHtml((submission.name || '').toUpperCase() || 'STUDENT');
  const rankText = rankValue || '-';
  const percent = clampPercent(submission.percent || 0);
  const gradeProfile = getCertificateGradeProfile(percent);
  const identityLabel = (submission.email || '').includes('@') ? 'Email' : 'Registration No';
  const ipAddress = getSubmissionIpAddress(submission);
  const hasAdjustedScore = hasManualScoreOverride(submission);
  const adjustedNote = hasAdjustedScore
    ? (submission.manualScoreEditedAt
      ? `Teacher adjusted score on ${new Date(submission.manualScoreEditedAt).toLocaleString()}`
      : 'Teacher adjusted score applied')
    : '';
  const details = [
    {
      kind: 'submitted',
      label: 'Submitted',
      value: escapeHtml(submittedText)
    },
    {
      kind: 'answered',
      label: 'Answered',
      value: `${submission.correctCount || 0} correct / ${attemptedCount} attempted`
    },
    {
      kind: 'email',
      label: identityLabel,
      value: escapeHtml(sanitizeScientificText(submission.email || submission.registrationNo || ''))
    },
    {
      kind: 'quiz',
      label: 'Quiz Name',
      value: quizName
    },
    {
      kind: 'device',
      label: 'IP Address',
      value: escapeHtml(ipAddress || 'Not captured')
    }
  ];
  return `
    <div class="student-result-container cert-result">
      <div class="cert-inner">
        <div class="cert-header">
          ${buildCertificateBrandMarkup()}
          ${institutionName ? `<div class="cert-header-meta">${institutionName}</div>` : ''}
          <div class="cert-quiz-title">${quizName}</div>
        </div>

        <div class="cert-section-ribbon">RESULT SUMMARY</div>
        <div class="cert-platform">VERIFIED BY OPE ASSESSOR</div>

        <div class="cert-student-panel">
          <div class="cert-label">STUDENT NAME</div>
          <div class="cert-student-name">${studentName}</div>
        </div>

        <div class="cert-score-wrap">
          <div class="cert-score-backdrop"></div>
          <div class="cert-score-ring">
            <div class="cert-score-ring-inner">
              <div class="cert-score-label">SCORE</div>
              <div class="cert-score-main">${escapeHtml(scoreText)}</div>
              <div class="cert-score-percent">${percent}%</div>
            </div>
          </div>
          <div class="cert-status-badge cert-status-grade">${escapeHtml(gradeProfile.label)}</div>
          ${hasAdjustedScore ? `<div class="cert-adjusted-note">${escapeHtml(adjustedNote)}</div>` : ''}
        </div>

        <div class="cert-rank">RANK: ${escapeHtml(rankText)}</div>
        <div class="cert-remark-card avoid-break">
          <div class="cert-remark-title">${escapeHtml(gradeProfile.label)} • ${escapeHtml(gradeProfile.range)}</div>
          <div class="cert-remark-copy">${escapeHtml(gradeProfile.remark)}</div>
        </div>

        <div class="cert-details-grid">
          ${details.map((item) => `
            <div class="cert-detail-card">
              <div class="cert-detail-icon">${getResultInfoIconSvg(item.kind)}</div>
              <div class="cert-detail-copy">
                <div class="cert-detail-label">${escapeHtml(item.label)}</div>
                <div class="cert-detail-value">${item.value}</div>
                ${item.kind === 'answered' ? `<div class="cert-detail-subline">${totalQuestions} total question(s) • ${formatScoreValue(totalMarks)} total mark(s)</div>` : ''}
              </div>
            </div>
          `).join('')}
        </div>

        ${buildPrimaryCertificateSignatureMarkup(quiz)}
        ${renderCertificateVerificationMarkup(quiz, submission)}

        <div class="cert-footer">Verified Digital Result • Generated by OPE Assessor</div>
        <div class="cert-footer-sub">Clean • Secure • Beautiful • Parent-ready</div>
      </div>
    </div>
  `;
}

function getCertificateResultCss() {
  return `
    .student-result-full{display:flex;flex-direction:column;gap:14px}
    .cert-result{font-family:"Segoe UI","Noto Sans","DejaVu Sans","Arial Unicode MS","Liberation Sans",Arial,sans-serif!important;background:#ffffff!important;color:#1F2937!important;border-radius:18px!important;box-shadow:0 18px 46px rgba(47,128,237,.14)!important;border:4px solid #2F80ED!important;padding:0!important}
    .cert-inner{position:relative;border:4px solid #2F80ED;border-radius:18px;padding:24px 22px 20px;background:
      radial-gradient(circle at top left, rgba(86,204,242,.18), transparent 24%),
      radial-gradient(circle at top right, rgba(47,128,237,.16), transparent 28%),
      linear-gradient(180deg,#ffffff 0%,#F8FAFC 100%);
      overflow:hidden}
    .cert-inner:before{content:"";position:absolute;inset:10px;border:2px solid rgba(47,128,237,.22);border-radius:12px;pointer-events:none}
    .cert-header{text-align:center;padding:18px 16px 16px;position:relative;z-index:1;border-radius:22px;background:linear-gradient(135deg,rgba(238,248,255,.96) 0%,rgba(230,243,255,.92) 52%,rgba(244,250,255,.98) 100%);border:1px solid rgba(47,128,237,.16);box-shadow:0 12px 28px rgba(47,128,237,.10)}
    .cert-brand-lockup{display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap}
    .cert-logo-badge{width:72px;height:72px;border-radius:22px;border:4px solid #2F80ED;background:#ffffff;padding:5px;display:flex;align-items:center;justify-content:center;overflow:hidden}
    .cert-logo-badge img{display:block;width:100%;height:100%;border-radius:16px;object-fit:cover}
    .cert-logo-text{text-align:left}
    .cert-logo-text strong{display:block;font-size:28px;line-height:1.05;font-weight:900;letter-spacing:.03em;text-transform:uppercase;color:#2F80ED}
    .cert-logo-text span{display:block;font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#1F2937;margin-top:5px;font-weight:800}
    .cert-header-meta{margin-top:8px;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#2F80ED}
    .cert-quiz-title{margin-top:14px;font-size:40px;line-height:1.08;font-weight:900;letter-spacing:.03em;text-transform:uppercase;color:#2F80ED}
    .cert-section-ribbon{display:flex;align-items:center;justify-content:center;gap:12px;margin:20px auto 6px;width:fit-content;padding:8px 20px;border-radius:999px;background:linear-gradient(180deg,#2F80ED 0%,#1F67D8 100%);color:#ffffff;font-size:15px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;position:relative;z-index:1}
    .cert-section-ribbon:before,.cert-section-ribbon:after{content:"";display:block;width:88px;height:2px;background:linear-gradient(90deg,transparent,#56CCF2,#2F80ED);border-radius:999px}
    .cert-section-ribbon-secondary{margin-top:0}
    .cert-platform{text-align:center;font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#5B6B84;margin-bottom:14px}
    .cert-student-panel{border:2px solid rgba(47,128,237,.5);background:#F8FAFC;border-radius:18px;text-align:center;padding:14px 16px;margin:0 auto}
    .cert-label,.cert-detail-label{font-weight:900;color:#2F80ED;text-transform:uppercase;letter-spacing:.08em}
    .cert-student-name{font-size:58px;font-weight:900;letter-spacing:.04em;line-height:1.06;margin-top:8px;color:#0F172A}
    .cert-score-wrap{position:relative;display:flex;flex-direction:column;align-items:center;gap:10px;margin:18px 0 16px}
    .cert-score-backdrop{position:absolute;left:50%;top:54%;transform:translate(-50%,-50%);width:min(480px,92%);height:168px;background:
      radial-gradient(circle, rgba(86,204,242,.35) 0 2px, transparent 3px);
      background-size:12px 12px;opacity:.45;pointer-events:none}
    .cert-score-ring{width:220px;height:220px;border-radius:50%;border:6px solid #2F80ED;background:#ffffff;display:flex;align-items:center;justify-content:center;position:relative;z-index:1}
    .cert-score-ring-inner{width:calc(100% - 16px);height:calc(100% - 16px);border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:#111827;background:#ffffff}
    .cert-score-label{font-size:13px;font-weight:900;letter-spacing:.12em;color:#2F80ED}
    .cert-score-main{font-size:52px;font-weight:900;line-height:1.04;margin-top:6px;color:#111827}
    .cert-score-percent{font-size:38px;color:#2F80ED;font-weight:900;line-height:1.04;margin-top:4px}
    .cert-status-badge{padding:6px 18px;border-radius:999px;font-size:13px;font-weight:900;letter-spacing:.12em;text-transform:uppercase;background:#E8F1FF;color:#1D4ED8}
    .cert-status-grade{background:#DBEAFE;color:#1D4ED8}
    .cert-adjusted-note{font-size:11px;color:#92400E;background:#FFF7ED;border:1px solid #FED7AA;border-radius:999px;padding:6px 12px;text-align:center}
    .cert-rank{width:min(440px,92%);margin:2px auto 18px;text-align:center;background:linear-gradient(180deg,#56CCF2 0%,#2F80ED 100%);border:2px solid #2F80ED;color:#ffffff;border-radius:999px;padding:12px 18px;font-size:22px;font-weight:900;letter-spacing:.08em;box-shadow:0 10px 20px rgba(47,128,237,.22)}
    .cert-remark-card{border:2px solid rgba(47,128,237,.28);background:#F8FAFC;border-radius:18px;padding:14px 16px;margin:0 0 16px}
    .cert-remark-title{font-size:14px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;color:#2F80ED}
    .cert-remark-copy{margin-top:8px;font-size:15px;line-height:1.65;color:#1F2937}
    .cert-details-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:4px}
    .cert-detail-card{border:2px solid rgba(47,128,237,.34);background:#F8FAFC;border-radius:16px;padding:14px;min-height:96px;display:flex;gap:12px;align-items:flex-start}
    .cert-detail-icon{width:46px;height:46px;min-width:46px;border-radius:14px;background:#2F80ED;color:#ffffff;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 16px rgba(47,128,237,.18)}
    .cert-detail-icon svg{display:block;width:24px;height:24px}
    .cert-detail-copy{min-width:0}
    .cert-detail-value{font-size:16px;line-height:1.45;margin-top:8px;color:#111827;word-break:break-word}
    .cert-detail-subline{font-size:12px;color:#4B5563;margin-top:6px;line-height:1.45}
    .cert-signature-block{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;margin:16px auto 12px;color:#1F2937}
    .cert-signature-script{width:min(220px,100%);min-height:42px;margin:0 auto -6px;display:flex;align-items:flex-end;justify-content:center}
    .cert-signature-svg{display:block;width:min(196px,100%);height:44px;overflow:visible}
    .cert-signature-line{width:min(240px,100%);border-top:2px solid #2F80ED;margin:0 auto 8px}
    .cert-signature-name{font-size:16px;font-weight:900;letter-spacing:.04em;text-transform:uppercase;color:#2F80ED}
    .cert-signature-role{font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#1F2937;margin-top:4px}
    .cert-verification{display:flex;align-items:center;justify-content:space-between;gap:14px;margin:14px 0 10px;padding:12px 14px;border:2px solid rgba(47,128,237,.34);border-radius:16px;background:#F8FAFC}
    .cert-verification-copy{flex:1;min-width:0}
    .cert-verification-label{font-size:14px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:#2F80ED}
    .cert-verification-text{margin-top:8px;font-size:13px;line-height:1.55;color:#475569}
    .cert-verification-qr{width:92px;min-width:92px;height:92px;border-radius:14px;background:#ffffff;padding:6px;border:1px solid rgba(47,128,237,.25);display:flex;align-items:center;justify-content:center;overflow:hidden}
    .cert-verification-qr svg{display:block;width:100%;height:100%}
    .cert-verification-fallback{font-size:11px;font-weight:700;color:#64748B;text-align:center}
    .cert-footer{text-align:center;font-weight:900;font-size:16px;margin-top:12px;color:#2F80ED}
    .cert-footer-sub{text-align:center;color:#1F2937;margin-top:4px;font-weight:700}
    .cert-performance-section{border:2px solid rgba(47,128,237,.34);border-radius:18px;background:#ffffff;padding:16px}
    .cert-performance-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-top:12px}
    .cert-performance-list.single{grid-template-columns:minmax(0,1fr)}
    .cert-performance-card{display:flex;align-items:center;gap:14px;border:2px solid rgba(47,128,237,.22);border-radius:16px;background:#F8FAFC;padding:14px}
    .cert-performance-icon{width:54px;height:54px;min-width:54px;border-radius:50%;background:#2F80ED;color:#ffffff;display:flex;align-items:center;justify-content:center}
    .cert-performance-icon svg{display:block;width:28px;height:28px}
    .cert-performance-copy{min-width:0}
    .cert-performance-subject{font-size:18px;font-weight:900;letter-spacing:.04em;text-transform:uppercase;color:#2F80ED}
    .cert-performance-score{font-size:18px;font-weight:900;color:#111827;margin-top:4px}
    .cert-performance-meta{font-size:13px;color:#1F2937;line-height:1.45;margin-top:4px}
    .cert-topic-section{border:2px solid rgba(47,128,237,.34);border-radius:18px;background:#ffffff;padding:16px}
    .cert-topic-groups{display:grid;gap:14px;margin-top:12px}
    .cert-topic-group{border:2px solid rgba(47,128,237,.16);border-radius:16px;background:#F8FAFC;padding:14px}
    .cert-topic-group-title{font-size:17px;font-weight:900;letter-spacing:.04em;text-transform:uppercase;color:#2F80ED}
    .cert-topic-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:12px}
    .cert-topic-card{border:1px solid rgba(47,128,237,.18);border-radius:14px;background:#ffffff;padding:12px}
    .cert-topic-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
    .cert-topic-name{font-size:14px;font-weight:800;line-height:1.4;color:#111827}
    .cert-topic-percent{font-size:14px;font-weight:900;color:#2F80ED;white-space:nowrap}
    .cert-topic-bar{height:8px;border-radius:999px;background:#DBEAFE;overflow:hidden;margin-top:10px}
    .cert-topic-bar i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#56CCF2 0%,#2F80ED 100%)}
    .cert-topic-meta{font-size:12px;color:#475569;line-height:1.5;margin-top:10px}
    .rich-text-output{display:block;white-space:normal;word-break:break-word;overflow-wrap:anywhere}
    .rich-text-output > :first-child{margin-top:0}
    .rich-text-output > :last-child{margin-bottom:0}
    .rich-text-output p,.rich-text-output div,.rich-text-output ul,.rich-text-output ol{margin:0 0 .5em}
    .rich-text-output li{margin:0 0 .25em}
    .result-actions{display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap}
    .result-action-note{width:100%;padding:12px 14px;border:1px solid #E2E8F0;border-radius:12px;background:#F8FAFC;text-align:left}
    @media(max-width:720px){
      .cert-inner{padding:18px 14px 16px}
      .cert-logo-badge{width:60px;height:60px;border-radius:18px}
      .cert-logo-text{text-align:center}
      .cert-logo-text strong{font-size:22px}
      .cert-quiz-title{font-size:28px}
      .cert-section-ribbon{font-size:13px;padding:8px 14px}
      .cert-section-ribbon:before,.cert-section-ribbon:after{width:36px}
      .cert-student-name{font-size:38px}
      .cert-score-ring{width:190px;height:190px}
      .cert-score-main{font-size:40px}
      .cert-score-percent{font-size:30px}
      .cert-rank{font-size:20px}
      .cert-details-grid{grid-template-columns:1fr}
      .cert-verification{flex-direction:column;align-items:flex-start}
    }
    @media print{
      .cert-result{box-shadow:none}
      .result-actions{display:none!important}
      /* Keep the topic-by-topic breakdown on its own page after the summary. */
      #topicBreakdown{break-before:page;page-break-before:always;margin-top:0!important}
      .cert-result,.cert-performance-section,.cert-performance-card,.cert-topic-group,.cert-topic-card{break-inside:avoid;page-break-inside:avoid}
    }
  `;
}

function buildStudentSummaryPdfHtml(quiz, submission, options = {}) {
  const rankValue = (options.rankValue || '').toString().trim() || (getSubmissionRank(submission, computeRankingForQuiz(submission.quizId)) || '-');
  const resultHtml = buildStudentResultFullHtml(quiz, submission, rankValue, { includeActions: false, embedStyles: false });
  // `paged` mode is used when there's a topic-by-topic breakdown: the page is
  // allowed to flow onto extra A4 sheets (no forced 297mm min-height), and the
  // topic section is forced to start on a fresh page so the summary keeps page
  // one to itself. Non-paged mode keeps the original compact single-sheet look.
  const paged = !!options.paged;
  const layoutCss = paged
    ? `
        .student-result-export-page{width:100%;background:#ffffff}
        .student-result-export-page .student-result-full{gap:12px}
        .student-result-export-page .cert-result{box-shadow:none!important;border-radius:0!important}
        .student-result-export-page .cert-inner{border-width:3px;padding:8mm 8mm 10mm}
        .student-result-export-page .cert-quiz-title{font-size:30px}
        .student-result-export-page .cert-student-name{font-size:38px}
        .student-result-export-page .cert-result,
        .student-result-export-page .cert-performance-section,
        .student-result-export-page .cert-performance-card,
        .student-result-export-page .cert-topic-group,
        .student-result-export-page .cert-topic-card{page-break-inside:avoid;break-inside:avoid}
        .student-result-export-page #topicBreakdown{break-before:page;page-break-before:always;margin-top:0!important}
      `
    : `
        .student-result-export-page{width:210mm;min-height:297mm;margin:0 auto;background:#ffffff}
        .student-result-export-page .student-result-full{gap:10px}
        .student-result-export-page .cert-result{box-shadow:none!important;border-radius:0!important}
        .student-result-export-page .cert-inner{border-width:4px;padding:18mm 15mm 12mm}
        .student-result-export-page .cert-quiz-title{font-size:32px}
        .student-result-export-page .cert-student-name{font-size:40px}
        .student-result-export-page .cert-performance-section{page-break-inside:avoid;break-inside:avoid}
      `;
  return `
    <div class="student-result-export-page" style="font-family:'Segoe UI','Noto Sans','DejaVu Sans','Arial Unicode MS','Liberation Sans',Arial,sans-serif;background:#ffffff;color:#0B1220;padding:0">
      <style>
        ${getCertificateResultCss()}
        ${layoutCss}
      </style>
      ${resultHtml}
    </div>
  `;
}

function renderPdfExportView() {
  const payload = state.pdfBootstrap || getPdfBootstrapPayload() || {};
  const page = payload.page && typeof payload.page === 'object' ? payload.page : {};
  const orientation = page.orientation === 'landscape' ? 'landscape' : 'portrait';
  const marginsMm = page.marginsMm && typeof page.marginsMm === 'object'
    ? page.marginsMm
    : { top: 12, right: 10, bottom: 12, left: 10 };
  const pageWidthMm = orientation === 'landscape' ? 297 : 210;
  const defaultRootWidthMm = Math.max(160, pageWidthMm - (Number(marginsMm.left) || 0) - (Number(marginsMm.right) || 0));
  const rootWidthMm = Number(page.rootWidthMm) > 0 ? Number(page.rootWidthMm) : defaultRootWidthMm;
  const subjectName = (payload.subjectName || '').toString().trim();
  let contentHtml = '';

  if (payload.type === 'result-summary' && payload.quiz && payload.submission) {
    contentHtml = buildStudentSummaryPdfHtml(payload.quiz, payload.submission, {
      rankValue: payload.rankValue || '-',
      paged: studentResultHasTopicBreakdown(payload.quiz, payload.submission)
    });
  } else if (payload.type === 'student-correction' && payload.quiz && payload.submission) {
    contentHtml = buildCorrectionPdfDocumentHtml(payload.submission, payload.quiz, {
      showNegativePenalty: payload.showNegativePenalty !== false,
      subjectName
    });
  } else if (payload.type === 'facility-index' && payload.quiz) {
    const facilityData = computeFacilityIndexFromQuizAndSubmissions(payload.quiz, payload.submissions || []);
    const visibleData = subjectName
      ? facilityData.filter((item) => normalizeSubjectName(item.subject || 'General') === normalizeSubjectName(subjectName))
      : facilityData;
    contentHtml = buildFacilityIndexPdfDocumentHtml(payload.quiz, visibleData, { subjectName: subjectName || 'General' });
  } else if (payload.type === 'teacher-summary' && payload.quiz) {
    contentHtml = buildTeacherSummaryPdfHtml(payload.quiz, payload.submissions || [], { format: payload.format || '' });
  }

  if (!contentHtml) {
    contentHtml = `
      <div class="pdf-render-error">
        <h1>PDF export could not be prepared.</h1>
        <p>The requested record was not found or the PDF data is incomplete.</p>
      </div>
    `;
  }

  if (payload.title) document.title = payload.title;

  const wrapper = document.createElement('div');
  wrapper.className = 'pdf-route-shell';
  wrapper.innerHTML = `
    <style>
      @page {
        size: A4 ${orientation};
        margin: ${Number(marginsMm.top) || 12}mm ${Number(marginsMm.right) || 10}mm ${Number(marginsMm.bottom) || 12}mm ${Number(marginsMm.left) || 10}mm;
      }
      html, body {
        margin: 0;
        padding: 0;
        background: #ffffff;
        color: #111827;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
        font-family: "Noto Sans", "DejaVu Sans", "Segoe UI", Arial, sans-serif;
      }
      body.pdf-route-active {
        background: #ffffff !important;
      }
      #app {
        width: 100%;
        min-height: 100vh;
        background: #ffffff;
      }
      #pdf-root {
        width: ${rootWidthMm}mm;
        min-height: 297mm;
        margin: 0 auto;
        padding: 0;
        background: #ffffff;
        color: #111827;
        overflow: visible;
      }
      .pdf-card,
      .avoid-break,
      .pdf-question-card,
      .pdf-summary-card,
      .pdf-meta-card,
      .facility-question-card,
      .facility-summary-card,
      .summary-row {
        break-inside: avoid;
        page-break-inside: avoid;
        overflow: visible;
      }
      .long-card {
        break-inside: auto;
        page-break-inside: auto;
      }
      .pdf-render-error {
        border: 1px solid #E5E7EB;
        border-radius: 18px;
        padding: 24px;
        margin: 24px auto;
        background: #ffffff;
      }
      .pdf-render-error h1 {
        margin: 0 0 10px;
        font-size: 24px;
        color: #0F172A;
      }
      .pdf-render-error p {
        margin: 0;
        color: #475569;
        line-height: 1.6;
      }
      * {
        box-sizing: border-box;
      }
    </style>
    <div id="pdf-root">${contentHtml}</div>
  `;

  window.__OPE_PDF_READY__ = false;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    window.__OPE_PDF_READY__ = true;
  }));
  return wrapper;
}

// Anonymous correction fallback: when the student-correction print route can't
// resolve the submission/quiz from a one-shot payload or local storage, the
// SPA fetches /api/submissions/share/<shareKey>. That endpoint is public —
// the share key IS the access token — so it works without a session, which is
// the normal case for a student opening the link from WhatsApp / email on a
// device they didn't take the test on.
const remoteCorrectionCache = new Map();
const remoteCorrectionPending = new Set();
const remoteCorrectionFailed = new Map();

function getRemoteCorrectionFromCache(shareKey) {
  const key = (shareKey || '').toString().trim().toLowerCase();
  if (!key) return null;
  return remoteCorrectionCache.get(key) || null;
}

function isRemoteCorrectionFetchPending(shareKey) {
  const key = (shareKey || '').toString().trim().toLowerCase();
  if (!key) return false;
  // Don't retry a 404 in a tight render loop.
  if (remoteCorrectionFailed.has(key)) return true;
  return remoteCorrectionPending.has(key);
}

async function fetchRemoteCorrectionByShareKey(shareKey) {
  const key = (shareKey || '').toString().trim().toLowerCase();
  if (!key) return null;
  if (remoteCorrectionPending.has(key)) return null;
  if (remoteCorrectionFailed.has(key)) return null;
  remoteCorrectionPending.add(key);
  try {
    const res = await fetchWithRetry(buildApiUrl(`/api/submissions/share/${encodeURIComponent(key)}`), {
      cache: 'no-store'
    });
    if (res.status === 404) {
      remoteCorrectionFailed.set(key, 'not-found');
      render();
      return null;
    }
    if (!res.ok) {
      const reason = await readApiErrorMessage(res, 'Failed to load correction');
      remoteCorrectionFailed.set(key, reason);
      render();
      return null;
    }
    const data = await res.json();
    const submission = data && data.submission && typeof data.submission === 'object' ? data.submission : null;
    const quiz = data && data.quiz && typeof data.quiz === 'object' ? data.quiz : null;
    if (!submission) {
      remoteCorrectionFailed.set(key, 'not-found');
      render();
      return null;
    }
    remoteCorrectionCache.set(key, { submission, quiz });
    render();
    return remoteCorrectionCache.get(key);
  } catch (err) {
    remoteCorrectionFailed.set(key, (err && err.message) || 'network error');
    render();
    return null;
  } finally {
    remoteCorrectionPending.delete(key);
  }
}

// Pull one submission (and its quiz) from the public /api/submissions/share/<key>
// endpoint into local storage. THE recovery path for a student opening a result
// / correction link on a device they didn't take the test on: they have no
// session, so the bulk /api/state pull is a guaranteed no-op for them.
async function hydrateSubmissionFromShareKey(shareKey) {
  const key = (shareKey || '').toString().trim().toLowerCase();
  if (!key || !canUseNetworkSync()) return false;
  let remote = getRemoteCorrectionFromCache(key);
  if (!remote && !remoteCorrectionFailed.has(key)) {
    remote = await fetchRemoteCorrectionByShareKey(key);
  }
  if (!remote || !remote.submission) return false;
  const localSubs = getAllSubmissions({ includeDeleted: true });
  const mergedSubs = mergeSubmissionListsForSync(localSubs || [], [remote.submission]);
  saveAllSubmissions(mergedSubs, { includeDeleted: true, skipNetworkSync: true });
  if (remote.quiz && remote.quiz.id) {
    const localQuizzes = getAllQuizzes({ includeDeleted: true });
    const mergedQuizzes = mergeRecordMapForSync(localQuizzes || {}, { [remote.quiz.id]: remote.quiz });
    saveAllQuizzes(mergedQuizzes, { skipNetworkSync: true });
  }
  return true;
}

function renderPrintRouteView() {
  const route = state.printRoute || {};
  let contentHtml = '';
  let documentTitle = 'OPE Assessor';
  let notFoundReason = '';

  if (route.type === 'student-correction') {
    // Try the one-shot payload first (instant). Fall back to local/shared
    // state lookup. If neither is available, fall back to the public
    // /api/submissions/share/<shareKey> endpoint so a student opening the
    // link from WhatsApp / email on a device they didn't take the test on
    // can still load their correction.
    const shareKey = route.shareKey || '';
    const payload = readPrintPayload('student-correction', shareKey);
    let submission = (payload && payload.submission) || null;
    let quiz = (payload && payload.quiz) || null;
    if (!submission) {
      submission = findSubmissionByShareKey(shareKey);
      quiz = submission ? getAllQuizzes()[submission.quizId] : null;
    }
    if (!submission || !quiz) {
      const cached = getRemoteCorrectionFromCache(shareKey);
      if (cached) {
        submission = cached.submission || submission;
        quiz = cached.quiz || quiz;
      } else if (!isRemoteCorrectionFetchPending(shareKey)) {
        // First render with no local data — kick off an anonymous fetch and
        // re-render once it lands. Don't await; render the loading state now.
        fetchRemoteCorrectionByShareKey(shareKey);
      }
    }
    const remoteFailureReason = remoteCorrectionFailed.get((shareKey || '').toString().trim().toLowerCase());
    if (!submission && remoteFailureReason === 'not-found') {
      notFoundReason = 'This correction link is no longer valid. Ask your teacher to resend it.';
    } else if (!submission && remoteFailureReason) {
      notFoundReason = `Could not load the correction: ${remoteFailureReason}. Try again in a moment.`;
    } else if (!submission) {
      notFoundReason = 'Loading the correction…';
    } else if (!quiz) {
      notFoundReason = 'Loading the quiz for this correction…';
    }
    if (!notFoundReason) {
      documentTitle = `Correction · ${submission.name || submission.email || 'Student'}`;
      contentHtml = buildCorrectionPdfDocumentHtml(submission, quiz, {
        showNegativePenalty: payload ? payload.showNegativePenalty !== false : (route.showNegativePenalty !== false),
        subjectName: (payload && payload.subject) || route.subject || ''
      });
    }
  } else if (route.type === 'facility-index') {
    const payload = readPrintPayload('facility-index', route.quizId || '');
    let quiz = (payload && payload.quiz) || null;
    let facilityData = (payload && Array.isArray(payload.data)) ? payload.data : null;
    let subjectFilter = (payload && payload.subject) || (route.subject || '').toString().trim();
    if (!quiz) {
      quiz = getAllQuizzes()[route.quizId || ''];
      if (quiz) {
        const allSubs = getAllSubmissions().filter((item) => item && item.quizId === quiz.id);
        facilityData = computeFacilityIndexFromQuizAndSubmissions(quiz, allSubs);
      }
    }
    if (!quiz) notFoundReason = 'Loading the facility index. If this message stays up, the quiz is not available on this device yet — shared sync has not finished pulling it.';
    else {
      if (!Array.isArray(facilityData)) facilityData = [];
      const visibleData = subjectFilter && subjectFilter !== 'General'
        ? facilityData.filter((item) => normalizeSubjectName(item.subject || 'General') === normalizeSubjectName(subjectFilter))
        : facilityData;
      documentTitle = `Facility Index · ${quiz.title || quiz.id}`;
      contentHtml = buildFacilityIndexPdfDocumentHtml(quiz, visibleData, { subjectName: subjectFilter || 'General' });
    }
  } else {
    notFoundReason = 'Unknown print route.';
  }

  if (typeof document !== 'undefined') document.title = documentTitle;

  const wrapper = document.createElement('div');
  wrapper.className = 'print-route-shell';
  wrapper.innerHTML = `
    <style>
      @page { size: A4 portrait; margin: 12mm 10mm; }
      html, body {
        margin: 0;
        padding: 0;
        background: #E5E7EB;
        color: #0F172A;
        font-family: "Inter","Segoe UI","Noto Sans","DejaVu Sans","Arial Unicode MS","Liberation Sans",Arial,sans-serif;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      body.print-route-active { background: #E5E7EB !important; }
      body.print-route-active #app { background: transparent !important; min-height: 100vh; }
      .print-toolbar {
        position: sticky;
        top: 0;
        z-index: 50;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 22px;
        background: #0F172A;
        color: #ffffff;
        box-shadow: 0 2px 6px rgba(15,23,42,0.18);
      }
      .print-toolbar-title {
        font-size: 14pt;
        font-weight: 700;
        letter-spacing: 0.02em;
        margin: 0;
      }
      .print-toolbar-actions { display: flex; gap: 10px; flex-wrap: wrap; }
      .print-toolbar button {
        appearance: none;
        border: 0;
        cursor: pointer;
        padding: 9px 18px;
        border-radius: 999px;
        font-weight: 700;
        font-size: 13pt;
        font-family: inherit;
      }
      .print-toolbar button.primary { background: #2F80ED; color: #ffffff; }
      .print-toolbar button.primary:hover { background: #1D6FE0; }
      .print-toolbar button.ghost { background: rgba(255,255,255,0.12); color: #ffffff; }
      .print-toolbar button.ghost:hover { background: rgba(255,255,255,0.22); }
      .print-page {
        background: #ffffff;
        width: 210mm;
        min-height: 297mm;
        margin: 16px auto 32px;
        padding: 12mm 10mm;
        box-shadow: 0 8px 24px rgba(15,23,42,0.12);
        color: #000000;
        overflow: visible;
        font-size: 16pt;
        line-height: 1.6;
        text-align: justify;
        hyphens: auto;
        -webkit-hyphens: auto;
      }
      .print-page * { box-sizing: border-box; }
      .print-page img, .print-page svg, .print-page canvas { max-width: 100%; height: auto; }
      .print-page table { width: 100%; table-layout: fixed; border-collapse: collapse; }
      .print-page th, .print-page td { word-wrap: break-word; overflow-wrap: break-word; }
      .print-empty {
        background: #FEF2F2;
        border: 1px solid #FCA5A5;
        border-radius: 14px;
        padding: 22px;
        color: #7F1D1D;
        font-size: 14pt;
      }
      .print-empty h1 { margin: 0 0 8px; font-size: 18pt; color: #7F1D1D; }
      .print-empty p { margin: 0; line-height: 1.55; }
      .avoid-break,
      .pdf-question-card,
      .pdf-summary-card,
      .pdf-meta-card,
      .facility-question-card,
      .facility-summary-card,
      .facility-band-section,
      .facility-band-heading {
        break-inside: avoid;
        page-break-inside: avoid;
      }
      .long-card { break-inside: auto; page-break-inside: auto; }

      @media print {
        @page { size: A4 portrait; margin: 12mm 10mm; }
        html, body { background: #ffffff !important; }
        body.print-route-active { background: #ffffff !important; }
        .print-toolbar { display: none !important; }
        #app { background: #ffffff !important; }
        .print-page {
          width: auto;
          min-height: 0;
          margin: 0;
          padding: 0;
          box-shadow: none;
          font-size: 16pt;
        }
        .pdf-question-card,
        .pdf-summary-card,
        .pdf-meta-card,
        .facility-question-card,
        .facility-summary-card,
        .facility-band-section,
        .avoid-break {
          break-inside: avoid;
          page-break-inside: avoid;
        }
      }
    </style>
    <div class="print-toolbar" data-no-print="true">
      <h1 class="print-toolbar-title">${escapeHtml(documentTitle)}</h1>
      <div class="print-toolbar-actions">
        <button class="primary" id="printRoutePrintBtn" type="button">Print / Save as PDF</button>
        <button class="ghost" id="printRouteCloseBtn" type="button">Close</button>
      </div>
    </div>
    <article class="print-page" id="printRouteContent">
      ${contentHtml || `
        <div class="print-empty">
          <h1>This page is not ready yet</h1>
          <p>${escapeHtml(notFoundReason || 'The requested record could not be opened.')}</p>
        </div>
      `}
    </article>
  `;

  setTimeout(() => {
    const printBtn = document.getElementById('printRoutePrintBtn');
    if (printBtn) printBtn.onclick = () => { try { window.print(); } catch (e) {} };
    const closeBtn = document.getElementById('printRouteCloseBtn');
    if (closeBtn) closeBtn.onclick = () => {
      // If this view was opened in a new tab, close it. Otherwise navigate home.
      try { window.close(); } catch (e) {}
      setTimeout(() => {
        if (!window.closed) {
          state.printRoute = null;
          state.view = 'home';
          window.history.replaceState({ view: 'home' }, '', '/');
          render();
        }
      }, 60);
    };
  }, 0);

  return wrapper;
}

// True when this submission's result PDF will include the topic-by-topic
// breakdown. When it does, we lay the PDF out across A4 pages (summary on page
// one, topics on page two onward) instead of shrinking everything onto a single
// sheet — which was unreadable once the breakdown was long.
function studentResultHasTopicBreakdown(quiz, submission) {
  return !!buildStudentTopicBreakdownHtml(quiz, submission);
}

const STUDENT_RESULT_PAGED_PDF_OPTIONS = {
  contentWidthMm: 190,
  marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
  pagebreakBefore: ['#topicBreakdown'],
  pagebreakAvoid: ['.avoid-break', '.cert-result', '.cert-performance-section', '.cert-performance-card', '.cert-topic-group', '.cert-topic-card'],
  scale: 2.4,
  renderScale: 2.4,
  disableServerHtmlExport: true,
  title: 'Student Result Summary'
};

// Open a print window for ready-made HTML and let the browser paginate it
// natively (respecting @page A4 + CSS page-break rules). Used for the result
// summary when there's a topic breakdown so each page stays full-size.
function printHtmlPaginated(html, options = {}) {
  const win = window.open('', '_blank', 'width=960,height=760');
  if (!win) throw new Error('Unable to open print window');
  const safeTitle = escapeHtml(options.title || 'Print');
  const marginCss = options.marginCss || '10mm';
  win.document.open();
  win.document.write(
    '<!doctype html><html><head><meta charset="utf-8"><title>' + safeTitle + '</title>' +
    '<style>@page{size:A4 portrait;margin:' + marginCss + ';}html,body{margin:0;padding:0;background:#ffffff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}body{font-family:"Segoe UI","Noto Sans","DejaVu Sans","Arial Unicode MS","Liberation Sans",Arial,sans-serif;}</style>' +
    '</head><body>' + html +
    '<script>(function(){function p(){setTimeout(function(){try{window.focus();window.print();}catch(e){}},250);}if(document.readyState==="complete")p();else window.addEventListener("load",p);})();</script>' +
    '</body></html>'
  );
  win.document.close();
  return Promise.resolve(true);
}

async function downloadStudentResultPdfDocument(quiz, submission) {
  const filename = getStudentResultPdfFilename(submission, quiz.id || submission.quizId);
  const routePath = buildStudentResultPdfRoute(submission);
  const serverReady = canUseServerRoutePdfExport();
  if (serverReady) {
    try {
      return await downloadPdfRouteThroughServer(
        routePath,
        filename,
        'Student result summary PDF downloaded',
        { orientation: 'p', marginsMm: { top: 12, right: 10, bottom: 12, left: 10 } },
        { syncKeys: [STORAGE_KEYS.submissions] }
      );
    } catch (error) {
      console.warn('Server result PDF export failed. Falling back to browser rendering.', error);
    }
  }
  if (studentResultHasTopicBreakdown(quiz, submission)) {
    // Summary on page one, topic-by-topic breakdown on page two onward.
    return downloadPagedPdfFromHtml(
      buildStudentSummaryPdfHtml(quiz, submission, { paged: true }),
      filename,
      'Student result summary PDF downloaded',
      { ...STUDENT_RESULT_PAGED_PDF_OPTIONS }
    );
  }
  return downloadPdfFromHtml(
    buildStudentSummaryPdfHtml(quiz, submission),
    filename,
    'Student result summary PDF downloaded',
    { singlePage: true, marginMm: 0, paddingPx: 0, sourceWidthPx: 794, renderScale: 3, disableServerHtmlExport: true }
  );
}

async function openStudentResultPdfPreview(quiz, submission) {
  const filename = getStudentResultPdfFilename(submission, quiz.id || submission.quizId, 'print-preview');
  const routePath = buildStudentResultPdfRoute(submission);
  const serverReady = canUseServerRoutePdfExport();
  if (serverReady) {
    try {
      return await openServerPdfRoutePreview(
        routePath,
        filename,
        { title: 'Student Result Summary', orientation: 'p', marginsMm: { top: 12, right: 10, bottom: 12, left: 10 } },
        { syncKeys: [STORAGE_KEYS.submissions] }
      );
    } catch (error) {
      console.warn('Server print preview failed. Falling back to browser canvas print.', error);
    }
  }
  if (studentResultHasTopicBreakdown(quiz, submission)) {
    return printHtmlPaginated(buildStudentSummaryPdfHtml(quiz, submission, { paged: true }), { title: 'Student Result Summary' });
  }
  return printHtmlAsSinglePage(buildStudentSummaryPdfHtml(quiz, submission), {
    title: 'Student Result Summary',
    paddingPx: 0,
    disableServerHtmlExport: true
  });
}

function printStudentSummary(quiz, submission) {
  if (studentResultHasTopicBreakdown(quiz, submission)) {
    try {
      printHtmlPaginated(buildStudentSummaryPdfHtml(quiz, submission, { paged: true }), { title: 'Student Result Summary' });
      return;
    } catch (e) {
      // fall through to the canvas-based print below
    }
  }
  const ranks = computeRankingForQuiz(submission.quizId);
  const rankValue = getSubmissionRank(submission, ranks) || '-';
  const html = buildStudentResultFullHtml(quiz, submission, rankValue, { includeActions: false, embedStyles: false });
  const printHtml = `
    <div class="student-result-export-page" style="font-family:'Segoe UI','Noto Sans','DejaVu Sans','Arial Unicode MS','Liberation Sans',Arial,sans-serif;background:#ffffff;color:#0B1220;padding:0">
      <style>
        ${getCertificateResultCss()}
        .student-result-export-page{width:210mm;min-height:297mm;margin:0 auto;background:#ffffff}
        .student-result-export-page .student-result-full{gap:10px}
        .student-result-export-page .cert-result{box-shadow:none!important;border-radius:0!important}
        .student-result-export-page .cert-inner{border-width:4px;padding:18mm 15mm 12mm}
        .student-result-export-page .cert-quiz-title{font-size:32px}
        .student-result-export-page .cert-student-name{font-size:40px}
      </style>
      ${html}
    </div>
  `;
  openStudentResultPdfPreview(quiz, submission)
    .catch(() => printHtmlAsSinglePage(printHtml, {
      title: 'Student Result Summary',
      paddingPx: 0,
      disableServerHtmlExport: true
    }))
    .catch(() => showNotification('Unable to open print window', 'error'));
}

function renderResultsView() {
  const q = state.currentQuiz;
  if (!q) return document.createElement('div');
  // Once per quiz per session: pull its submissions from the small per-quiz GET
  // (not the heavy, flaky /api/state blob), then re-render. Guarded by
  // _resultsPulledForQuizId so it can't re-fire on the follow-up re-render
  // (which would loop). The Refresh button resets it to force a re-pull.
  if (q.id && _resultsPulledForQuizId !== q.id && canUseNetworkSync() && getAuthSessionToken()) {
    _resultsPulledForQuizId = q.id;
    pullQuizSubmissionsFromCloud(q.id).then((ok) => {
      if (ok && state.currentQuiz && String(state.currentQuiz.id) === String(q.id)) render();
    }).catch(() => {});
  }
  regradeSubmissionsForQuiz(q);
  // String() both sides — a quiz id stored as a number somewhere shouldn't make
  // its submissions invisible to a strict === against the string id.
  const submissions = getAllSubmissions().filter(s => s && String(s.quizId) === String(q.id));
  console.log(`Results view for quiz ${q.id}: ${submissions.length} submission(s) (of ${getAllSubmissions().length} stored).`);
  const totalMarks = getQuizTotalMarks(q);
  const avgScore = submissions.length > 0 ? Math.round(submissions.reduce((a,s) => a + (s.score || 0), 0) / submissions.length) : 0;
  const avgPercent = submissions.length > 0 ? Math.round(submissions.reduce((a,s) => a + (s.percent || 0), 0) / submissions.length) : 0;
  const highestPercent = submissions.length ? Math.max(...submissions.map(s => s.percent || 0)) : 0;
  const lowestPercent = submissions.length ? Math.min(...submissions.map(s => s.percent || 0)) : 0;
  const passCount = submissions.filter(s => (s.resultStatus || ((s.percent || 0) >= (q.passMark || 50) ? 'Pass' : 'Fail')) === 'Pass').length;
  const correctionRequestCount = submissions.filter(s => !!s.correctionRequested).length;
  const failCount = submissions.length - passCount;
  const institutionLine = q.examName ? `<div class="text-sm text-gray-600">Institution: ${escapeHtml(q.examName)}</div>` : '';
  const div = document.createElement('div');
  div.className = 'max-w-7xl mx-auto';
  const effectiveEnd = getQuizEffectiveEndTime(q);
  const alreadyEnded = effectiveEnd && effectiveEnd <= Date.now();
  div.innerHTML = `
    <div class="mb-10 text-center">
      <h2 class="display-font text-4xl font-bold text-gradient mb-3">${q.title} - Results</h2>
      ${institutionLine}
      <div class="text-sm text-gray-600">Facility: ${q.facility || ' '}</div>
      <div class="flex gap-3 justify-center mt-4">
        <button id="btnBackTeacher" class="btn-pastel-primary">Back to Dashboard</button>
        <button id="btnRefreshResults" class="btn-pastel-secondary">Refresh</button>
        <button id="btnEndCurrentQuiz" class="btn-pastel-secondary"${alreadyEnded ? ' disabled' : ''}>End Test</button>
        <button id="btnExamAnalysis" class="btn-pastel-secondary">Exam Analysis</button>
      </div>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
      <div class="card-beautiful p-6 text-center">
        <div class="text-sm text-gray-600 mb-2">Submissions</div>
        <div class="text-3xl font-bold text-blue-600">${submissions.length}</div>
      </div>
      <div class="card-beautiful p-6 text-center">
        <div class="text-sm text-gray-600 mb-2">Total Marks</div>
        <div class="text-3xl font-bold text-cyan-600">${formatScoreValue(totalMarks)}</div>
      </div>
      <div class="card-beautiful p-6 text-center">
        <div class="text-sm text-gray-600 mb-2">Avg %</div>
        <div class="text-3xl font-bold text-sky-600">${avgPercent}%</div>
      </div>
      <div class="card-beautiful p-6 text-center">
        <div class="text-sm text-gray-600 mb-2">Export</div>
        <button id="btnExportXLSX" class="btn-pastel-secondary text-sm w-full">Excel</button>
        <button id="btnExportSummaryPDF" class="btn-pastel-secondary text-sm w-full" style="margin-top:8px">PDF Summary</button>
        <button id="btnShareRequestedCorrections" class="btn-pastel-secondary text-sm w-full" style="margin-top:8px"${correctionRequestCount ? '' : ' disabled'}>Share Corrections</button>
      </div>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
      <div class="card-beautiful p-6 text-center"><div class="text-sm text-gray-600 mb-2">Highest</div><div class="text-3xl font-bold text-blue-600">${highestPercent}%</div></div>
      <div class="card-beautiful p-6 text-center"><div class="text-sm text-gray-600 mb-2">Lowest</div><div class="text-3xl font-bold text-blue-600">${lowestPercent}%</div></div>
      <div class="card-beautiful p-6 text-center"><div class="text-sm text-gray-600 mb-2">Pass</div><div class="text-3xl font-bold text-cyan-600">${passCount}</div></div>
      <div class="card-beautiful p-6 text-center"><div class="text-sm text-gray-600 mb-2">Fail</div><div class="text-3xl font-bold text-sky-600">${failCount}</div></div>
    </div>
    <div class="card-beautiful p-4 mb-8">
      <div class="small">Correction requests pending: <strong>${correctionRequestCount}</strong></div>
    </div>

    <div class="card-beautiful p-8 mb-8">
      <h3 class="text-2xl font-bold text-blue-900 mb-6">Charts</h3>
      <div class="result-chart-row"><span>Average</span><div class="result-chart-track"><i style="width:${avgPercent}%"></i></div><strong>${avgPercent}%</strong></div>
      <div class="result-chart-row"><span>Highest</span><div class="result-chart-track"><i style="width:${highestPercent}%"></i></div><strong>${highestPercent}%</strong></div>
      <div class="result-chart-row"><span>Lowest</span><div class="result-chart-track"><i style="width:${lowestPercent}%"></i></div><strong>${lowestPercent}%</strong></div>
      <div class="result-pie" style="--pass:${submissions.length ? Math.round((passCount/submissions.length)*100) : 0}%"><span>Pass ${passCount}</span><span>Fail ${failCount}</span></div>
    </div>

    <div class="card-beautiful p-8">
      <h3 class="text-2xl font-bold text-blue-900 mb-6">Submissions</h3>
      <div style="margin-bottom:16px">
        <input id="submissionSearchInput" class="input-beautiful" placeholder="Search student name or email / ID" />
      </div>
      <div id="submissionsList" class="space-y-4"></div>
    </div>
  `;

  setTimeout(() => {
    document.getElementById('btnBackTeacher').onclick = () => {
      state.view = 'teacher';
      render();
    };
    const btnRefreshResults = document.getElementById('btnRefreshResults');
    if (btnRefreshResults) btnRefreshResults.onclick = async () => {
      const original = btnRefreshResults.textContent;
      btnRefreshResults.disabled = true;
      btnRefreshResults.textContent = 'Refreshing…';
      try {
        if (canUseNetworkSync() && getAuthSessionToken()) {
          // The reliable bit first: this quiz's own submissions via the small
          // per-quiz endpoint. Then a best-effort whole-dashboard refresh.
          _resultsPulledForQuizId = ''; // force the per-quiz pull to run again
          await pullQuizSubmissionsFromCloud(q.id);
          _resultsPulledForQuizId = q.id;
          await pullSharedStateSilently({ forcePull: true, timeoutMs: 8000 }).catch(() => {});
          _lastTeacherNavPullAt = Date.now();
        }
      } catch (e) {}
      btnRefreshResults.disabled = false;
      btnRefreshResults.textContent = original;
      if (state.currentQuiz && String(state.currentQuiz.id) === String(q.id)) render();
    };
    const btnAnalysis = document.getElementById('btnExamAnalysis');
    if (btnAnalysis) btnAnalysis.onclick = () => showExamAnalysisModal(q);
    document.getElementById('btnExportXLSX').onclick = () => {
      if (typeof XLSX === 'undefined') return showNotification('Excel library not loaded', 'error');
      const ranks = computeRankingForQuiz(q.id);
      const subjectColumns = getTeacherSummarySubjectColumns(q, submissions);
      const header = ['Name','Email / Reg No','Facility', ...subjectColumns.map((name) => `${name} Score`), 'Total Score','Average %','Overall %','Status','Adjusted','Correction Request','Correction Message','Correction Contact','Correction Share Status','Correction Activity Time','IP','Tab switches','Time (min)','Rank','Submitted'];
      const data = [header];
      submissions.forEach(s => {
        const breakdown = getSubmissionSubjectBreakdownForDisplay(q, s);
        const correctionContact = getSubmissionCorrectionContact(s);
        const correctionShare = getSubmissionCorrectionShareMeta(s);
        const subjectScores = subjectColumns.map((subjectName) => {
          const item = breakdown.find((entry) => normalizeSubjectName(entry.name) === normalizeSubjectName(subjectName));
          return item ? `${formatScoreValue(item.score)}/${formatScoreValue(item.totalMarks || item.total)}` : '';
        });
        data.push([s.name, s.email, s.facility || q.facility || '', ...subjectScores, `${formatScoreValue(s.score)}/${formatScoreValue(getSubmissionTotalMarks(s, q))}`, `${getSubmissionAveragePercent(s, q)}%`, `${s.percent || 0}%`, s.resultStatus || ((s.percent || 0) >= (q.passMark || 50) ? 'Pass' : 'Fail'), hasManualScoreOverride(s) ? 'Teacher adjusted' : 'Auto', s.correctionRequested ? 'Requested' : '', s.correctionMessage || '', correctionContact.label || '', correctionShare.label, formatCorrectionActivityStamp(correctionShare.timestamp), getSubmissionIpAddress(s) || 'Not captured', (s.monitoring && s.monitoring.tabSwitches) || 0, Math.round((s.timeSpent||0)/60), getSubmissionRank(s, ranks) || '', new Date(s.submittedAt).toLocaleString()]);
      });
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(data);
      ws['!cols'] = header.map((column, index) => ({ wch: index < 2 ? 24 : column.includes('Message') ? 28 : column.includes('Score') ? 16 : 14 }));
      XLSX.utils.book_append_sheet(wb, ws, 'Results');
      XLSX.writeFile(wb, `${makeSafeFilenamePart(q.title || 'result-summary', 'result-summary').toUpperCase()} RESULT (${q.id}).xlsx`);
      showNotification('  Exported to Excel', 'success');
    };
    document.getElementById('btnExportSummaryPDF').onclick = () => {
      if ((q.subjects || []).length > 1) return showTeacherSummaryPdfFormatModal(q, submissions);
      const filename = `${makeSafeFilenamePart(q.title || 'result-summary', 'result-summary').toUpperCase()} RESULT (${q.id}).pdf`;
      const routePath = buildTeacherSummaryPdfRoute(q);
      const serverReady = canUseServerRoutePdfExport();
      if (serverReady) {
        downloadPdfRouteThroughServer(
          routePath,
          filename,
          'Teacher result summary PDF downloaded',
          { orientation: 'p', marginsMm: { top: 12, right: 10, bottom: 12, left: 10 } },
          { syncKeys: [STORAGE_KEYS.submissions, STORAGE_KEYS.quizzes] }
        ).catch((error) => {
          console.warn('Server teacher summary export failed. Falling back to browser rendering.', error);
          downloadPdfFromHtml(
            buildTeacherSummaryPdfHtml(q, submissions),
            filename,
            'Teacher result summary PDF downloaded',
            { orientation: 'p', singlePage: false, marginMm: 8, paddingPx: 10, sourceWidthPx: 794, disableServerHtmlExport: true }
          );
        });
        return;
      }
      downloadPdfFromHtml(
        buildTeacherSummaryPdfHtml(q, submissions),
        filename,
        'Teacher result summary PDF downloaded',
        { orientation: 'p', singlePage: false, marginMm: 8, paddingPx: 10, sourceWidthPx: 794 }
      );
    };
    const btnShareRequested = document.getElementById('btnShareRequestedCorrections');
    if (btnShareRequested) btnShareRequested.onclick = () => openRequestedCorrectionsShareModal(q, submissions);
    const endBtn = document.getElementById('btnEndCurrentQuiz');
    if (endBtn) endBtn.onclick = async () => { await endQuizNow(q.id); };

    const list = document.getElementById('submissionsList');
    if (submissions.length === 0) {
      list.innerHTML = '<p class="text-gray-500 text-center py-8">No submissions yet.</p>';
    } else {
      const ranks = computeRankingForQuiz(q.id);
      const renderSubmissionTable = (query = '') => {
        const previousScrollWrap = list.querySelector('[data-scroll-key="results-submissions-table"]');
        const previousScrollLeft = previousScrollWrap ? previousScrollWrap.scrollLeft : 0;
        const normalizedQuery = (query || '').toString().trim().toLowerCase();
        const visibleSubmissions = normalizedQuery
          ? submissions.filter((item) => `${item.name || ''} ${item.email || ''} ${item.registrationNo || ''}`.toLowerCase().includes(normalizedQuery))
          : submissions;
        const rows = visibleSubmissions.map(s => {
          const breakdown = getSubmissionSubjectBreakdownForDisplay(q, s);
          const correctionContact = getSubmissionCorrectionContact(s);
          const correctionShare = getSubmissionCorrectionShareMeta(s);
          const correctionShareStamp = formatCorrectionActivityStamp(correctionShare.timestamp);
          return `
            <tr data-student-row="${encodeURIComponent((s.submissionId || buildSubmissionIdentity(s)))}">
              <td>${escapeHtml(s.name || '')}</td>
              <td>${escapeHtml(s.email || s.registrationNo || '')}</td>
              <td>${s.facility || q.facility || ''}</td>
              <td>${breakdown.length ? breakdown.map((item) => `<div><strong>${escapeHtml(item.name)}:</strong> ${formatScoreValue(item.score)} / ${formatScoreValue(item.totalMarks || item.total)}</div>`).join('') : '<div>-</div>'}</td>
              <td class="text-right">${formatScoreValue(s.score)}/${formatScoreValue(getSubmissionTotalMarks(s, q))}${hasManualScoreOverride(s) ? '<div class="small" style="color:#B45309;font-weight:700">Adjusted</div>' : ''}</td>
              <td class="text-right">${getSubmissionAveragePercent(s, q)}%</td>
              <td class="text-right">${s.percent}%</td>
              <td class="text-right">${escapeHtml(s.resultStatus || ((s.percent || 0) >= (q.passMark || 50) ? 'Pass' : 'Fail'))}</td>
              <td class="text-right">${escapeHtml(getSubmissionIpAddress(s) || 'Not captured')}</td>
              <td class="text-right">${(s.monitoring && s.monitoring.tabSwitches) || 0}</td>
              <td class="text-right">${Math.floor((s.timeSpent||0) / 60)}m</td>
              <td class="text-right">${getSubmissionRank(s, ranks) || ''}</td>
              <td class="text-right">
                ${s.correctionRequested
                  ? `<span class="req-badge req-pending" title="${escapeHtml(s.correctionMessage || '')}">Requested</span>`
                  : '<span class="req-badge">None</span>'}
                <div class="small" style="margin-top:6px">${escapeHtml(correctionContact.label || 'No contact provided')}</div>
                <div class="small" style="margin-top:4px;color:#64748B">${escapeHtml(correctionShare.label)}${correctionShareStamp ? ` • ${escapeHtml(correctionShareStamp)}` : ''}</div>
              </td>
              <td class="text-right">
                <div class="row-action-shell">
                  <select class="input-beautiful row-action-select submissionActionSelect" data-quiz="${q.id}" data-email="${encodeURIComponent(s.email)}" data-submitted="${escapeHtml(s.submittedAt || '')}">
                    <option value="">Choose action</option>
                    ${q.audienceMode !== 'class' ? '<option value="edit-name">Edit Name</option>' : ''}
                    <option value="edit-score">Edit Score</option>
                    <option value="download-correction">Download Correction</option>
                    <option value="send-email">Send Email</option>
                    <option value="send-whatsapp">Send WhatsApp</option>
                    <option value="delete">Delete Result</option>
                  </select>
                  <button class="btn-pastel-secondary btnApplySubmissionAction" data-quiz="${q.id}" data-email="${encodeURIComponent(s.email)}" data-submitted="${escapeHtml(s.submittedAt || '')}">Apply</button>
                </div>
              </td>
            </tr>
          `;
        }).join('');

        list.innerHTML = `
          <div class="card-beautiful p-4">
            <div class="overflow-x-auto" data-scroll-key="results-submissions-table">
              <table class="table-dense w-full">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email / Reg No</th>
                    <th>Facility</th>
                    <th>Subjects &amp; Scores</th>
                    <th class="text-right">Total</th>
                    <th class="text-right">Average %</th>
                    <th class="text-right">Overall %</th>
                    <th class="text-right">Status</th>
                    <th class="text-right">IP</th>
                    <th class="text-right">Tabs</th>
                    <th class="text-right">Time</th>
                    <th class="text-right">Rank</th>
                    <th class="text-right">Correction</th>
                    <th class="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows || '<tr><td colspan="14" class="text-center">No student matched your search.</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>
        `;
        const nextScrollWrap = list.querySelector('[data-scroll-key="results-submissions-table"]');
        if (nextScrollWrap) nextScrollWrap.scrollLeft = previousScrollLeft;
        list.querySelectorAll('[data-student-row]').forEach((row) => {
          row.onclick = () => {
            list.querySelectorAll('[data-student-row]').forEach((item) => {
              item.style.background = '';
              item.style.outline = '';
            });
            row.style.background = '#EFF6FF';
            row.style.outline = '1px solid #BFDBFE';
          };
        });
        const pendingFocus = state.pendingResultsFocus;
        if (pendingFocus && String(pendingFocus.quizId || '') === String(q.id || '')) {
          const targetRow = list.querySelector(`[data-student-row="${encodeURIComponent(pendingFocus.submissionKey || '')}"]`);
          if (targetRow) {
            targetRow.click();
            targetRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
            if (pendingFocus.openModal) {
              const targetSubmission = findSubmissionBySubmissionKey(q.id, pendingFocus.submissionKey);
              if (targetSubmission) {
                setTimeout(() => showStudentResultModalFromSubmission(q, targetSubmission, true), 120);
              }
            }
            state.pendingResultsFocus = null;
          }
        }
        if (typeof window.__opeWireSubmissionButtons === 'function') window.__opeWireSubmissionButtons();
      };
      renderSubmissionTable();
      const searchInput = document.getElementById('submissionSearchInput');
      if (searchInput) searchInput.oninput = () => renderSubmissionTable(searchInput.value || '');
    }

    // Wire per-student correction PDF buttons
    setTimeout(() => {
      const runSubmissionAction = async (action, ev) => {
        if (!action) return showNotification('Choose an action first', 'error');
        const quizId = ev.currentTarget.dataset.quiz;
        const email = decodeURIComponent(ev.currentTarget.dataset.email || '');
        const submittedAt = ev.currentTarget.dataset.submitted || '';
        if (action === 'edit-name') {
          if (q.audienceMode === 'class') return showNotification('For class-based quizzes, edit student names from the Students portal.', 'warning', 7000);
          const all = getAllSubmissions();
          const index = findSubmissionIndexByIdentity(all, quizId, email, submittedAt);
          if (index < 0) return showNotification('Submission not found', 'error');
          const currentName = (all[index].name || '').toString().trim();
          const nextName = window.prompt('Enter the corrected student name', currentName);
          if (nextName == null) return;
          const trimmedName = nextName.trim();
          if (!trimmedName) return showNotification('Student name cannot be empty.', 'error');
          all[index].name = trimmedName;
          all[index].updatedAt = new Date().toISOString();
          saveAllSubmissions(all);
          // Per-quiz submissions push (bulk PUT blocked for teachers).
          const quizSubs = getAllSubmissions({ includeDeleted: true }).filter((s) => s && s.quizId === quizId);
          const sharedSyncOk = await pushSingleQuizSubmissionsToCloud(quizId, quizSubs);
          showNotification(sharedSyncOk ? 'Student name updated' : `Student name updated on this device. ${getSharedSyncWarningMessage()}`, sharedSyncOk ? 'success' : 'warning', 7000);
          render();
          return;
        }
        if (action === 'edit-score') {
          const all = getAllSubmissions();
          const index = findSubmissionIndexByIdentity(all, quizId, email, submittedAt);
          if (index < 0) return showNotification('Submission not found', 'error');
          showEditSubmissionScoreModal(getAllQuizzes()[quizId] || q, all[index]);
          return;
        }
        if (action === 'download-correction') {
        try {
          const subsAll = getAllSubmissions();
          const index = findSubmissionIndexByIdentity(subsAll, quizId, email, submittedAt);
          const s = index >= 0 ? subsAll[index] : null;
          if (!s) return showNotification('Submission not found', 'error');
          const quiz = getAllQuizzes()[quizId] || {};
          await downloadCorrectionPdfFast(s, quiz, { showNegativePenalty: true });
          s._correctionDownloaded = true;
          s.correctionDownloadedAt = new Date().toISOString();
          s.updatedAt = new Date().toISOString();
          const subsAll2 = getAllSubmissions();
          const idx2 = findSubmissionIndexByIdentity(subsAll2, s.quizId, s.email, s.submittedAt || '');
          if (idx2 >= 0) {
            subsAll2[idx2] = s;
            saveAllSubmissions(subsAll2);
            // Per-quiz push.
            const quizSubs = getAllSubmissions({ includeDeleted: true }).filter((sub) => sub && sub.quizId === s.quizId);
            await pushSingleQuizSubmissionsToCloud(s.quizId, quizSubs);
          }
          render();
        } catch (e) { console.error(e); showNotification('Error generating PDF', 'error'); }
          return;
        }
        if (action === 'send-email') {
        try {
          const subsAll = getAllSubmissions();
          const index = findSubmissionIndexByIdentity(subsAll, quizId, email, submittedAt);
          const s = index >= 0 ? subsAll[index] : null;
          if (!s) return showNotification('Submission not found', 'error');
          const quiz = getAllQuizzes()[quizId] || {};
          const sent = await sendCorrectionByEmail(s, quiz);
          if (sent) render();
        } catch (e) { console.error(e); showNotification('Error preparing email', 'error'); }
          return;
        }
        if (action === 'send-whatsapp') {
        try {
          const subsAll = getAllSubmissions();
          const index = findSubmissionIndexByIdentity(subsAll, quizId, email, submittedAt);
          const s = index >= 0 ? subsAll[index] : null;
          if (!s) return showNotification('Submission not found', 'error');
          const quiz = getAllQuizzes()[quizId] || {};
          const shared = await shareCorrectionViaWhatsapp(s, quiz);
          if (shared) render();
        } catch (e) { console.error(e); showNotification('Error preparing WhatsApp share', 'error'); }
          return;
        }
        if (action === 'delete') {
          if (!confirmTeacherAction('Delete this student submission/result? It will be removed from results, ranking, and exports.')) return;
          const all = getAllSubmissions({ includeDeleted: true });
          const index = findSubmissionIndexByIdentity(all, quizId, email, submittedAt);
          if (index < 0) return showNotification('Submission not found', 'error');
          all[index] = {
            ...all[index],
            deletedAt: new Date().toISOString(),
            deletedBy: state.teacherId || 'teacher',
            updatedAt: new Date().toISOString()
          };
          save(STORAGE_KEYS.submissions, all);
          // Per-quiz tombstone push (bulk PUT blocked for teachers).
          const quizSubs = getAllSubmissions({ includeDeleted: true }).filter((s) => s && s.quizId === quizId);
          const sharedSyncOk = await pushSingleQuizSubmissionsToCloud(quizId, quizSubs);
          showNotification(sharedSyncOk ? 'Submission deleted' : `Submission deleted on this device. ${getSharedSyncWarningMessage()}`, sharedSyncOk ? 'success' : 'warning', 7000);
          render();
        }
      };
      const wireSubmissionActionButtons = () => {
        document.querySelectorAll('.btnApplySubmissionAction').forEach(btn => btn.onclick = async (ev) => {
          const selector = ev.currentTarget.parentElement.querySelector('.submissionActionSelect');
          const action = selector ? selector.value : '';
          await runSubmissionAction(action, ev);
          if (selector) selector.value = '';
        });
      };
      window.__opeWireSubmissionButtons = wireSubmissionActionButtons;
      wireSubmissionActionButtons();
    }, 100);
  }, 0);

  return div;
}

// Render exam analysis modal (facility index) for a quiz
function showExamAnalysisModal(q) {
  try {
    const data = computeFacilityIndex(q.id);
    let modal = document.getElementById('analysisModal');
    if (modal) modal.remove();
    modal = document.createElement('div');
    modal.id = 'analysisModal';
    modal.style.position = 'fixed';
    modal.style.inset = '0';
    modal.style.background = 'rgba(0,0,0,0.4)';
    modal.style.zIndex = 20000;
    modal.style.display = 'flex';
    modal.style.alignItems = 'center';
    modal.style.justifyContent = 'center';

    const inner = document.createElement('div');
    inner.className = 'card-beautiful p-6';
    inner.style.width = '90%';
    inner.style.maxWidth = '1000px';
    const subjectNames = Array.from(new Set(data.map((item) => item.subject || 'General')));
    let selectedSubject = subjectNames[0] || 'General';
    inner.innerHTML = `
      <div class="flex justify-between items-center mb-4" style="gap:12px;flex-wrap:wrap">
        <div>
          <h3 class="text-2xl font-bold">Exam Analysis • Facility Index</h3>
          <div class="small">Review one subject at a time and export only the subject you open.</div>
        </div>
        <div class="flex gap-2" style="flex-wrap:wrap">
          <button id="btnAnalysisExportXLS" class="btn-pastel-secondary">Export Excel</button>
          <button id="btnAnalysisExportPDF" class="btn-pastel-primary">Export PDF</button>
          ${subjectNames.length > 1 ? '<button id="btnAnalysisExportAllPDF" class="btn-pastel-secondary">Export All PDFs</button>' : ''}
          <button id="btnCloseAnalysis" class="btn-pastel-secondary">Close</button>
        </div>
      </div>
      ${subjectNames.length > 1 ? `
        <div style="margin-bottom:14px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <label class="small" for="analysisSubjectSelect" style="font-weight:700">Subject</label>
          <select id="analysisSubjectSelect" class="input-beautiful" style="min-width:240px">
            ${subjectNames.map((name) => `<option value="${escapeHtml(name)}"${name === selectedSubject ? ' selected' : ''}>${escapeHtml(name)}</option>`).join('')}
          </select>
        </div>
      ` : ''}
      <div id="analysisContent" style="max-height:60vh;overflow:auto;padding-right:8px"></div>
    `;

    modal.appendChild(inner);
    document.body.appendChild(modal);

    const content = inner.querySelector('#analysisContent');
    const renderContent = () => {
      const visibleData = (data || [])
        .filter((item) => (item.subject || 'General') === selectedSubject)
        .slice()
        .sort((left, right) => {
          const leftValue = left.facilityIndex == null ? 1 : left.facilityIndex;
          const rightValue = right.facilityIndex == null ? 1 : right.facilityIndex;
          return leftValue - rightValue;
        });
      if (!visibleData.length) {
        content.innerHTML = '<p class="text-gray-600">No submissions yet to analyze for this subject.</p>';
        return;
      }
      const summary = getFacilityAnalysisSummary(visibleData);
      const orderedBands = ['Very Difficult', 'Difficult', 'Moderate', 'Easy', 'Very Easy'];
      const bandSections = orderedBands.map((label) => ({
        label,
        items: visibleData.filter((item) => getFacilityDifficultyBand(item.facilityIndex).label === label)
      })).filter((section) => section.items.length);
      content.innerHTML = `
        <div class="card-beautiful" style="padding:16px;border:1px solid #E2E8F0;background:#F8FAFC;margin-bottom:14px">
          <div class="h3">${escapeHtml(selectedSubject)}</div>
          <div class="small" style="margin-top:6px">Quiz ID: ${escapeHtml(q.id || '')}</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:14px">
            <div class="card" style="padding:12px;background:#fff;border:1px solid #DBEAFE"><strong>Average Facility Index</strong><div style="font-size:24px;margin-top:6px">${summary.average}%</div></div>
            <div class="card" style="padding:12px;background:#fff;border:1px solid #DBEAFE"><strong>Total Questions</strong><div style="font-size:24px;margin-top:6px">${summary.totalQuestions}</div></div>
            <div class="card" style="padding:12px;background:#fff;border:1px solid #DBEAFE"><strong>Easy / Moderate / Difficult</strong><div style="margin-top:6px">${summary.percentages.easy}% / ${summary.percentages.moderate}% / ${summary.percentages.difficult}%</div></div>
          </div>
          <div style="display:flex;height:10px;border-radius:999px;overflow:hidden;margin-top:14px;background:#E2E8F0">
            <span style="width:${summary.percentages.difficult}%;background:#FCA5A5"></span>
            <span style="width:${summary.percentages.moderate}%;background:#FDE68A"></span>
            <span style="width:${summary.percentages.easy}%;background:#7DD3FC"></span>
          </div>
        </div>
        ${bandSections.map((section) => {
          const band = getFacilityDifficultyBand(section.items[0].facilityIndex);
          return `
            <div style="margin-bottom:18px">
              <div style="padding:10px 14px;border-radius:12px;background:${band.color};border:1px solid ${band.accent};font-weight:800;color:${band.text};margin-bottom:10px">${section.label} (${band.min}-${band.max}%)</div>
              ${section.items.map((item) => {
                const facilityPercent = item.facilityIndex == null ? 'No attempts' : `${Math.round(item.facilityIndex * 100)}%`;
                const optionsMarkup = (item.optionCounts || []).map((option) => {
                  const isCorrect = (item.answer || '').toString().toUpperCase() === option.letter;
                  return `<div style="padding:8px 10px;border-radius:10px;border:1px solid ${isCorrect ? '#6EE7B7' : '#E2E8F0'};background:${isCorrect ? '#ECFDF5' : '#FFFFFF'};display:flex;justify-content:space-between;gap:12px;align-items:flex-start"><div class="rich-text-output" style="flex:1 1 auto">${option.letter}. ${renderRichTextHtml(option.option)}</div><strong>${option.count}</strong></div>`;
                }).join('');
                return `
                  <div class="card-beautiful" style="padding:16px;margin-bottom:12px;border:1px solid #E2E8F0;box-shadow:none">
                    <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap">
                      <div style="font-weight:800">Question ${item.index}</div>
                      <div style="font-weight:700;color:#334155">${facilityPercent} • ${section.label}</div>
                    </div>
                    ${renderQuestionMediaAssets(item, 'before')}
                    <div style="margin-top:10px;font-size:16px;line-height:1.6;white-space:normal;word-break:break-word" class="rich-text-output">${renderRichTextHtml(item.question || '')}</div>
                    ${renderQuestionMediaAssets(item, 'after')}
                    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin-top:12px">${optionsMarkup}</div>
                    <div class="small" style="margin-top:12px;line-height:1.7">Correct answer: <strong>${escapeHtml(item.answer || '')}</strong> • Seen: <strong>${item.seen}</strong> • Attempted: <strong>${item.attempted}</strong> • Correct: <strong>${item.correct}</strong> • Wrong: <strong>${Math.max(0, item.attempted - item.correct)}</strong></div>
                    <div class="small" style="margin-top:6px;line-height:1.7">Topic:<div class="rich-text-output" style="font-weight:700">${renderRichTextHtml(item.topic || 'Not set')}</div></div>
                    <div class="small rich-text-output" style="margin-top:6px;line-height:1.7">Explanation: ${renderRichTextHtml(item.explanation || 'No explanation provided yet.')}</div>
                  </div>
                `;
              }).join('')}
            </div>
          `;
        }).join('')}
      `;
    };
    renderContent();

    // Wire close
    document.getElementById('btnCloseAnalysis').onclick = () => modal.remove();
    const subjectSelect = document.getElementById('analysisSubjectSelect');
    if (subjectSelect) subjectSelect.onchange = () => {
      selectedSubject = subjectSelect.value || subjectNames[0] || 'General';
      renderContent();
    };

    // Export handlers
    document.getElementById('btnAnalysisExportXLS').onclick = () => {
      if (typeof XLSX === 'undefined') return showNotification('Excel library not loaded', 'error');
      const visibleData = data.filter((item) => (item.subject || 'General') === selectedSubject);
      const maxOptions = Math.max(0, ...visibleData.map(r => (r.optionCounts || []).length));
      const optionHeaders = [];
      for (let i = 0; i < maxOptions; i++) optionHeaders.push(`Option ${String.fromCharCode(65+i)} Count`);
      const header = ['Q#','Subject','Question','Topic','Explanation','Seen','Attempted','Correct','Unanswered','Not Seen','Facility %','Interpretation', ...optionHeaders];
      const rows = visibleData.map(r => {
        const band = getFacilityDifficultyBand(r.facilityIndex);
        const optionValues = [];
        for (let i = 0; i < maxOptions; i++) optionValues.push((r.optionCounts || [])[i]?.count || 0);
        return [r.index, r.subject, r.question, r.topic || '', r.explanation || '', r.seen, r.attempted, r.correct, r.unanswered, r.notSeen, r.facilityIndex === null ? '' : Math.round(r.facilityIndex * 100), r.facilityIndex === null ? 'No attempts' : band.label, ...optionValues];
      });
      const aoa = [header, ...rows];
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      XLSX.utils.book_append_sheet(wb, ws, 'FacilityIndex');
      XLSX.writeFile(wb, `${makeSafeFilenamePart(selectedSubject, 'subject')} FACILITY INDEX (${q.id}).xlsx`);
      showNotification('Facility index Excel exported', 'success');
    };
    document.getElementById('btnAnalysisExportPDF').onclick = async () => {
      try {
        const visibleData = data.filter((item) => (item.subject || 'General') === selectedSubject);
        await downloadFacilityIndexPdfText(q, visibleData, { subjectName: selectedSubject });
      } catch(e) { console.error(e); showNotification('Error exporting PDF', 'error'); }
    };
    const exportAllBtn = document.getElementById('btnAnalysisExportAllPDF');
    if (exportAllBtn) exportAllBtn.onclick = async () => {
      for (const subjectName of subjectNames) {
        const visibleData = data.filter((item) => (item.subject || 'General') === subjectName);
        await downloadFacilityIndexPdfText(q, visibleData, { subjectName, successMessage: '' });
      }
      showNotification('All subject facility index PDFs downloaded', 'success');
    };

  } catch (e) { console.error('Analysis error', e); showNotification('Error generating analysis', 'error'); }
}

// Small helper to escape HTML in strings
function escapeHtml(s) { return (s || '').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function hexToRgbTriplet(hex) {
  const value = (hex || '').toString().replace('#', '');
  if (value.length !== 6) return [226, 232, 240];
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16)
  ];
}

// ============================================================================
// INITIALIZATION
// ============================================================================

let timerInterval = null;
let timeRemaining = 0;
let startTime = null;
const examSubmissionIntent = {
  confirmOpen: false,
  manualSubmitInFlight: false
};

function isManualExamSubmitFlowActive() {
  return !!examSubmissionIntent.manualSubmitInFlight;
}

function showExamSubmitConfirmModal() {
  if (examSubmissionIntent.confirmOpen) return Promise.resolve(false);
  examSubmissionIntent.confirmOpen = true;
  return new Promise((resolve) => {
    let closed = false;
    let modal = document.getElementById('examSubmitConfirmModal');
    if (modal) modal.remove();
    modal = document.createElement('div');
    modal.id = 'examSubmitConfirmModal';
    modal.className = 'student-result-modal';
    const card = document.createElement('div');
    card.className = 'card-beautiful admin-modal-card';
    card.style.width = 'min(520px, 92vw)';
    card.innerHTML = `
      <div class="page-heading">
        <div>
          <div class="h2">Submit Exam?</div>
          <div class="small">Your answers will be saved and you will leave the exam screen immediately.</div>
        </div>
      </div>
      <div class="small" style="line-height:1.7;margin-bottom:16px">Only continue if you are completely done. Cancel keeps you inside the exam without any penalty.</div>
      <div style="display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap">
        <button id="cancelExamSubmitConfirm" class="btn btn-ghost">Cancel</button>
        <button id="confirmExamSubmitConfirm" class="btn btn-primary">Submit Now</button>
      </div>
    `;
    const close = (confirmed) => {
      if (closed) return;
      closed = true;
      examSubmissionIntent.confirmOpen = false;
      document.removeEventListener('keydown', onKeyDown);
      try { modal.remove(); } catch (error) {}
      resolve(!!confirmed);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') close(false);
    };
    modal.onclick = (event) => {
      if (event.target === modal) close(false);
    };
    document.addEventListener('keydown', onKeyDown);
    modal.appendChild(card);
    document.body.appendChild(modal);
    document.getElementById('cancelExamSubmitConfirm').onclick = () => close(false);
    document.getElementById('confirmExamSubmitConfirm').onclick = () => close(true);
  });
}

function autoSubmit() {
  showNotification('  Time up! Auto-submitting...', 'warning');
  setTimeout(() => collectAndSubmit(), 1000);
}

// =================== Quiz Creation / Import / Template ===================
function gen6DigitId() { return Math.floor(100000 + Math.random()*900000).toString(); }

function showCreateQuizModal(editQuizId = '', options = {}) {
  if (!requireTeacher()) return render();
  if (!canSetQuestions()) return showLicenseRequired();
  const editingQuiz = editQuizId ? getAllQuizzes()[editQuizId] : null;
  const templateQuiz = !editingQuiz && options.templateQuizId ? getAllQuizzes()[options.templateQuizId] : null;
  if (!editingQuiz && !getTeacherLicenseStatus().canSaveQuiz) return showLicenseRequired();
  if (editingQuiz && editingQuiz.teacherId !== state.teacherId && !isSuperAdmin()) return showNotification('Access denied: this quiz belongs to another teacher', 'error');
  if (!editingQuiz && options.templateQuizId && !templateQuiz) return showNotification('Admin quiz template not found', 'error');
  if (templateQuiz && !canSetQuizFromAdminTemplate(templateQuiz)) return showNotification('Admin quiz template not found', 'error');
  const templateMode = !!templateQuiz && !editingQuiz;
  const quizOwnerId = editingQuiz?.teacherId || state.teacherId;
  const classNames = getTeacherClassNames(quizOwnerId);
  const classOptionsMarkup = classNames.map((className) => `<option value="${escapeHtml(className)}">${escapeHtml(className)}</option>`).join('');
  let m = document.getElementById('createQuizModal'); if (m) m.remove();
  m = document.createElement('div'); m.id = 'createQuizModal'; m.style.position='fixed'; m.style.inset='0'; m.style.zIndex=20000; m.style.background='rgba(0,0,0,0.35)'; m.style.overflowY='auto'; m.style.padding='18px 14px';
  const inner = document.createElement('div'); inner.className='card-beautiful quiz-builder-shell'; inner.style.width='1320px'; inner.style.maxWidth='96vw'; inner.style.maxHeight='calc(100vh - 36px)'; inner.style.margin='0 auto'; inner.style.padding='28px'; inner.style.overflowY='auto';
  inner.innerHTML = `
    <div class="quiz-builder-header">
      <div>
        <div class="quiz-builder-kicker">Quiz Workspace</div>
        <h3>${editingQuiz ? 'Edit Quiz' : templateMode ? 'Set Quiz from Admin Content' : 'Create Quiz'}</h3>
        <p>${templateMode ? 'The admin question content is already loaded below. Review the settings, choose Public or Uploaded class, preview anything you want, and save to create your own quiz.' : 'Organize your assessment settings in clear sections, then save without changing the underlying quiz logic.'}</p>
      </div>
      <button id="closeCreate" class="btn-secondary quiz-close-btn" aria-label="Close quiz editor">Close</button>
    </div>
    <div class="quiz-form-grid create-quiz-grid">
      <div class="quiz-main-column">
        <section class="form-section">
          <div class="section-title-row">
            <div class="section-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h8l4 4v12H7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M15 4v4h4M10 12h6M10 16h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
            </div>
            <div>
              <h4 class="section-title">Basic Quiz Info</h4>
              <p class="section-subtitle">Set the core details students and teachers rely on.</p>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label" for="cqExamName">Exam Name / Institution</label>
            <input id="cqExamName" class="input-beautiful" placeholder="e.g. ABC University" />
            <p class="helper-text">This appears as the main institution/exam heading on student result summaries and PDFs.</p>
          </div>
          <div class="form-group">
            <label class="form-label" for="cqTitle">Quiz title</label>
            <input id="cqTitle" class="input-beautiful" />
          </div>
          <div class="form-group">
            <label class="form-label" for="cqDefaultQuestionType">Question type for this quiz</label>
            <select id="cqDefaultQuestionType" class="input-beautiful">
              <option value="mcq">Multiple Choice (MCQ)</option>
              <option value="yesno">Yes / No (True/False)</option>
              <option value="short">Short Answer</option>
              <option value="essay">Long Answer (Essay)</option>
            </select>
            <p class="helper-text">Pick what the questions in this quiz are. Imported questions and pasted CSV rows take this type by default. You can still change individual questions later from the Quiz Content editor.</p>
          </div>
          <div class="field-grid-2">
            <div class="form-group">
              <label class="form-label" for="cqAudience">Who can take this quiz?</label>
              <select id="cqAudience" class="input-beautiful">
                <option value="">Choose audience</option>
                <option value="public">Public</option>
                <option value="class">Uploaded class</option>
              </select>
              <p class="helper-text">Choose this first. Public means anyone with the student code can enter. Uploaded class means only students from one imported class can open it.</p>
            </div>
            <div class="form-group" id="cqAssignedClassGroup">
              <label class="form-label" for="cqAssignedClass">Class</label>
              <select id="cqAssignedClass" class="input-beautiful">
                <option value="">Select class</option>
                ${classOptionsMarkup}
              </select>
              <p class="helper-text" id="cqAssignedClassHelp">${classNames.length ? 'Choose one of the classes already uploaded under Students.' : 'No uploaded class yet. Use the Students menu to import a class first.'}</p>
              ${classNames.length ? '' : '<button type="button" id="goToStudentsFromQuiz" class="btn-secondary advanced-action" style="margin-top:8px">Go to Students</button>'}
            </div>
          </div>
          <div class="field-grid-2">
            <div class="form-group">
              <label class="form-label" for="cqPassword">Password</label>
              <input id="cqPassword" class="input-beautiful" type="password" placeholder="Optional password for teacher access" />
              <p class="helper-text">Teachers can use this with the Quiz ID to reopen the quiz securely.</p>
            </div>
            <div class="form-group">
              <label class="form-label" for="cqTime">Time limit</label>
              <input id="cqTime" class="input-beautiful" placeholder="Time limit (minutes)" />
            </div>
            <div class="form-group">
              <label class="form-label" for="cqMaxGrade">Total quiz marks</label>
              <input id="cqMaxGrade" class="input-beautiful" placeholder="Auto-calculated from subjects" readonly />
              <p class="helper-text">This now comes from the marks you assign to each subject below.</p>
            </div>
            <div class="form-group">
              <label class="form-label" for="cqAttemptLimit">Attempt limit</label>
              <input id="cqAttemptLimit" class="input-beautiful" placeholder="Attempt limit (default 1)" />
            </div>
            <div class="form-group">
              <label class="form-label" for="cqPassMark">Pass mark</label>
              <input id="cqPassMark" class="input-beautiful" placeholder="Pass mark % (e.g. 50)" />
            </div>
          </div>
        </section>

        <section class="form-section">
          <div class="section-title-row">
            <div class="section-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 2v4M17 2v4M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12 12v4m0 0 2-2m-2 2-2-2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </div>
            <div>
              <h4 class="section-title">Marking & Schedule</h4>
              <p class="section-subtitle">Control grading behavior, access windows, and subject setup.</p>
            </div>
          </div>
          <div class="field-grid-2">
            <div class="form-group">
              <div class="form-label">Quiz Template</div>
              <p class="helper-text">Download the starter spreadsheet before you add subjects.</p>
              <button id="btnExportTemplate" class="btn-secondary advanced-action">Export Quiz Template</button>
            </div>
            <div class="form-group">
              <label class="form-label">Negative marking</label>
              <label class="check-row"><input type="checkbox" id="cqNegativeEnabled" /> <span>Enable mark deduction for wrong answers</span></label>
            </div>
            <div class="form-group">
              <label class="form-label" for="cqNegativeValue">Mark deduction per wrong answer</label>
              <input id="cqNegativeValue" class="input-beautiful" placeholder="e.g. 0.25" />
            </div>
            <div class="form-group">
              <label class="form-label" for="cqStart">Start date/time</label>
              <input id="cqStart" class="input-beautiful" type="datetime-local" />
            </div>
            <div class="form-group">
              <label class="form-label" for="cqEnd">End date/time</label>
              <input id="cqEnd" class="input-beautiful" type="datetime-local" />
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Subjects</label>
            <div class="subjects-section">
              <div id="subjectsList" class="subjects-list"></div>
              <button type="button" id="btnAddSubject" class="btn-secondary subject-add-btn">+ Add Subject</button>
            </div>
            <p class="helper-text">For multiple subjects, upload one question file per subject. The template column named Topic is only for topic tagging inside that subject.</p>
          </div>
        </section>

        <section class="form-section">
          <div class="section-title-row">
            <div class="section-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M7 4v6m10-6v6M5 11h14v8H5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 16h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
            </div>
            <div>
              <h4 class="section-title">Certificate Signatories</h4>
              <p class="section-subtitle">Add only the signatories you want on the result certificate. Leave this empty if you do not want any signatory line.</p>
            </div>
          </div>
          <div class="form-group">
            <div id="signatoriesList" class="signatories-list"></div>
            <button type="button" id="btnAddSignatory" class="btn-secondary subject-add-btn">+ Add Signatory</button>
            <p class="helper-text">Each signatory shows a drawn signature mark above the line. The name line is optional, and the office/title is also optional.</p>
          </div>
        </section>

        <section class="form-section">
          <div class="section-title-row">
            <div class="section-icon">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0-4 4m4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 16v3h14v-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </div>
            <div>
              <h4 class="section-title">Question Import</h4>
              <p class="section-subtitle">Use the upload button inside each subject row. Paste CSV below only when creating a single-subject quiz.</p>
            </div>
          </div>
          <p class="helper-text" id="cqQuestionFormatHint" style="margin-top:0">Pick the question type above so the upload template and paste-CSV columns match.</p>
          <div class="form-group">
            <label class="form-label" for="cqPaste">Paste CSV</label>
            <textarea id="cqPaste" class="input-beautiful" placeholder="question,optionA,optionB,optionC,optionD,answer,topic,difficulty"></textarea>
          </div>
          <div class="field-grid-2">
            <div class="form-group form-toggle-stack">
              <label class="form-label">Delivery options</label>
              <label class="check-row"><input type="checkbox" id="cqShuffleQs" checked /> <span>Shuffle questions</span></label>
              <label class="check-row" id="cqShuffleOptsRow"><input type="checkbox" id="cqShuffleOpts" checked /> <span>Shuffle options</span></label>
            </div>
          </div>
        </section>
      </div>

      <aside class="advanced-panel">
        <div class="section-title-row compact">
          <div class="section-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3h4l1 3 3 1v4l-3 1-1 3h-4l-1-3-3-1V7l3-1 1-3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="9" r="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>
          </div>
          <div>
            <h3>Advanced Settings</h3>
            <p>Refine delivery, result visibility, and student restrictions.</p>
          </div>
        </div>

        <div class="advanced-block">
          <label class="check-row"><input type="checkbox" id="cqRanking" /> <span>Enable ranking</span></label>
          <p class="helper-text">Students can see their rank when ranking is turned on.</p>
        </div>

        <div class="advanced-block">
          <label class="check-row"><input type="checkbox" id="cqInstantResult" checked /> <span>Show score after submission</span></label>
          <p class="helper-text">Reveal scores immediately after the student submits the quiz.</p>
        </div>

        <div class="advanced-block">
          <label class="check-row"><input type="checkbox" id="cqShowTopicsAfter" /> <span>Show topic breakdown after submission</span></label>
          <p class="helper-text">Let students see performance by topic after the quiz has been submitted.</p>
        </div>

        <div class="advanced-block">
          <label class="check-row"><input type="checkbox" id="cqVertical" /> <span>Vertical UI</span></label>
          <p class="helper-text">Display questions on one page instead of the step-by-step layout.</p>
        </div>

        <div class="advanced-block">
          <label class="form-label" for="cqCalculatorType">Calculator access</label>
          <select id="cqCalculatorType" class="input-beautiful">
            <option value="none">No calculator</option>
            <option value="basic">Basic calculator</option>
            <option value="scientific">Scientific calculator</option>
          </select>
          <p class="helper-text">Basic gives standard arithmetic, percentage, fractions, and memory keys. Scientific adds trigonometry, logs, powers, and advanced functions.</p>
        </div>

        <div class="advanced-block">
          <label class="check-row"><input type="checkbox" id="cqWebcamRequired" /> <span>Require camera during the quiz</span></label>
          <p class="helper-text">Use this only when camera monitoring is compulsory. Students will be told before the quiz starts, and the camera window can be moved during the test.</p>
        </div>
      </aside>
    </div>
    <div class="form-actions">
      <button id="btnPreviewQuizDraft" class="btn-secondary">Preview Questions</button>
      <button id="btnCancelCreate" class="btn-secondary">Cancel</button>
      <button id="btnCreateSave" class="btn-primary">${editingQuiz ? 'Save Changes' : 'Save Quiz'}</button>
    </div>
  `;
  m.appendChild(inner); document.body.appendChild(m);
  enhancePasswordFields(inner);

  // handlers
  setTimeout(()=>{
    const subjectsList = document.getElementById('subjectsList');
    const signatoriesList = document.getElementById('signatoriesList');
    const audienceSelect = document.getElementById('cqAudience');
    const assignedClassSelect = document.getElementById('cqAssignedClass');
    const assignedClassHelp = document.getElementById('cqAssignedClassHelp');
    const assignedClassGroup = document.getElementById('cqAssignedClassGroup');
    let updateSubjectRowSummary = () => {};
    const renderSubjectQuestionImages = (row) => {
      const host = row.querySelector('.subject-image-list');
      if (!host) return;
      const groups = Array.isArray(row._questionImages) ? row._questionImages : [];
      if (!groups.length) {
        host.innerHTML = '<div class="small" style="padding:12px;border:1px dashed #BFDBFE;border-radius:14px;background:#F8FAFC;color:#475569">No question image added for this subject yet.</div>';
        updateSubjectRowSummary(row);
        return;
      }
      host.innerHTML = groups.map((group, index) => `
        <div class="card subject-image-card" data-subject-image-index="${index}" style="padding:12px;border:1px solid #DBEAFE;box-shadow:none">
          <div class="subject-image-card-grid">
            <div class="subject-image-card-thumb">
              ${group.src ? `<img src="${group.src.replace(/"/g, '&quot;')}" alt="${escapeHtml(group.altText || group.fileName || 'Question image')}" />` : '<div class="subject-image-card-placeholder">Choose image</div>'}
              <div class="small subject-image-card-filename">${escapeHtml(group.fileName || 'No image selected')}</div>
            </div>
            <div class="subject-image-card-fields">
              <div>
                <label class="small">Question number(s)</label>
                <input type="text" class="input-beautiful subject-image-numbers" value="${escapeHtml(group.questionNumbersText || '')}" placeholder="e.g. 1, 3, 5" />
                <div class="small" style="margin-top:6px;line-height:1.55">Use commas to separate question numbers. Example: <strong>1, 3, 5</strong> means this same image will show in Questions 1, 3, and 5 for this subject.</div>
              </div>
              <div>
                <label class="small">Image position</label>
                <select class="input-beautiful subject-image-placement">
                  <option value="before" ${normalizeQuestionImagePlacement(group.placement) === 'before' ? 'selected' : ''}>Before the question</option>
                  <option value="after" ${normalizeQuestionImagePlacement(group.placement) === 'after' ? 'selected' : ''}>After the question</option>
                </select>
              </div>
            </div>
            <div class="subject-image-card-actions">
              <button type="button" class="btn btn-secondary btn-sm subject-image-upload-btn">${group.src ? 'Replace Image' : 'Choose Image'}</button>
              <button type="button" class="btn btn-ghost btn-sm subject-image-remove-btn">Remove</button>
            </div>
          </div>
        </div>
      `).join('');
      host.querySelectorAll('[data-subject-image-index]').forEach((card) => {
        const imageIndex = parseInt(card.dataset.subjectImageIndex || '-1', 10);
        if (imageIndex < 0 || !row._questionImages[imageIndex]) return;
        const numbersInput = card.querySelector('.subject-image-numbers');
        const placementSelect = card.querySelector('.subject-image-placement');
        const uploadBtn = card.querySelector('.subject-image-upload-btn');
        const removeBtn = card.querySelector('.subject-image-remove-btn');
        if (numbersInput) numbersInput.oninput = (event) => {
          row._questionImages[imageIndex].questionNumbersText = event.target.value || '';
        };
        if (placementSelect) placementSelect.onchange = (event) => {
          row._questionImages[imageIndex].placement = normalizeQuestionImagePlacement(event.target.value || 'before');
        };
        if (uploadBtn) uploadBtn.onclick = () => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'image/*';
          input.onchange = async (event) => {
            const file = event.target.files[0];
            if (!file) return;
            try {
              row._questionImages[imageIndex] = {
                ...row._questionImages[imageIndex],
                src: await readImageFileAsDataUrl(file),
                fileName: file.name || row._questionImages[imageIndex].fileName,
                altText: row._questionImages[imageIndex].altText || 'Question image'
              };
              renderSubjectQuestionImages(row);
              updateSubjectRowSummary(row);
              showNotification('Question image added for this subject', 'success');
            } catch (error) {
              console.error(error);
              showNotification('Could not read the selected image', 'error');
            }
          };
          input.click();
        };
        if (removeBtn) removeBtn.onclick = () => {
          row._questionImages.splice(imageIndex, 1);
          renderSubjectQuestionImages(row);
          updateSubjectRowSummary(row);
        };
      });
      updateSubjectRowSummary(row);
    };
    const setSubjectRowExpanded = (row, expanded) => {
      if (!row) return;
      row.classList.toggle('subject-collapsed', !expanded);
      const toggle = row.querySelector('.subject-card-toggle');
      const toggleText = row.querySelector('.subject-card-toggle-text');
      if (toggle) toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      if (toggleText) toggleText.textContent = expanded ? 'Collapse' : 'Expand';
    };
    updateSubjectRowSummary = (row) => {
      if (!row) return;
      const allRows = Array.from(subjectsList.querySelectorAll('.subject-row'));
      const rowIndex = allRows.indexOf(row) + 1;
      const subjectName = row.querySelector('.subject-name')?.value.trim() || `Subject ${rowIndex || 1}`;
      const questionCountValue = row.querySelector('.subject-count')?.value || '';
      const totalMarksValue = row.querySelector('.subject-marks')?.value || '';
      const fileStatusText = row._importedQuestions && row._importedQuestions.length
        ? `${row._importedQuestions.length} question(s) loaded`
        : 'No file uploaded';
      const countText = questionCountValue
        ? `${questionCountValue} question${Number(questionCountValue) === 1 ? '' : 's'} per student`
        : 'Questions per student not set';
      const marksText = totalMarksValue
        ? `${formatScoreValue(totalMarksValue)} total mark${Number(totalMarksValue) === 1 ? '' : 's'}`
        : 'Total marks not set';
      const imageCount = Array.isArray(row._questionImages) ? row._questionImages.length : 0;
      const titleEl = row.querySelector('.subject-card-title');
      const pillEl = row.querySelector('.subject-card-pill');
      const subtitleEl = row.querySelector('.subject-card-subtitle');
      const fileChip = row.querySelector('[data-subject-summary="file"]');
      const countChip = row.querySelector('[data-subject-summary="count"]');
      const marksChip = row.querySelector('[data-subject-summary="marks"]');
      if (titleEl) titleEl.textContent = subjectName;
      if (pillEl) pillEl.textContent = `Subject ${rowIndex || 1}`;
      if (subtitleEl) subtitleEl.textContent = imageCount
        ? `${imageCount} optional image group${imageCount === 1 ? '' : 's'} attached for this subject`
        : 'Open this dropdown to manage the file, question count, marks, and optional diagrams.';
      if (fileChip) fileChip.textContent = fileStatusText;
      if (countChip) countChip.textContent = countText;
      if (marksChip) marksChip.textContent = marksText;
      const fileStatusEl = row.querySelector('.subject-file-status');
      if (fileStatusEl) fileStatusEl.textContent = fileStatusText;
      const removeBtn = row.querySelector('.subject-remove-inline');
      if (removeBtn) removeBtn.disabled = allRows.length <= 1;
    };
    const refreshSubjectRowSummaries = () => {
      Array.from(subjectsList.querySelectorAll('.subject-row')).forEach((row) => updateSubjectRowSummary(row));
    };
    const createSubjectRow = (subject = {}) => {
      const row = document.createElement('div');
      row.className = 'subject-row';
      row._importedQuestions = Array.isArray(subject.importedQuestions) ? subject.importedQuestions : [];
      row._questionImages = (
        Array.isArray(subject.questionImages) && subject.questionImages.length
          ? subject.questionImages
          : deriveSubjectQuestionImagesFromQuestions(row._importedQuestions)
      ).map((group, index) => createEditableSubjectQuestionImage(group, index));
      row.innerHTML = `
        <div class="subject-card-head">
          <button type="button" class="subject-card-toggle" aria-expanded="true">
            <div class="subject-card-title-wrap">
              <div class="subject-card-topline">
                <span class="subject-card-pill">Subject</span>
                <span class="subject-card-subtitle">Open this dropdown to manage the file, question count, marks, and optional diagrams.</span>
              </div>
              <div class="subject-card-title">${escapeHtml(subject.name || 'New subject')}</div>
              <div class="subject-card-summary">
                <span class="subject-summary-chip" data-subject-summary="file">No file uploaded</span>
                <span class="subject-summary-chip" data-subject-summary="count">Questions per student not set</span>
                <span class="subject-summary-chip" data-subject-summary="marks">Total marks not set</span>
              </div>
            </div>
            <div class="subject-card-toggle-side">
              <span class="subject-card-toggle-text">Collapse</span>
              <span class="subject-card-chevron" aria-hidden="true">⌄</span>
            </div>
          </button>
          <button type="button" class="subject-remove-btn subject-remove-inline" aria-label="Remove subject">Remove</button>
        </div>
        <div class="subject-card-body">
          <div class="subject-body-grid">
            <div class="subject-field">
              <label class="small">Subject name</label>
              <input type="text" class="input-beautiful subject-name" placeholder="Subject name (e.g. Math)" value="${escapeHtml(subject.name || '')}" />
            </div>
            <div class="subject-field">
              <label class="small">Upload quiz CSV/Excel</label>
              <button type="button" class="btn-secondary subject-upload-btn">Upload File</button>
              <div class="small subject-file-status">${row._importedQuestions.length ? row._importedQuestions.length + ' question(s) loaded' : 'No file uploaded'}</div>
            </div>
            <div class="subject-field">
              <label class="small">Questions per student</label>
              <div class="subject-time-wrap">
                <input type="number" class="input-beautiful subject-count" min="0" placeholder="Questions per student" value="${subject.questionCount ? escapeHtml(subject.questionCount) : ''}" />
                <span class="subject-time-unit">questions</span>
              </div>
            </div>
            <div class="subject-field">
              <label class="small">Total marks for this subject</label>
              <div class="subject-time-wrap">
                <input type="number" class="input-beautiful subject-marks" min="0" step="0.01" placeholder="e.g. 100" value="${subject.totalMarks ? escapeHtml(subject.totalMarks) : ''}" />
                <span class="subject-time-unit">marks</span>
              </div>
            </div>
          </div>
          <div class="subject-field subject-image-field">
            <label class="small">Question images (optional)</label>
            <div class="small" style="margin-top:6px;line-height:1.65">Add an image for any question that needs a diagram, chart, or illustration. You can use the same image for many question numbers and choose whether it shows before or after the question text.</div>
            <div class="subject-image-list" style="display:grid;gap:10px;margin-top:10px"></div>
            <div style="display:flex;justify-content:flex-start;margin-top:10px">
              <button type="button" class="btn btn-ghost btn-sm subject-add-image-btn">Add Question Image</button>
            </div>
          </div>
        </div>
      `;
      renderSubjectQuestionImages(row);
      row.querySelector('.subject-card-toggle').onclick = () => {
        setSubjectRowExpanded(row, row.classList.contains('subject-collapsed'));
      };
      row.querySelector('.subject-name').oninput = () => updateSubjectRowSummary(row);
      row.querySelector('.subject-count').oninput = () => updateSubjectRowSummary(row);
      row.querySelector('.subject-marks').oninput = () => updateSubjectRowSummary(row);
      row.querySelector('.subject-upload-btn').onclick = () => {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = '.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel';
        inp.onchange = async (ev) => {
          const f = ev.target.files[0]; if (!f) return;
          try {
            const expectedType = normalizeQuestionType((document.getElementById('cqDefaultQuestionType') || {}).value || 'mcq');
            row._importedQuestions = (await parseQuestionsFile(f, false, expectedType)).filter(isMeaningfulQuestion);
            row.querySelector('.subject-file-status').textContent = `${row._importedQuestions.length} question(s) loaded`;
            updateSubjectRowSummary(row);
            showNotification(`${row._importedQuestions.length} question(s) loaded for this subject`, 'success');
          } catch (err) {
            console.error(err);
            showNotification('Could not import subject questions', 'error');
          }
        };
        inp.click();
      };
      row.querySelector('.subject-add-image-btn').onclick = () => {
        row._questionImages.push(createEditableSubjectQuestionImage({}, row._questionImages.length));
        renderSubjectQuestionImages(row);
        setSubjectRowExpanded(row, true);
      };
      row.querySelector('.subject-remove-inline').onclick = () => {
        row.remove();
        if (!subjectsList.children.length) createSubjectRow();
        refreshSubjectRowSummaries();
      };
      subjectsList.appendChild(row);
      const shouldExpand = !subject.name || !row._importedQuestions.length || subjectsList.children.length === 1;
      setSubjectRowExpanded(row, shouldExpand);
      updateSubjectRowSummary(row);
      refreshSubjectRowSummaries();
    };
    const createSignatoryRow = (signatory = {}) => {
      const row = document.createElement('div');
      row.className = 'signatory-row';
      row.innerHTML = `
        <div class="subject-field">
          <label class="small">Signatory name</label>
          <input type="text" class="input-beautiful signatory-name" placeholder="e.g. Grace Okafor" value="${escapeHtml(signatory.name || '')}" />
        </div>
        <div class="subject-field">
          <label class="small">Title / label (optional)</label>
          <input type="text" class="input-beautiful signatory-title" placeholder="e.g. Principal" value="${escapeHtml(signatory.title || '')}" />
        </div>
        <label class="check-row signatory-visibility-check"><input type="checkbox" class="signatory-show-name" ${signatory.showNameOnCertificate === false ? '' : 'checked'} /> <span>Show name on certificate</span></label>
        <button type="button" class="subject-remove-btn signatory-remove-btn" aria-label="Remove signatory">✕</button>
      `;
      row.querySelector('.signatory-remove-btn').onclick = () => row.remove();
      signatoriesList.appendChild(row);
    };
    const getSubjectRows = () => Array.from(subjectsList.querySelectorAll('.subject-row')).map(row => {
      const name = row.querySelector('.subject-name').value.trim();
      const countValue = row.querySelector('.subject-count').value;
      const marksValue = row.querySelector('.subject-marks').value;
      return {
        name,
        questionCount: countValue === '' ? null : (parseInt(countValue, 10) || 0),
        totalMarks: marksValue === '' ? null : (parseFloat(marksValue) || 0),
        importedQuestions: (row._importedQuestions || []).filter(isMeaningfulQuestion),
        questionImages: serializeEditableSubjectQuestionImages(row._questionImages || [])
      };
    }).filter(subject => subject.name);
    const updateDerivedTotalMarks = () => {
      const totalMarks = getSubjectRows().reduce((sum, subject) => sum + getSubjectTotalMarks(subject), 0);
      document.getElementById('cqMaxGrade').value = totalMarks ? formatScoreValue(totalMarks) : '';
    };
    const getSignatoryRows = () => Array.from(signatoriesList.querySelectorAll('.signatory-row')).map((row) => ({
      name: row.querySelector('.signatory-name').value.trim(),
      title: row.querySelector('.signatory-title').value.trim(),
      showNameOnCertificate: !!row.querySelector('.signatory-show-name').checked
    })).filter((item) => item.name || item.title);
    const updateAudienceState = () => {
      const classMode = audienceSelect.value === 'class';
      assignedClassSelect.disabled = !classMode || !classNames.length;
      if (assignedClassGroup) assignedClassGroup.style.display = classMode ? '' : 'none';
      if (assignedClassHelp) {
        assignedClassHelp.textContent = classMode
          ? (classNames.length ? 'Choose the uploaded class that should receive this quiz.' : 'No uploaded class yet. Use the Students menu to import one first.')
          : 'Leave this on Public if anyone with the code should be able to take the quiz.';
      }
    };

    if (editingQuiz) {
      document.getElementById('cqExamName').value = editingQuiz.examName || '';
      document.getElementById('cqTitle').value = editingQuiz.title || '';
      audienceSelect.value = editingQuiz.audienceMode || (editingQuiz.assignedClassName ? 'class' : 'public');
      if (editingQuiz.assignedClassName && !classNames.includes(editingQuiz.assignedClassName)) {
        const option = document.createElement('option');
        option.value = editingQuiz.assignedClassName;
        option.textContent = `${editingQuiz.assignedClassName} (not in current upload)`;
        assignedClassSelect.appendChild(option);
      }
      assignedClassSelect.value = editingQuiz.assignedClassName || '';
      document.getElementById('cqPassword').value = editingQuiz.password || '';
      document.getElementById('cqTime').value = editingQuiz.timeLimit || '';
      document.getElementById('cqMaxGrade').value = editingQuiz.maxGrade || '';
      document.getElementById('cqAttemptLimit').value = editingQuiz.attemptLimit || 1;
      document.getElementById('cqPassMark').value = editingQuiz.passMark || 50;
      document.getElementById('cqNegativeEnabled').checked = !!editingQuiz.negativeMarkEnabled;
      document.getElementById('cqNegativeValue').value = editingQuiz.negativeMarkValue || '';
      document.getElementById('cqStart').value = editingQuiz.scheduleStart ? new Date(editingQuiz.scheduleStart).toISOString().slice(0,16) : '';
      document.getElementById('cqEnd').value = editingQuiz.scheduleEnd ? new Date(editingQuiz.scheduleEnd).toISOString().slice(0,16) : '';
      subjectsList.innerHTML = '';
      (editingQuiz.subjects || []).forEach(subject => createSubjectRow({
        name: subject.name || 'General',
        questionCount: subject.questionCount ?? null,
        totalMarks: subject.totalMarks ?? subject.maxScore ?? null,
        importedQuestions: Array.isArray(subject.bankQuestions) && subject.bankQuestions.length ? subject.bankQuestions : subject.questions,
        questionImages: Array.isArray(subject.questionImages) && subject.questionImages.length
          ? subject.questionImages
          : deriveSubjectQuestionImagesFromQuestions(Array.isArray(subject.bankQuestions) && subject.bankQuestions.length ? subject.bankQuestions : subject.questions)
      }));
      document.getElementById('cqShuffleQs').checked = editingQuiz.shuffleQs !== false;
      document.getElementById('cqShuffleOpts').checked = editingQuiz.shuffleOpts !== false;
      document.getElementById('cqRanking').checked = !!editingQuiz.rankingEnabled;
      document.getElementById('cqInstantResult').checked = editingQuiz.showInstantResult !== false;
      document.getElementById('cqShowTopicsAfter').checked = !!editingQuiz.showTopicsAfterSubmission;
      document.getElementById('cqVertical').checked = !!editingQuiz.verticalLayout;
      document.getElementById('cqCalculatorType').value = getQuizCalculatorType(editingQuiz);
      document.getElementById('cqWebcamRequired').checked = !!editingQuiz.webcamRequired;
      document.getElementById('cqDefaultQuestionType').value = normalizeQuestionType(editingQuiz.defaultQuestionType || inferQuizDefaultQuestionType(editingQuiz));
      normalizeCertificateSignatories(editingQuiz.certificateSignatories).forEach(createSignatoryRow);
    } else if (templateQuiz) {
      document.getElementById('cqTitle').value = templateQuiz.title || '';
      subjectsList.innerHTML = '';
      (templateQuiz.subjects || []).forEach(subject => createSubjectRow({
        name: subject.name || 'General',
        questionCount: subject.questionCount ?? null,
        totalMarks: subject.totalMarks ?? subject.maxScore ?? null,
        importedQuestions: Array.isArray(subject.bankQuestions) && subject.bankQuestions.length ? subject.bankQuestions : subject.questions,
        questionImages: Array.isArray(subject.questionImages) && subject.questionImages.length
          ? subject.questionImages
          : deriveSubjectQuestionImagesFromQuestions(Array.isArray(subject.bankQuestions) && subject.bankQuestions.length ? subject.bankQuestions : subject.questions)
      }));
      audienceSelect.value = 'public';
      document.getElementById('cqCalculatorType').value = 'basic';
      document.getElementById('cqDefaultQuestionType').value = normalizeQuestionType(templateQuiz.defaultQuestionType || inferQuizDefaultQuestionType(templateQuiz));
    } else {
      audienceSelect.value = 'public';
      document.getElementById('cqCalculatorType').value = 'basic';
      document.getElementById('cqDefaultQuestionType').value = 'mcq';
    }
    if (!subjectsList.children.length) createSubjectRow();
    subjectsList.addEventListener('input', updateDerivedTotalMarks);
    subjectsList.addEventListener('change', updateDerivedTotalMarks);
    updateDerivedTotalMarks();
    updateAudienceState();
    audienceSelect.onchange = updateAudienceState;
    const defaultTypeSelect = document.getElementById('cqDefaultQuestionType');
    const updateQuestionTypeUi = () => {
      const type = normalizeQuestionType(defaultTypeSelect.value || 'mcq');
      const layout = getQuizFormatLayoutForType(type);
      const pasteEl = document.getElementById('cqPaste');
      if (pasteEl) {
        pasteEl.placeholder = layout.csvHeader;
        pasteEl.setAttribute('data-question-type', type);
      }
      const hintEl = document.getElementById('cqQuestionFormatHint');
      if (hintEl) hintEl.innerHTML = layout.hintHtml;
      const shuffleRow = document.getElementById('cqShuffleOptsRow');
      if (shuffleRow) shuffleRow.style.display = type === 'mcq' ? '' : 'none';
      const shuffleInput = document.getElementById('cqShuffleOpts');
      if (shuffleInput && type !== 'mcq') shuffleInput.checked = false;
    };
    defaultTypeSelect.onchange = updateQuestionTypeUi;
    updateQuestionTypeUi();
    document.getElementById('btnAddSubject').onclick = () => createSubjectRow();
    document.getElementById('btnAddSignatory').onclick = () => createSignatoryRow();
    document.getElementById('closeCreate').onclick = ()=>m.remove();
    document.getElementById('btnCancelCreate').onclick = ()=>m.remove();
    document.getElementById('btnExportTemplate').onclick = ()=> exportQuizTemplate(normalizeQuestionType(defaultTypeSelect.value || 'mcq'));
    document.getElementById('btnPreviewQuizDraft').onclick = () => {
      const subjects = getSubjectRows();
      const previewType = normalizeQuestionType(defaultTypeSelect.value || 'mcq');
      const pastedBank = (document.getElementById('cqPaste').value || '').trim()
        ? parseQuestionsFromCSVString(document.getElementById('cqPaste').value.trim(), previewType).filter(isMeaningfulQuestion)
        : [];
      const previewSubjects = subjects.map((subject, subjectIndex) => {
        const sourceBank = subject.importedQuestions && subject.importedQuestions.length
          ? subject.importedQuestions
          : (subjectIndex === 0 ? pastedBank : []);
        return {
          name: subject.name || `Subject ${subjectIndex + 1}`,
          questions: buildQuestionsWithSubjectImages(sourceBank, subject.name || `Subject ${subjectIndex + 1}`, subject.questionImages || [], { replaceExistingMedia: true })
        };
      }).filter((subject) => (subject.questions || []).length);
      if (!previewSubjects.length) return showNotification('No questions to preview yet. Upload or paste questions first.', 'error');
      let previewModal = document.getElementById('quizDraftPreviewModal');
      if (previewModal) previewModal.remove();
      previewModal = document.createElement('div');
      previewModal.id = 'quizDraftPreviewModal';
      previewModal.className = 'student-result-modal';
      const previewCard = document.createElement('div');
      previewCard.className = 'card-beautiful admin-modal-card';
      previewCard.style.width = 'min(960px, 96vw)';
      let previewSubjectIndex = 0;
      let previewQuestionIndex = 0;
      const renderPreview = () => {
        const currentSubject = previewSubjects[previewSubjectIndex];
        const currentQuestion = (currentSubject.questions || [])[previewQuestionIndex];
        previewCard.innerHTML = `
          <div class="page-heading">
            <div>
              <div class="h2">Quiz Preview</div>
              <div class="small">Review the question flow before saving. Close this preview to continue editing in the builder.</div>
            </div>
            <button id="closeQuizDraftPreview" class="btn btn-ghost">Close</button>
          </div>
          <div class="quiz-content-toolbar">
            <div>
              <div class="small">Subject</div>
              <select id="draftPreviewSubjectSelect" class="input-beautiful" style="min-width:220px">
                ${previewSubjects.map((subject, index) => `<option value="${index}" ${index === previewSubjectIndex ? 'selected' : ''}>${escapeHtml(subject.name)} (${subject.questions.length})</option>`).join('')}
              </select>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button type="button" id="draftPreviewPrev" class="btn btn-ghost btn-sm"${previewQuestionIndex === 0 ? ' disabled' : ''}>Previous Question</button>
              <button type="button" id="draftPreviewNext" class="btn btn-primary btn-sm"${previewQuestionIndex >= currentSubject.questions.length - 1 ? ' disabled' : ''}>Next Question</button>
            </div>
          </div>
          <div class="card quiz-editor-question-card">
            <div class="h3">Question ${previewQuestionIndex + 1} of ${currentSubject.questions.length}</div>
            <div class="small" style="margin:6px 0 14px">${escapeHtml(currentSubject.name)}</div>
            ${renderQuestionMediaAssets(currentQuestion, 'before')}
            <div class="preserve-format rich-text-output" style="font-weight:700;line-height:1.7">${renderRichTextHtml(currentQuestion?.question || '')}</div>
            ${renderQuestionMediaAssets(currentQuestion, 'after')}
            <div class="quiz-editor-options-grid" style="margin-top:16px">
              ${(currentQuestion?.options || []).map((option, optionIndex) => {
                const letter = String.fromCharCode(65 + optionIndex);
                const correct = (currentQuestion.answer || '') === letter;
                return `<div class="card" style="padding:12px;border:${correct ? '2px solid #10B981' : '1px solid #E5E7EB'}"><strong>${letter}.</strong><div class="preserve-format rich-text-output" style="margin-top:6px">${renderRichTextHtml(option)}</div>${correct ? '<div class="small" style="margin-top:6px;color:#047857;font-weight:700">Correct answer</div>' : ''}</div>`;
              }).join('')}
            </div>
            <div class="field-grid-2" style="margin-top:16px">
              <div class="card" style="padding:12px"><div class="small">Topic</div><div class="rich-text-output">${renderRichTextHtml(currentQuestion?.topic || 'Not set')}</div></div>
              <div class="card" style="padding:12px"><div class="small">Difficulty</div><div>${escapeHtml(currentQuestion?.difficulty || 'Medium')}</div></div>
            </div>
            <div class="field-grid-2" style="margin-top:16px">
              <div class="card" style="padding:12px"><div class="small">Explanation</div><div class="rich-text-output" style="margin-top:8px;line-height:1.7">${renderRichTextHtml(currentQuestion?.explanation || 'No explanation provided yet.')}</div></div>
              <div class="card" style="padding:12px"><div class="small">Learning Point</div><div class="rich-text-output" style="margin-top:8px;line-height:1.7">${renderRichTextHtml(currentQuestion?.learningPoint || 'No learning point provided yet.')}</div></div>
            </div>
            <div class="card" style="padding:12px;margin-top:16px"><div class="small">Key Concept</div><div class="rich-text-output" style="margin-top:8px;line-height:1.7">${renderRichTextHtml(currentQuestion?.keyConcept || currentQuestion?.topic || 'Not set')}</div></div>
          </div>
        `;
        previewModal.appendChild(previewCard);
        document.body.appendChild(previewModal);
        document.getElementById('closeQuizDraftPreview').onclick = () => previewModal.remove();
        document.getElementById('draftPreviewSubjectSelect').onchange = (event) => {
          previewSubjectIndex = parseInt(event.target.value || '0', 10) || 0;
          previewQuestionIndex = 0;
          renderPreview();
        };
        document.getElementById('draftPreviewPrev').onclick = () => {
          previewQuestionIndex = Math.max(0, previewQuestionIndex - 1);
          renderPreview();
        };
        document.getElementById('draftPreviewNext').onclick = () => {
          previewQuestionIndex = Math.min((previewSubjects[previewSubjectIndex].questions || []).length - 1, previewQuestionIndex + 1);
          renderPreview();
        };
      };
      previewModal.onclick = (event) => { if (event.target === previewModal) previewModal.remove(); };
      renderPreview();
    };
    enhancePasswordFields(inner);
    const goToStudentsBtn = document.getElementById('goToStudentsFromQuiz');
    if (goToStudentsBtn) goToStudentsBtn.onclick = () => {
      m.remove();
      state.view = 'teacher.students';
      render();
    };

    document.getElementById('btnCreateSave').onclick = async ()=>{
      const examName = document.getElementById('cqExamName').value.trim();
      const title = document.getElementById('cqTitle').value.trim();
      const audienceMode = audienceSelect.value || '';
      const assignedClassName = normalizeClassName(assignedClassSelect.value || '');
      const password = document.getElementById('cqPassword').value || '';
      const time = parseInt(document.getElementById('cqTime').value,10) || 0;
      const attemptLimit = parseInt(document.getElementById('cqAttemptLimit').value,10) || 1;
      const passMark = parseFloat(document.getElementById('cqPassMark').value) || 50;
      const negativeMarkEnabled = document.getElementById('cqNegativeEnabled').checked;
      const negativeMarkValue = parseFloat(document.getElementById('cqNegativeValue').value) || 0;
      const scheduleStart = document.getElementById('cqStart').value || '';
      const scheduleEnd = document.getElementById('cqEnd').value || '';
      const calculatorType = getQuizCalculatorType({ calculatorType: document.getElementById('cqCalculatorType').value || 'none' });
      const defaultQuestionType = normalizeQuestionType(document.getElementById('cqDefaultQuestionType').value || 'mcq');
      const applyDefaultQuestionType = (list) => (Array.isArray(list) ? list : []).map((question) => {
        if (!question || typeof question !== 'object') return question;
        if (question.type) return question;
        return { ...question, type: defaultQuestionType };
      });
      if (!audienceMode) return showNotification('Choose who can take this quiz', 'error');
      if (audienceMode === 'class' && !assignedClassName) return showNotification('Choose the uploaded class for this quiz', 'error');
      if (scheduleStart && scheduleEnd && new Date(scheduleStart) >= new Date(scheduleEnd)) return showNotification('End time must be after start time', 'error');
      const subjects = getSubjectRows();
      const pastedBank = (document.getElementById('cqPaste').value||'').trim()
        ? parseQuestionsFromCSVString(document.getElementById('cqPaste').value.trim(), defaultQuestionType).filter(isMeaningfulQuestion)
        : [];
      const shuffleQs = document.getElementById('cqShuffleQs').checked;
      const shuffleOpts = document.getElementById('cqShuffleOpts').checked;
      let subjectsArr;
      const hasSubjectUploads = subjects.some(subject => subject.importedQuestions && subject.importedQuestions.length);
      if (hasSubjectUploads || pastedBank.length || !editingQuiz) {
        subjectsArr = subjects.map((subject, subjectIndex) => {
          const sourceBank = applyDefaultQuestionType(subject.importedQuestions && subject.importedQuestions.length
            ? subject.importedQuestions
            : (subjectIndex === 0 ? pastedBank : []));
          const questionImages = normalizeSubjectQuestionImages(subject.questionImages || []);
          const questions = buildQuestionsWithSubjectImages(sourceBank, subject.name, questionImages, { replaceExistingMedia: true });
          return {
            name: subject.name,
            questions,
            bankQuestions: questions.slice(),
            questionImages,
            questionCount: subject.questionCount || null,
            totalMarks: getSubjectTotalMarks(subject)
          };
        });
      } else {
        subjectsArr = (editingQuiz.subjects || []).map((subject, idx) => {
          const nextSubject = subjects[idx] || {};
          const nextName = nextSubject.name || subject.name || 'General';
          const sourceQuestions = applyDefaultQuestionType(Array.isArray(subject.bankQuestions) && subject.bankQuestions.length ? subject.bankQuestions : subject.questions);
          const questionImages = normalizeSubjectQuestionImages(
            nextSubject.questionImages
            || subject.questionImages
            || deriveSubjectQuestionImagesFromQuestions(sourceQuestions)
          );
          const questions = buildQuestionsWithSubjectImages(sourceQuestions || [], nextName, questionImages, { replaceExistingMedia: true });
          return {
            ...subject,
            name: nextName,
            questions,
            bankQuestions: questions.slice(),
            questionImages,
            questionCount: nextSubject.questionCount ?? subject.questionCount ?? null,
            totalMarks: getSubjectTotalMarks(nextSubject || subject)
          };
        });
      }

      const id = editingQuiz ? editingQuiz.id : gen6DigitId();
      const now = new Date().toISOString();
      const maxGrade = getQuizTotalMarks({ subjects: subjectsArr });
      const selectedStudents = audienceMode === 'class'
        ? getStudentsForTeacher(quizOwnerId).filter((student) => normalizeClassName(student.className || student.class || '') === assignedClassName)
        : [];
      if (audienceMode === 'class' && !selectedStudents.length) return showNotification('That class has no uploaded students yet. Open Students and import the class first.', 'error', 7000);
      const whitelist = selectedStudents.map((student) => ({
        name: student.name || '',
        email: student.email || '',
        id: student.id || student.registrationNo || '',
        registrationNo: student.registrationNo || student.id || '',
        className: normalizeClassName(student.className || student.class || '')
      }));
      const qobj = { ...(editingQuiz || {}), id, examName, title: title || 'Untitled Quiz', password: password || '', timeLimit: time, maxGrade: maxGrade, attemptLimit, passMark, negativeMarkEnabled, negativeMarkValue, showInstantResult: document.getElementById('cqInstantResult').checked, showTopicsAfterSubmission: document.getElementById('cqShowTopicsAfter').checked, subjects: subjectsArr, questionPickCount: 0, createdAt: editingQuiz?.createdAt || now, editedAt: editingQuiz ? now : '', updatedAt: now, teacherId: quizOwnerId, shuffleQs, shuffleOpts, verticalLayout: document.getElementById('cqVertical').checked, rankingEnabled: document.getElementById('cqRanking').checked, whitelist, audienceMode, assignedClassName: audienceMode === 'class' ? assignedClassName : '', calculatorType, webcamRequired: document.getElementById('cqWebcamRequired').checked, defaultQuestionType, certificateSignatories: getSignatoryRows(), scheduleStart: scheduleStart ? new Date(scheduleStart).toISOString() : '', scheduleEnd: scheduleEnd ? new Date(scheduleEnd).toISOString() : '' };
      const accessResult = consumeTeacherAccessForQuizSave({
        teacherId: quizOwnerId,
        quizId: id,
        quizTitle: qobj.title,
        isEditingExisting: !!editingQuiz
      });
      if (!accessResult.ok) {
        showNotification(accessResult.message || 'You need tokens before saving this quiz.', 'error', 7000);
        showLicenseRequired();
        return;
      }
      const quizzes = getAllQuizzes(); quizzes[id] = qobj;
      // Local-only persist; pushSingleQuizToCloud below handles the cloud upload.
      saveAllQuizzes(quizzes, { skipNetworkSync: true });
      const didRegrade = regradeSubmissionsForQuiz(qobj);
      if (state.currentQuiz && state.currentQuiz.id === id) state.currentQuiz = qobj;
      if (audienceMode === 'class') selectedStudents.forEach((student) => upsertStudentForTeacher(quizOwnerId, { ...student, sourceQuizId: id }, id));
      // Automatic per-quiz upload — ONE attempt, no retry loop. If it fails the
      // quiz just stays "Pending cloud sync" and the teacher uses the per-quiz
      // "Sync To Cloud" button (which does retry) from the quiz list.
      const singleQuizOk = await pushSingleQuizToCloud(qobj, { auto: true });
      // Submissions per-quiz instead of the bulk submissions push that's now
      // blocked for teachers. Students/teachers/token rows are still small
      // bulk syncs.
      let submissionsCloudOk = true;
      if (didRegrade) {
        const quizSubs = getAllSubmissions({ includeDeleted: true }).filter((s) => s && s.quizId === id);
        submissionsCloudOk = await pushSingleQuizSubmissionsToCloud(id, quizSubs, { auto: true });
      }
      const fallbackKeys = singleQuizOk ? [] : [STORAGE_KEYS.quizzes];
      const sharedSyncOk = await syncSharedKeys([
        ...fallbackKeys,
        STORAGE_KEYS.students,
        ...((accessResult.mode === 'token' || accessResult.mode === 'unlimited') ? [STORAGE_KEYS.teachers, STORAGE_KEYS.tokenTransactions] : [])
      ]);
      const quizCloudSaved = singleQuizOk && submissionsCloudOk && sharedSyncOk;
      if (quizCloudSaved) {
        markQuizzesCloudSynced([id]);
      }
      if (quizCloudSaved) {
        showNotification((editingQuiz ? 'Quiz updated' : 'Quiz saved') + '   ID: '+id,'success');
      } else {
        showNotification(`${editingQuiz ? 'Quiz updated' : 'Quiz saved'}   ID: ${id}. ${getSharedSyncWarningMessage()} Quiz IDs may not open on other devices yet.`, 'warning', 8000);
      }
      state.currentQuiz = qobj;
      state.view = 'teacher.quizzes';
      m.remove();
      render();
    };
  },0);
}

function buildQuestionFromRowParts(parts, type) {
  const t = normalizeQuestionType(type);
  const cell = (index) => (parts[index] != null ? parts[index].toString() : '');
  if (t === 'yesno') {
    return {
      type: 'yesno',
      question: cell(0),
      answer: cell(1).trim(),
      options: [],
      topic: cell(2),
      difficulty: cell(3) || 'Medium',
      explanation: cell(4),
      learningPoint: cell(5),
      keyConcept: cell(6)
    };
  }
  if (t === 'short') {
    return {
      type: 'short',
      question: cell(0),
      acceptedAnswers: normalizeAcceptedAnswers(cell(1).replace(/[|;]/g, '\n')),
      options: [],
      topic: cell(2),
      difficulty: cell(3) || 'Medium',
      explanation: cell(4),
      learningPoint: cell(5),
      keyConcept: cell(6)
    };
  }
  if (t === 'essay') {
    return {
      type: 'essay',
      question: cell(0),
      options: [],
      answer: '',
      topic: cell(1),
      difficulty: cell(2) || 'Medium',
      explanation: cell(3),
      learningPoint: cell(4),
      keyConcept: cell(5)
    };
  }
  // mcq (default)
  return {
    type: 'mcq',
    question: cell(0),
    options: [cell(1), cell(2), cell(3), cell(4)].filter((option) => getRichTextPlainText(option || '').trim()),
    answer: getRichTextPlainText(cell(5)).toUpperCase(),
    topic: cell(6),
    difficulty: getRichTextPlainText(cell(7)) || 'Medium',
    explanation: cell(8),
    learningPoint: cell(9),
    keyConcept: cell(10)
  };
}

function parseQuestionsFromCSVString(s, type = 'mcq') {
  const lines = s.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const parts = line.split(/\s*,\s*/);
    if ((parts[0] || '').toLowerCase() === 'question') continue;
    const q = buildQuestionFromRowParts(parts, type);
    if (isMeaningfulQuestion(q)) out.push(q);
  }
  return out;
}

function getWorksheetCellTextValue(cell, options = {}) {
  if (!cell) return '';
  const preferRichText = options.preserveRichText !== false;
  if (preferRichText && typeof cell.h === 'string' && cell.h.trim()) {
    return renderRichTextHtml(cell.h);
  }
  if (typeof cell.w === 'string' && cell.w.trim()) {
    return normalizeRichText(cell.w);
  }
  if (cell.v == null) return '';
  return normalizeRichText(String(cell.v));
}

function readWorksheetRows(worksheet, columnCount = 11, options = {}) {
  if (!worksheet || typeof XLSX === 'undefined' || !worksheet['!ref']) return [];
  const range = XLSX.utils.decode_range(worksheet['!ref']);
  const rows = [];
  for (let rowIndex = 1; rowIndex <= range.e.r; rowIndex++) {
    const row = Array.from({ length: columnCount }, (_, columnIndex) => {
      const cellAddress = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
      return getWorksheetCellTextValue(worksheet[cellAddress], options);
    });
    const hasContent = row.some((cell) => {
      const plain = getRichTextPlainText(cell || '');
      return plain.trim().length > 0;
    });
    if (hasContent) rows.push(row);
  }
  return rows;
}

function parseQuestionsFile(file, whitelistOnly, expectedType = 'mcq') {
  return new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onload = (e)=>{
      try {
        const data = e.target.result;
        const t = normalizeQuestionType(expectedType);
        // Read enough columns for the widest schema (MCQ = 11). Narrower types
        // simply ignore the trailing empty cells via buildQuestionFromRowParts.
        const columnCount = whitelistOnly ? 4 : 11;
        let workbook;
        if (typeof XLSX !== 'undefined') {
          workbook = XLSX.read(data, { type: 'binary', cellHTML: true, cellStyles: true, cellText: true });
          const sheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[sheetName];
          const rows = readWorksheetRows(worksheet, columnCount, { preserveRichText: !whitelistOnly });
          if (whitelistOnly) {
            const list = rows.map(r=>({ name: r[0]||'', email: (r[1]||'').toString(), id: (r[2]||'').toString(), registrationNo: (r[2]||'').toString(), className: normalizeClassName(r[3] || '') } )).filter(x=>x.name && (x.email || x.id));
            resolve(list);
          } else {
            const list = rows.map((r) => buildQuestionFromRowParts(r, t)).filter(isMeaningfulQuestion);
            resolve(list);
          }
        } else {
          // Fallback CSV
          const text = data;
          if (whitelistOnly) {
            const lines = text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
            const list = lines.map(l=>{ const p = l.split(','); return { name: p[0]||'', email: p[1]||'', id: p[2]||'', registrationNo: p[2]||'', className: normalizeClassName(p[3] || '') }; }).filter((x, index) => index > 0 && x.name && (x.email || x.id));
            resolve(list);
          } else { resolve(parseQuestionsFromCSVString(text, t)); }
        }
      } catch (err) { reject(err); }
    };
    // read as binary string for XLSX
    try { reader.readAsBinaryString(file); } catch(e) { reader.readAsText(file); }
  });
}

function showLocalNetworkGuide() {
  let m = document.getElementById('localNetGuide'); if (m) m.remove();
  m = document.createElement('div'); m.id='localNetGuide'; m.style.position='fixed'; m.style.inset='0'; m.style.zIndex=20000; m.style.background='rgba(0,0,0,0.4)';
  const inner = document.createElement('div'); inner.className='card-beautiful p-6'; inner.style.width='720px'; inner.style.maxWidth='94%';
  inner.innerHTML = `
    <h3>Local Network + Cloud Sync Setup</h3>
    <p class="small">For teachers, licenses, quizzes, and results to sync across devices, every device must reach the same OPE Assessor Node server. Current sync target: <strong>${escapeHtml(getCurrentSyncServerLabel())}</strong>.</p>
    <ol class="small">
      <li>On Windows: open Command Prompt and run <code>ipconfig</code>. Look for "IPv4 Address" under your active adapter.</li>
      <li>On macOS / Linux: run <code>ifconfig</code> or <code>ip addr</code> in Terminal and find the active interface's address (usually 192.168.x.x).</li>
      <li>Start the real OPE Assessor server in this project folder with <code>npm start</code>. Do not use <code>python -m http.server</code> for shared sync because that serves files only and does not provide the <code>/api</code> endpoints.</li>
      <li>Share the address shown by the server, for example <code>http://192.168.x.y:3015</code>, and open that same address on every teacher and student device.</li>
      <li>If your frontend is hosted somewhere else, open <strong>Settings &gt; Cloud Sync</strong> on each device and enter the Node server URL there, then test <code>${escapeHtml(buildApiUrl('/api/health'))}</code>.</li>
    </ol>
    <div style="display:flex;justify-content:flex-end;margin-top:12px"><button id="closeNetGuide" class="btn-pastel-secondary">Close</button></div>
  `;
  m.appendChild(inner); document.body.appendChild(m);
  document.getElementById('closeNetGuide').onclick = ()=>m.remove();
}

// Schemas per question type. Each entry describes the expected column order
// for an uploaded CSV/Excel file, the placeholder for the paste-CSV box, and
// the helper hint shown beneath the question-type dropdown so the teacher
// knows what columns to put in the spreadsheet.
const QUIZ_TEMPLATE_SCHEMAS = {
  mcq: {
    columns: ['question','optA','optB','optC','optD','answer','topic','difficulty','explanation','learningPoint','keyConcept'],
    sample: ['What is 2+2?','3','4','5','6','B','Arithmetic','Easy','2 + 2 gives 4 because it is simple addition.','Check the numbers and add carefully.','Addition'],
    fileName: 'ope-quiz-template-mcq.xlsx',
    csvHeader: 'question,optionA,optionB,optionC,optionD,answer,topic,difficulty,explanation,learningPoint,keyConcept',
    hint: 'Multiple Choice columns: question, optA, optB, optC, optD, answer (A/B/C/D), topic, difficulty, explanation, learningPoint, keyConcept.'
  },
  yesno: {
    columns: ['question','answer','topic','difficulty','explanation','learningPoint','keyConcept'],
    sample: ['Is the sky blue on a clear day?','Yes','Science','Easy','Light scattering makes the sky appear blue.','Recall the colour of a clear daytime sky.','Sky'],
    fileName: 'ope-quiz-template-yesno.xlsx',
    csvHeader: 'question,answer,topic,difficulty,explanation,learningPoint,keyConcept',
    hint: 'Yes / No columns: question, answer (Yes or No), topic, difficulty, explanation, learningPoint, keyConcept. No option columns are needed.'
  },
  short: {
    columns: ['question','acceptedAnswers','topic','difficulty','explanation','learningPoint','keyConcept'],
    sample: ['What is the capital of France?','Paris | paris | PARIS','Geography','Easy','Paris is the capital and largest city of France.','Recall European capitals.','Capitals'],
    fileName: 'ope-quiz-template-short-answer.xlsx',
    csvHeader: 'question,acceptedAnswers,topic,difficulty,explanation,learningPoint,keyConcept',
    hint: 'Short Answer columns: question, acceptedAnswers (separate every accepted spelling with | or ;), topic, difficulty, explanation, learningPoint, keyConcept.'
  },
  essay: {
    columns: ['question','topic','difficulty','explanation','learningPoint','keyConcept'],
    sample: ['Discuss the impact of the Industrial Revolution on urban life.','History','Hard','Cover migration to cities, factory work, and living conditions.','Connect economic shifts to social change.','Industrial Revolution'],
    fileName: 'ope-quiz-template-essay.xlsx',
    csvHeader: 'question,topic,difficulty,explanation,learningPoint,keyConcept',
    hint: 'Long Answer (Essay) columns: question, topic, difficulty, explanation, learningPoint, keyConcept. Essays are graded manually so no answer column is needed.'
  }
};

function getQuizTemplateSchema(type) {
  return QUIZ_TEMPLATE_SCHEMAS[normalizeQuestionType(type)] || QUIZ_TEMPLATE_SCHEMAS.mcq;
}

function getQuizFormatLayoutForType(type) {
  const schema = getQuizTemplateSchema(type);
  return {
    csvHeader: schema.csvHeader,
    hintHtml: `<strong>Format for this quiz type:</strong> ${escapeHtml(schema.hint)}`
  };
}

function exportQuizTemplate(type = 'mcq') {
  const schema = getQuizTemplateSchema(type);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([schema.columns, schema.sample]);
  XLSX.utils.book_append_sheet(wb, ws, 'Template');
  XLSX.writeFile(wb, schema.fileName);
  showNotification(`Template exported (${schema.columns.length} columns)`, 'success');
}

// =================== Visibility / Tab Detection ===================
let _visibilityTimer = null;
document.addEventListener('visibilitychange', ()=>{
  if (state.view === 'take' && state.currentSubmission?.examStarted) {
    if (isManualExamSubmitFlowActive()) return;
    if (document.hidden) {
      if (state.currentSubmission) {
        state.currentSubmission.monitoring = state.currentSubmission.monitoring || {};
        state.currentSubmission.monitoring.tabSwitches = (state.currentSubmission.monitoring.tabSwitches || 0) + 1;
      }
      // show overlay warning and start 5s timer
      showNotification('You left the exam tab   return within 5s or exam auto-submits','warning',5000);
      _visibilityTimer = setTimeout(()=>{ collectAndSubmit(); }, 5000);
    } else {
      if (_visibilityTimer) { clearTimeout(_visibilityTimer); _visibilityTimer = null; showNotification('Returned to exam','success'); }
    }
  }
});

// =================== Submission Locking & Ranking ===================
function hasSubmittedBefore(quizId, email) {
  const target = normalizeEmail(email);
  const hit = (s) => s && s.quizId === quizId && normalizeEmail(s.email) === target;
  return getAllSubmissions().some(hit) || getSubmissionOutbox().some(hit);
}

function getAttemptCount(quizId, email) {
  const key = normalizeEmail(email);
  return getAllSubmissions().filter(s => s.quizId === quizId && normalizeEmail(s.email) === key).length;
}

function getDraftKey(quizId, email) {
  return `ope_exam_draft_${quizId}_${normalizeEmail(email)}`;
}

function saveExamDraft(submission) {
  if (!submission || !submission.quizId || !submission.email) return;
  try {
    localStorage[getDraftKey(submission.quizId, submission.email)] = JSON.stringify({
      answers: submission.answers || {},
      flagged: submission.flagged || {},
      currentIndex: submission.currentIndex || 0,
      startedAt: submission.startedAt || '',
      savedAt: new Date().toISOString()
    });
  } catch(e) {}
}

function loadExamDraft(quizId, email) {
  try { return JSON.parse(localStorage[getDraftKey(quizId, email)] || 'null'); } catch(e) { return null; }
}

function clearExamDraft(quizId, email) {
  try { localStorage.removeItem(getDraftKey(quizId, email)); } catch(e) {}
}

function getQuizAnswerMap(quiz) {
  const map = {};
  (quiz.subjects || []).forEach(subject => {
    const source = Array.isArray(subject.bankQuestions) && subject.bankQuestions.length ? subject.bankQuestions : subject.questions;
    (source || []).forEach((question, index) => {
      const normalized = normalizeQuestionForStorage(question, index, subject.name || 'General');
      map[normalized._sourceId] = normalized.answer;
    });
  });
  return map;
}

// Full live-question lookup so grading and the facility index can compare
// against the latest correct answer/options/accepted-answers — picks up any
// edits the teacher made to the quiz after submissions were recorded.
function getQuizLiveQuestionMap(quiz) {
  const map = {};
  (quiz?.subjects || []).forEach((subject) => {
    const source = Array.isArray(subject?.bankQuestions) && subject.bankQuestions.length ? subject.bankQuestions : subject?.questions;
    (source || []).forEach((question, index) => {
      const normalized = normalizeQuestionForStorage(question, index, subject?.name || 'General');
      if (normalized._sourceId) map[normalized._sourceId] = normalized;
    });
  });
  return map;
}

// Decide if a single answer is correct, normalized per question type.
// Returns one of 'correct' | 'wrong' | 'pending' | 'unanswered'.
//
// `liveQuestionMap` (optional) lets us compare against the current quiz
// definition rather than the snapshot stored on the submission. That way, when
// the teacher edits the correct answer, an option's text, the yes/no answer,
// or accepted short-answer spellings, every existing submission re-grades
// against the new answer key — which is exactly what the results page and
// facility index are expected to reflect.
function evaluateAnswerForQuestion(question, rawAnswer, answerMap, index, liveQuestionMap) {
  const qType = normalizeQuestionType(question && question.type);
  const stored = rawAnswer == null ? '' : rawAnswer.toString();
  const trimmed = stored.trim();
  if (!trimmed) return 'unanswered';
  const sourceId = (question && question._sourceId) || makeQuestionId(question, index);
  const liveQuestion = liveQuestionMap ? liveQuestionMap[sourceId] : null;
  if (qType === 'mcq') {
    if (liveQuestion) {
      // Compare by option text so option reordering or answer-letter edits are
      // honoured. The student's letter still maps to the option text they saw
      // (taken from the snapshot). If that text now matches the live correct
      // option, count it as correct — independent of letters.
      const chosenLetter = trimmed.toUpperCase();
      const chosenIndex = chosenLetter.charCodeAt(0) - 65;
      const snapshotOptions = Array.isArray(question && question.options) ? question.options : [];
      const chosenText = snapshotOptions[chosenIndex] || '';
      const liveCorrectLetter = (liveQuestion.answer || '').toString().toUpperCase();
      const liveCorrectIndex = liveCorrectLetter.charCodeAt(0) - 65;
      const liveOptions = Array.isArray(liveQuestion.options) ? liveQuestion.options : [];
      const liveCorrectText = liveOptions[liveCorrectIndex] || '';
      if (chosenText && liveCorrectText) {
        return chosenText === liveCorrectText ? 'correct' : 'wrong';
      }
    }
    const correctAnswer = ((question && question.answer) || (answerMap && answerMap[sourceId]) || '').toString().toUpperCase();
    return trimmed.toUpperCase() === correctAnswer ? 'correct' : 'wrong';
  }
  if (qType === 'yesno') {
    const liveAnswer = (liveQuestion && liveQuestion.answer) || (question && question.answer) || '';
    return trimmed.toLowerCase() === liveAnswer.toString().trim().toLowerCase() ? 'correct' : 'wrong';
  }
  if (qType === 'short') {
    const accepted = Array.isArray(liveQuestion?.acceptedAnswers) && liveQuestion.acceptedAnswers.length
      ? liveQuestion.acceptedAnswers
      : (Array.isArray(question?.acceptedAnswers) ? question.acceptedAnswers : []);
    const norm = trimmed.toLowerCase();
    return accepted.some((entry) => (entry || '').toString().trim().toLowerCase() === norm)
      ? 'correct' : 'wrong';
  }
  if (qType === 'essay') {
    // Essay questions are graded manually by the teacher. If a manual score
    // has been recorded, treat the question as graded; otherwise pending.
    return 'pending';
  }
  return 'unanswered';
}

function gradeSubmissionForQuiz(submission, quiz) {
  const all = submission.allQuestions || [];
  const answers = submission.answers || {};
  const answerMap = getQuizAnswerMap(quiz);
  const liveQuestionMap = getQuizLiveQuestionMap(quiz);
  let correctCount = 0, wrongCount = 0, attemptedCount = 0, pendingCount = 0;
  all.forEach((question, index) => {
    const verdict = evaluateAnswerForQuestion(question, answers[index], answerMap, index, liveQuestionMap);
    if (verdict === 'unanswered') return;
    attemptedCount++;
    if (verdict === 'correct') correctCount++;
    else if (verdict === 'wrong') wrongCount++;
    else if (verdict === 'pending') pendingCount++;
  });
  const subjectBreakdown = computeSubmissionSubjectBreakdown(quiz, submission);
  const score = Math.round(subjectBreakdown.reduce((sum, item) => sum + (item.score || 0), 0) * 100) / 100;
  const totalMarks = Math.round(subjectBreakdown.reduce((sum, item) => sum + (item.totalMarks || 0), 0) * 100) / 100;
  const negativePenalty = Math.round(subjectBreakdown.reduce((sum, item) => sum + (item.negativePenalty || 0), 0) * 100) / 100;
  const percent = totalMarks ? clampPercent((score / totalMarks) * 100) : 0;
  const averagePercent = subjectBreakdown.length
    ? Math.round(subjectBreakdown.reduce((sum, item) => sum + (item.percent || 0), 0) / subjectBreakdown.length)
    : percent;
  return { score, percent, correctCount, wrongCount, attemptedCount, pendingCount, negativePenalty, totalMarks, subjectBreakdown, averagePercent };
}

function regradeSubmissionsForQuiz(quiz) {
  const allSubs = getAllSubmissions();
  let changed = false;
  allSubs.forEach(sub => {
    if (sub.quizId !== quiz.id) return;
    const grade = buildSubmissionGradeState(sub, quiz, gradeSubmissionForQuiz(sub, quiz));
    const hasDiff =
      sub.score !== grade.score ||
      sub.percent !== grade.percent ||
      sub.correctCount !== grade.correctCount ||
      sub.wrongCount !== grade.wrongCount ||
      sub.attemptedCount !== grade.attemptedCount ||
      sub.negativePenalty !== grade.negativePenalty ||
      sub.passMark !== grade.passMark ||
      sub.resultStatus !== grade.resultStatus ||
      !!sub.pendingEssayReview !== !!grade.pendingEssayReview;
    if (!hasDiff) return;
    applyGradeToSubmission(sub, grade);
    sub.regradedAt = new Date().toISOString();
    changed = true;
  });
  if (changed) saveAllSubmissions(allSubs);
  return changed;
}

function computeStudentTopicPerformance(submission, quiz) {
  const grouped = {};
  const all = submission.allQuestions || [];
  const answers = submission.answers || {};
  const liveQuestionMap = quiz ? getQuizLiveQuestionMap(quiz) : null;
  const answerMap = quiz ? getQuizAnswerMap(quiz) : null;
  all.forEach((question, index) => {
    const subject = question._subject || question.subject || 'General';
    if (!grouped[subject]) grouped[subject] = { total: 0, attempted: 0, correct: 0 };
    grouped[subject].total++;
    const rawAnswer = answers[index];
    if (rawAnswer == null || rawAnswer === '') return;
    grouped[subject].attempted++;
    const verdict = evaluateAnswerForQuestion(question, rawAnswer, answerMap, index, liveQuestionMap);
    if (verdict === 'correct') grouped[subject].correct++;
  });
  return grouped;
}

function computeSubmissionSubjectBreakdown(quiz, submission) {
  const sections = buildQuestionSubjectSections(submission?.allQuestions || []);
  const answers = submission?.answers || {};
  const negativeEnabled = !!quiz?.negativeMarkEnabled;
  const negativeValue = parseFloat(quiz?.negativeMarkValue || 0) || 0;
  const subjectMetaMap = getQuizSubjectMetaMap(quiz);
  const answerMap = getQuizAnswerMap(quiz);
  const liveQuestionMap = getQuizLiveQuestionMap(quiz);
  // Manual essay scores keyed by question source id, set by the teacher's
  // grading panel and stored on the submission as `essayScores`.
  const essayScores = (submission && submission.essayScores) || {};
  return sections.map((section) => {
    let attempted = 0;
    let correct = 0;
    let wrong = 0;
    let essayMarksAwarded = 0;
    let essayMaxMarks = 0;
    let pendingEssay = false;
    section.indices.forEach((globalIndex) => {
      const question = submission.allQuestions[globalIndex];
      const qType = normalizeQuestionType(question && question.type);
      const verdict = evaluateAnswerForQuestion(question, answers[globalIndex], answerMap, globalIndex, liveQuestionMap);
      if (verdict === 'unanswered') return;
      attempted++;
      if (qType === 'essay') {
        // Essay marks are awarded manually. Until the teacher records a score
        // via the grading panel, the question is "pending" and contributes 0
        // to the score (but counts toward attempts so the student sees it
        // attempted).
        const sid = question._sourceId || makeQuestionId(question, globalIndex);
        const recorded = essayScores[sid];
        if (recorded != null && Number.isFinite(Number(recorded))) {
          essayMarksAwarded += Math.max(0, Number(recorded));
        } else {
          pendingEssay = true;
        }
      } else if (verdict === 'correct') {
        correct++;
      } else if (verdict === 'wrong') {
        wrong++;
      }
    });
    const meta = subjectMetaMap.get(normalizeSubjectName(section.name)) || {};
    const totalMarks = getSubjectTotalMarks({ totalMarks: meta.totalMarks, questionCount: section.total });
    const markPerQuestion = section.total > 0 ? totalMarks / section.total : 0;
    // Essay max marks for this section = mark-per-question × essay count.
    section.indices.forEach((globalIndex) => {
      const question = submission.allQuestions[globalIndex];
      if (normalizeQuestionType(question && question.type) === 'essay') essayMaxMarks += markPerQuestion;
    });
    const autoScore = correct * markPerQuestion;
    const negativePenalty = negativeEnabled ? Math.round((wrong * negativeValue * markPerQuestion) * 100) / 100 : 0;
    const cappedEssayMarks = Math.min(essayMaxMarks, essayMarksAwarded);
    const rawScore = autoScore + cappedEssayMarks - (negativeEnabled ? wrong * negativeValue * markPerQuestion : 0);
    const score = Math.max(0, Math.round(rawScore * 100) / 100);
    const percent = totalMarks ? clampPercent((score / totalMarks) * 100) : 0;
    return {
      name: section.name,
      total: section.total,
      totalMarks,
      markPerQuestion: Math.round(markPerQuestion * 1000) / 1000,
      attempted,
      correct,
      wrong,
      score,
      percent,
      negativePenalty,
      pendingEssay,
      essayMaxMarks: Math.round(essayMaxMarks * 100) / 100,
      essayMarksAwarded: Math.round(cappedEssayMarks * 100) / 100
    };
  });
}

function buildPdfExportSandboxCss(widthCss = '210mm', paddingCss = '24px') {
  return `
    .pdf-export-sandbox {
      position: absolute !important;
      left: -99999px !important;
      top: 0 !important;
      width: ${widthCss} !important;
      min-width: ${widthCss} !important;
      max-width: ${widthCss} !important;
      overflow: visible !important;
      visibility: visible !important;
      opacity: 1 !important;
      pointer-events: none !important;
      z-index: -1 !important;
    }
    .pdf-export-root,
    .pdf-export-root * {
      box-sizing: border-box !important;
      visibility: visible !important;
      opacity: 1 !important;
      animation: none !important;
      transition: none !important;
      text-shadow: none !important;
      content-visibility: visible !important;
    }
    .pdf-export-root {
      position: static !important;
      display: block !important;
      width: ${widthCss} !important;
      min-width: ${widthCss} !important;
      max-width: ${widthCss} !important;
      min-height: auto !important;
      margin: 0 !important;
      padding: ${paddingCss} !important;
      overflow: visible !important;
      transform: none !important;
      filter: none !important;
      clip: auto !important;
      clip-path: none !important;
      contain: none !important;
      background: #ffffff !important;
      box-shadow: none !important;
      isolation: auto !important;
    }
    .pdf-export-root .no-print,
    .pdf-export-root [data-no-print="true"] {
      display: none !important;
    }
    .pdf-export-root [hidden],
    .pdf-export-root .hidden,
    .pdf-export-root .collapse,
    .pdf-export-root .collapsed,
    .pdf-export-root .is-hidden,
    .pdf-export-root .is-collapsed {
      display: block !important;
      visibility: visible !important;
      opacity: 1 !important;
      max-height: none !important;
      height: auto !important;
    }
    .pdf-export-root .print-container,
    .pdf-export-root .sticky,
    .pdf-export-root .fixed,
    .pdf-export-root [style*="position: fixed"],
    .pdf-export-root [style*="position:fixed"],
    .pdf-export-root [style*="position: sticky"],
    .pdf-export-root [style*="position:sticky"] {
      position: static !important;
      top: auto !important;
      right: auto !important;
      bottom: auto !important;
      left: auto !important;
    }
    .pdf-export-root [style*="display:none"],
    .pdf-export-root [style*="visibility:hidden"],
    .pdf-export-root [style*="opacity:0"],
    .pdf-export-root [style*="overflow:hidden"],
    .pdf-export-root [style*="max-height:0"],
    .pdf-export-root [style*="height:0"],
    .pdf-export-root [style*="content-visibility"],
    .pdf-export-root [style*="clip-path"],
    .pdf-export-root [style*="filter:"],
    .pdf-export-root [style*="transform:"] {
      display: block !important;
      visibility: visible !important;
      opacity: 1 !important;
      overflow: visible !important;
      max-height: none !important;
      height: auto !important;
      content-visibility: visible !important;
      transform: none !important;
      filter: none !important;
      clip: auto !important;
      clip-path: none !important;
    }
    .pdf-export-root [class*="container"],
    .pdf-export-root [class*="wrapper"],
    .pdf-export-root [class*="layout"],
    .pdf-export-root [class*="content"] {
      max-width: 100% !important;
    }
    .pdf-export-root img,
    .pdf-export-root svg,
    .pdf-export-root canvas {
      max-width: 100% !important;
      height: auto !important;
    }
    .pdf-export-root table {
      width: 100% !important;
      table-layout: fixed !important;
    }
    .pdf-export-root td,
    .pdf-export-root th {
      word-wrap: break-word !important;
      overflow-wrap: break-word !important;
    }
    .pdf-export-root input,
    .pdf-export-root textarea,
    .pdf-export-root select,
    .pdf-export-root button {
      max-width: 100% !important;
    }
    .pdf-export-root .pdf-stack-on-export,
    .pdf-export-root .hero,
    .pdf-export-root .student-layout,
    .pdf-export-root .two-col-export-safe,
    .pdf-export-root .student-shell {
      display: block !important;
    }
    .pdf-export-root .pdf-stack-on-export > *,
    .pdf-export-root .hero > *,
    .pdf-export-root .student-layout > *,
    .pdf-export-root .two-col-export-safe > *,
    .pdf-export-root .student-shell > * {
      width: 100% !important;
      max-width: 100% !important;
      display: block !important;
    }
    .pdf-export-root .page-break-before { break-before: page; page-break-before: always; }
    .pdf-export-root .page-break-after { break-after: page; page-break-after: always; }
    .pdf-export-root .avoid-break { break-inside: avoid; page-break-inside: avoid; }
  `;
}

function createPdfExportSandbox({
  sourceNode = null,
  html = '',
  widthCss = '210mm',
  paddingCss = '24px',
  title = ''
} = {}) {
  const sandbox = document.createElement('div');
  sandbox.className = 'pdf-export-sandbox';
  Object.assign(sandbox.style, {
    position: 'absolute',
    left: '-99999px',
    top: '0',
    width: widthCss,
    minWidth: widthCss,
    maxWidth: widthCss,
    overflow: 'visible',
    visibility: 'visible',
    opacity: '1',
    pointerEvents: 'none',
    zIndex: '-1'
  });

  const exportRoot = document.createElement('div');
  exportRoot.className = 'pdf-export-root';
  sandbox.appendChild(exportRoot);

  if (title) {
    const titleNode = document.createElement('div');
    titleNode.className = 'pdf-export-title';
    titleNode.textContent = title;
    Object.assign(titleNode.style, {
      fontSize: '20px',
      fontWeight: '700',
      marginBottom: '16px',
      color: '#111827'
    });
    exportRoot.appendChild(titleNode);
  }

  let clonedContent = null;
  if (sourceNode) {
    clonedContent = sourceNode.cloneNode(true);
    exportRoot.appendChild(clonedContent);
    sanitizeExportClone(clonedContent);
    copyFormValues(sourceNode, clonedContent);
  } else {
    const content = document.createElement('div');
    content.className = 'pdf-export-content';
    content.innerHTML = html;
    sanitizeExportClone(content);
    exportRoot.appendChild(content);
    clonedContent = content;
  }

  const styleTag = document.createElement('style');
  styleTag.setAttribute('data-pdf-export-style', 'true');
  styleTag.textContent = buildPdfExportSandboxCss(widthCss, paddingCss);

  document.head.appendChild(styleTag);
  document.body.appendChild(sandbox);

  return {
    sandbox,
    exportRoot,
    clonedContent,
    cleanup() {
      if (sandbox.parentNode) sandbox.parentNode.removeChild(sandbox);
      if (styleTag.parentNode) styleTag.parentNode.removeChild(styleTag);
    }
  };
}

async function preparePdfExportSandbox(options = {}) {
  const sandboxState = createPdfExportSandbox(options);
  try {
    await waitForNextPaint();
    await waitForNextPaint();
    await waitForNextPaint();
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    await waitForImages(sandboxState.sandbox);
    const renderDelayMs = Math.max(0, Number(options.renderDelayMs) || 300);
    if (renderDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, renderDelayMs));
    }
    return sandboxState;
  } catch (error) {
    sandboxState.cleanup();
    throw error;
  }
}

function computeSubmissionTopicBreakdown(quiz, submission) {
  const grouped = new Map();
  const answers = submission?.answers || {};
  (submission?.allQuestions || []).forEach((question, index) => {
    const subjectName = getQuestionSubjectLabel(question);
    const topicName = (question?.topic || 'General').toString().trim() || 'General';
    const subjectKey = normalizeSubjectName(subjectName);
    if (!grouped.has(subjectKey)) grouped.set(subjectKey, { subjectName, topics: new Map() });
    const subjectEntry = grouped.get(subjectKey);
    if (!subjectEntry.topics.has(topicName)) subjectEntry.topics.set(topicName, {
      name: topicName,
      total: 0,
      attempted: 0,
      correct: 0,
      wrong: 0,
      unanswered: 0,
      passed: 0,
      percent: 0
    });
    const topicEntry = subjectEntry.topics.get(topicName);
    topicEntry.total++;
    const chosen = (answers[index] || '').toString().toUpperCase();
    const expected = (question?.answer || '').toString().toUpperCase();
    if (!chosen) {
      topicEntry.unanswered++;
      return;
    }
    topicEntry.attempted++;
    if (chosen === expected) {
      topicEntry.correct++;
      topicEntry.passed++;
    } else {
      topicEntry.wrong++;
    }
  });
  return Array.from(grouped.values()).map((subjectEntry) => ({
    subjectName: subjectEntry.subjectName,
    topics: Array.from(subjectEntry.topics.values())
      .map((topic) => ({
        ...topic,
        percent: topic.total ? Math.round((topic.correct / topic.total) * 100) : 0
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }));
}

async function getClientTrackingContext() {
  if (_clientTrackingContextCache) return _clientTrackingContextCache;
  if (_clientTrackingContextPromise) return _clientTrackingContextPromise;
  _clientTrackingContextPromise = (async () => {
    try {
      const response = await fetch(buildApiUrl('/api/client-context'), { cache: 'no-store' });
      if (response.ok) {
        const data = await response.json();
        const ipAddress = (data.ipAddress || '').toString().trim();
        if (ipAddress) {
          return {
            ipAddress,
            userAgent: (data.userAgent || navigator.userAgent || '').toString(),
            requestedAt: data.requestedAt || new Date().toISOString(),
            deviceId: getAppDeviceId()
          };
        }
      }
    } catch (error) {}
    try {
      const res = await fetch('https://api.ipify.org?format=json', { cache: 'no-store' });
      if (!res.ok) return { ipAddress: '', userAgent: navigator.userAgent || '', requestedAt: new Date().toISOString(), deviceId: getAppDeviceId() };
      const data = await res.json();
      return {
        ipAddress: data.ip || '',
        userAgent: navigator.userAgent || '',
        requestedAt: new Date().toISOString(),
        deviceId: getAppDeviceId()
      };
    } catch(e) {
      return {
        ipAddress: '',
        userAgent: navigator.userAgent || '',
        requestedAt: new Date().toISOString(),
        deviceId: getAppDeviceId()
      };
    }
  })()
    .then((context) => {
      _clientTrackingContextCache = context;
      return context;
    })
    .finally(() => {
      _clientTrackingContextPromise = null;
    });
  return _clientTrackingContextPromise;
}

function computeRankingForQuiz(quizId) {
  const subs = getAllSubmissions().filter(s=>s.quizId===quizId).slice();
  subs.sort((a,b)=>(b.percent || 0) - (a.percent || 0) || (a.timeSpent || 0) - (b.timeSpent || 0));
  // Key by submissionId (falling back to a synthesized identity) so that
  // multiple attempts from the same student each get a distinct rank, and so
  // that submissions with empty/duplicate emails don't all collide on key ''.
  // The legacy email-keyed entry is still populated so older callers keep
  // working — for unique-email cases the two keys agree.
  const ranks = {};
  for (let i = 0; i < subs.length; i++) {
    const rank = i + 1;
    ranks[buildSubmissionIdentity(subs[i], i)] = rank;
    const emailKey = normalizeEmail(subs[i].email);
    if (emailKey && ranks[emailKey] == null) ranks[emailKey] = rank;
  }
  return ranks;
}

function getSubmissionRank(submission, ranks) {
  if (!submission || !ranks) return '';
  const byIdentity = ranks[buildSubmissionIdentity(submission)];
  if (byIdentity != null) return byIdentity;
  return ranks[normalizeEmail(submission.email)] || '';
}

function showStudentResultModalFromSubmission(quiz, submission, includeActions = true) {
  if (!submission) return showNotification('Submission not found', 'error');
  const quizData = quiz || getAllQuizzes()[submission.quizId] || { id: submission.quizId };
  const ranks = computeRankingForQuiz(submission.quizId);
  let modal = document.getElementById('studentResultModal'); if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'studentResultModal';
  modal.className = 'student-result-modal';
  const inner = document.createElement('div');
  inner.className = 'student-result-modal-card';
  // Show the result summary first, then append the essay-grading panel for
  // teachers when the submission contains essay answers that need a manual
  // score. The panel only renders when the viewer is the quiz owner /
  // super-admin (regular students never see it).
  const resultHtml = buildStudentResultFullHtml(quizData, submission, getSubmissionRank(submission, ranks) || '-', { includeActions });
  const canGradeEssays = includeActions && (
    isSuperAdmin() || (state.teacherId && quizData && normalizeEmail(quizData.teacherId) === normalizeEmail(state.teacherId))
  );
  const essayPanelHtml = canGradeEssays ? buildEssayGradingPanelHtml(quizData, submission) : '';
  inner.innerHTML = resultHtml + essayPanelHtml;
  modal.appendChild(inner); document.body.appendChild(modal);
  if (canGradeEssays) wireEssayGradingPanel(quizData, submission);
  const closeModal = () => {
    modal.remove();
    if (state.view === 'student.result') {
      closeStudentResultLanding('home');
    }
  };
  modal.onclick = (ev) => { if (ev.target === modal) closeModal(); };
  const closeBtn = document.getElementById('closeStudentResult'); if (closeBtn) closeBtn.onclick = closeModal;
  const downloadBtn = document.getElementById('downloadStudentResultPdf');
  if (downloadBtn) downloadBtn.onclick = () => {
    downloadStudentResultPdfDocument(quizData, submission).catch((error) => {
      console.error(error);
      showNotification('Unable to download the result PDF', 'error');
    });
  };
  const requestBtn = document.getElementById('requestCorrectionBtn');
  if (requestBtn) requestBtn.onclick = () => {
    showCorrectionRequestModal(quizData, submission, (updated) => {
      showNotification('Correction request sent to teacher', 'success', 5000);
      const statusEl = document.getElementById('correctionRequestStatus');
      if (statusEl) statusEl.innerHTML = buildCorrectionRequestStatusHtml(updated);
      requestBtn.textContent = 'Update Request';
    });
  };
  const printBtn = document.getElementById('printStudentResult');
  if (printBtn) printBtn.onclick = () => {
    printStudentSummary(quizData, submission);
  };
  return submission;
}

function getQuizScheduleStatus(quiz) {
  const now = Date.now();
  if (quiz.scheduleStart && new Date(quiz.scheduleStart).getTime() > now) return { ok: false, message: 'This quiz has not started yet. Start time: ' + new Date(quiz.scheduleStart).toLocaleString() };
  const effectiveEnd = getQuizEffectiveEndTime(quiz);
  if (effectiveEnd && effectiveEnd < now) {
    return {
      ok: false,
      message: 'This quiz has ended. End time: ' + new Date(effectiveEnd).toLocaleString()
    };
  }
  return { ok: true, message: '' };
}

function getQuizSyncStatus(quiz) {
  if (!quiz) return { label: 'Unknown', tone: 'muted' };
  const updatedStamp = getRecordStamp(quiz);
  const syncedStamp = quiz.cloudSyncedAt ? new Date(quiz.cloudSyncedAt).getTime() : 0;
  if (!canUseNetworkSync()) return { label: 'Local only', tone: 'muted' };
  if (syncedStamp && syncedStamp >= updatedStamp) return { label: 'Cloud synced', tone: 'success' };
  if (networkSyncFailed && !networkSyncReady) return { label: 'Sync unavailable', tone: 'warning' };
  return { label: 'Pending cloud sync', tone: 'warning' };
}

function markQuizzesCloudSynced(quizIds = [], syncedAt = new Date().toISOString()) {
  const uniqueIds = [...new Set((Array.isArray(quizIds) ? quizIds : []).filter(Boolean))];
  if (!uniqueIds.length) return false;
  const quizzes = getAllQuizzes();
  let changed = false;
  uniqueIds.forEach((quizId) => {
    const quiz = quizzes[quizId];
    if (!quiz) return;
    if (quiz.cloudSyncedAt === syncedAt) return;
    // Skip quizzes that already read "Cloud synced" (cloudSyncedAt is at/after
    // the record's own stamp) so repeated pulls don't churn the quizzes map.
    const existing = quiz.cloudSyncedAt ? new Date(quiz.cloudSyncedAt).getTime() : 0;
    if (existing && existing >= getRecordStamp(quiz)) return;
    quizzes[quizId] = { ...quiz, cloudSyncedAt: syncedAt, updatedAt: quiz.updatedAt || syncedAt };
    changed = true;
  });
  // cloudSyncedAt is a per-device UI marker only — every caller of this
  // function has already pushed the underlying quiz via /api/quizzes/<id>
  // (or an explicit syncSharedKeys) or just confirmed it via a cloud pull, so
  // triggering save()'s bulk PUT to /api/state/quizzes here would just
  // re-upload the entire map for nothing.
  if (changed) saveAllQuizzes(quizzes, { skipNetworkSync: true });
  return changed;
}

async function endQuizNow(quizId) {
  const quizzes = getAllQuizzes();
  const quiz = quizzes[quizId];
  if (!quiz) return false;
  const existingEnd = quiz.scheduleEnd ? new Date(quiz.scheduleEnd).getTime() : 0;
  if (existingEnd && existingEnd <= Date.now()) {
    showNotification('This test has already ended.', 'info');
    return false;
  }
  if (!confirmTeacherAction(`End "${quiz.title || quiz.id}" now? Students who have not started yet will no longer be able to open it.`)) return false;
  const now = new Date().toISOString();
  const updatedQuiz = { ...quiz, scheduleEnd: now, endedAt: now, updatedAt: now };
  quizzes[quizId] = updatedQuiz;
  saveAllQuizzes(quizzes, { skipNetworkSync: true });
  // Per-quiz push — bulk PUT /api/state/quizzes is now a no-op so the bulk
  // syncSharedKeys path no longer propagates the end-time change to the cloud.
  const synced = await pushSingleQuizToCloud(updatedQuiz);
  if (synced) markQuizzesCloudSynced([quizId]);
  if (state.currentQuiz && state.currentQuiz.id === quizId) state.currentQuiz = updatedQuiz;
  showNotification(synced ? 'Test ended successfully' : `Test ended locally. ${getSharedSyncWarningMessage()}`, synced ? 'success' : 'warning', 7000);
  render();
  return true;
}


// ======= Helper UI & Exam Functions (restored features) =======

function showNotification(msg, type = 'info', ttl = 3000) {
  try {
    const id = 'site-notification';
    let el = document.getElementById(id);
    if (el) el.remove();
    el = document.createElement('div');
    el.id = id;
    el.className = 'notification ' + (type || 'info');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; try{el.remove()}catch(e){} }, ttl);
  } catch (e) { console.warn('notify', e); }
}

function showCorrectionRequestModal(quiz, submission, onSave) {
  if (!quiz || !submission) return;
  let modal = document.getElementById('correctionRequestModal');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'correctionRequestModal';
  modal.className = 'student-result-modal';
  const existingWhatsapp = normalizeWhatsappNumber(submission.whatsappNumber || getSubmissionCorrectionContact(submission).whatsapp || '');
  const card = document.createElement('div');
  card.className = 'card-beautiful admin-modal-card';
  card.style.width = 'min(560px, 94vw)';
  card.innerHTML = `
    <div class="page-heading">
      <div>
        <div class="h2">Request Correction</div>
        <div class="small">${escapeHtml(quiz.title || quiz.id || 'Quiz')}</div>
      </div>
      <button id="closeCorrectionRequestModal" class="btn btn-ghost">Close</button>
    </div>
    <div class="small" style="line-height:1.7;margin-bottom:14px">We already saved your email or registration details from quiz start. To receive the correction PDF on WhatsApp, enter the WhatsApp number your teacher should use.</div>
    <label class="small" style="display:block;margin-top:10px">WhatsApp number</label>
    <input id="correctionRequestWhatsapp" class="input-beautiful" placeholder="e.g. 08012345678" value="${escapeHtml(existingWhatsapp)}" />
    <label class="small" style="display:block;margin-top:12px">Message for teacher (optional)</label>
    <textarea id="correctionRequestMessage" class="input-beautiful" style="min-height:110px">${escapeHtml(submission.correctionMessage || '')}</textarea>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;flex-wrap:wrap">
      <button id="cancelCorrectionRequestModal" class="btn btn-ghost">Cancel</button>
      <button id="saveCorrectionRequestModal" class="btn btn-primary">Save Request</button>
    </div>
  `;
  modal.appendChild(card);
  document.body.appendChild(modal);
  modal.onclick = (event) => { if (event.target === modal) modal.remove(); };
  const closeModal = () => modal.remove();
  document.getElementById('closeCorrectionRequestModal').onclick = closeModal;
  document.getElementById('cancelCorrectionRequestModal').onclick = closeModal;
  document.getElementById('saveCorrectionRequestModal').onclick = async () => {
    const whatsappRaw = document.getElementById('correctionRequestWhatsapp').value.trim();
    const whatsapp = normalizeWhatsappNumber(whatsappRaw);
    const message = (document.getElementById('correctionRequestMessage').value || '').trim();
    if (!whatsapp || whatsapp.length < 10) return showNotification('Enter a valid WhatsApp number so your teacher can send the correction PDF.', 'error', 6000);
    const updated = updateLatestSubmissionByQuizAndEmail(quiz.id, submission.email, (item) => {
      item.correctionRequested = true;
      item.correctionRequestedAt = new Date().toISOString();
      item.correctionMessage = message;
      item.correctionStatus = 'pending';
      item.correctionContact = whatsapp;
      item.correctionContactChannel = 'whatsapp';
      item.whatsappNumber = whatsapp;
    });
    if (!updated) return showNotification('Unable to save correction request', 'error');
    submission.correctionRequested = true;
    submission.correctionRequestedAt = updated.correctionRequestedAt;
    submission.correctionMessage = message;
    submission.correctionStatus = 'pending';
    submission.correctionContact = whatsapp;
    submission.correctionContactChannel = 'whatsapp';
    submission.whatsappNumber = whatsapp;
    const sharedSyncOk = await syncSharedKeys([STORAGE_KEYS.submissions]);
    closeModal();
    if (typeof onSave === 'function') onSave(updated);
    if (!sharedSyncOk) {
      showNotification(`Correction request saved on this device. ${getSharedSyncWarningMessage()}`, 'warning', 7000);
    }
  };
}

async function openStudentCorrectionByShareKey(shareKey, options = {}) {
  const key = (shareKey || '').trim().toLowerCase();
  if (!key) return showNotification('Correction link is incomplete', 'error');
  if (!findSubmissionByShareKey(key) && options.refreshSync !== false && canUseNetworkSync()) {
    if (getAuthSessionToken()) await pullSharedStateSilently({ forcePull: true, timeoutMs: 5000 });
    if (!findSubmissionByShareKey(key)) await hydrateSubmissionFromShareKey(key);
  }
  const submission = findSubmissionByShareKey(key);
  if (!submission) return showNotification('That correction could not be verified on this device yet.', 'error', 7000);
  return openStudentCorrectionBySubmissionKey(
    submission.quizId,
    submission.submissionId || buildSubmissionIdentity(submission),
    { ...options, refreshSync: false }
  );
}

async function openStudentCorrectionBySubmissionKey(quizId, submissionKey, options = {}) {
  const id = (quizId || '').trim();
  const key = (submissionKey || '').trim();
  if (!id || !key) return showNotification('Correction link is incomplete', 'error');
  if (options.refreshSync !== false && canUseNetworkSync()) await pullSharedStateSilently({ forcePull: true, timeoutMs: 5000 });
  const quizForRegrade = getAllQuizzes()[id];
  if (quizForRegrade) regradeSubmissionsForQuiz(quizForRegrade);
  const submission = findSubmissionBySubmissionKey(id, key);
  if (!submission) return showNotification('That correction could not be verified on this device yet.', 'error', 7000);
  const quiz = getAllQuizzes()[id] || { id };
  try {
    await downloadCorrectionPdfFast(submission, quiz, {
      showNegativePenalty: true,
      subjectName: options.correctionSubject || ''
    });
    await markCorrectionPdfDownloaded(submission);
    return submission;
  } catch (error) {
    console.error(error);
    showNotification('Error preparing correction PDF', 'error');
    return null;
  }
}

async function showStudentResultModalByLookup(quizId, identifier, includeActions = true) {
  const id = (quizId || '').trim();
  const key = normalizeEmail(identifier || '');
  if (!id || !key) return showNotification('Enter quiz ID and email or registration number', 'error');
  if (canUseNetworkSync()) await pullSharedStateSilently({ forcePull: true, timeoutMs: 5000 });
  const quizForRegrade = getAllQuizzes()[id];
  if (quizForRegrade) regradeSubmissionsForQuiz(quizForRegrade);
  const subs = getAllSubmissions().filter((submission) => {
    if (submission.quizId !== id) return false;
    const emailMatch = normalizeEmail(submission.email) === key;
    const regMatch = normalizeEmail(submission.registrationNo || submission.id || '') === key;
    return emailMatch || regMatch;
  });
  if (!subs || subs.length===0) return showNotification('No submission found for that quiz/email or registration number','error');
  const s = subs.slice().sort(sortSubmissionRecords)[subs.length - 1];
  const quiz = getAllQuizzes()[id] || { id };
  return showStudentResultModalFromSubmission(quiz, s, includeActions);
}

async function showStudentResultModalByShareKey(shareKey, includeActions = true, options = {}) {
  const key = (shareKey || '').trim().toLowerCase();
  if (!key) return showNotification('Result link is incomplete', 'error');
  if (!findSubmissionByShareKey(key) && options.refreshSync !== false && canUseNetworkSync()) {
    if (getAuthSessionToken()) await pullSharedStateSilently({ forcePull: true, timeoutMs: 5000 });
    if (!findSubmissionByShareKey(key)) await hydrateSubmissionFromShareKey(key);
  }
  const submission = findSubmissionByShareKey(key);
  if (!submission) return showNotification('That certificate could not be verified on this device yet.', 'error', 7000);
  return showStudentResultModalBySubmissionKey(
    submission.quizId,
    submission.submissionId || buildSubmissionIdentity(submission),
    includeActions,
    { ...options, refreshSync: false }
  );
}

async function showStudentResultModalBySubmissionKey(quizId, submissionKey, includeActions = true, options = {}) {
  const id = (quizId || '').trim();
  const key = (submissionKey || '').trim();
  if (!id || !key) return showNotification('Result link is incomplete', 'error');
  if (options.refreshSync !== false && canUseNetworkSync()) await pullSharedStateSilently({ forcePull: true, timeoutMs: 5000 });
  const quizForRegrade = getAllQuizzes()[id];
  if (quizForRegrade) regradeSubmissionsForQuiz(quizForRegrade);
  const submission = findSubmissionBySubmissionKey(id, key);
  if (!submission) return showNotification('That certificate could not be verified on this device yet.', 'error', 7000);
  const quiz = getAllQuizzes()[id] || { id };
  showStudentResultModalFromSubmission(quiz, submission, includeActions);
  if (options.autoDownloadCorrection) {
    setTimeout(async () => {
      try {
        await downloadCorrectionPdfFast(submission, quiz, { showNegativePenalty: true, subjectName: options.correctionSubject || '' });
        await markCorrectionPdfDownloaded(submission);
      } catch (error) {
        console.error(error);
        showNotification('Error preparing correction PDF', 'error');
      }
    }, 120);
  }
  return submission;
}

function showEditSubmissionScoreModal(quiz, submission) {
  if (!submission) return showNotification('Submission not found', 'error');
  let modal = document.getElementById('scoreEditModal');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'scoreEditModal';
  modal.className = 'student-result-modal';

  const totalQuestions = (submission.allQuestions || []).length;
  const baseGrade = gradeSubmissionForQuiz(submission, quiz || {});
  const currentScore = hasManualScoreOverride(submission) ? Number(submission.manualScoreOverride) : Number(submission.score || 0);
  const currentValue = Number.isFinite(currentScore) ? formatScoreValue(currentScore) : '0';

  const card = document.createElement('div');
  card.className = 'card-beautiful admin-modal-card score-edit-modal-card';
  card.innerHTML = `
    <div class="score-edit-header">
      <div>
        <h3>Edit Student Score</h3>
        <p>Change this student's stored score before exporting. The updated score will flow into the result certificate, ranking, Excel, and PDF exports.</p>
      </div>
      <button type="button" id="closeScoreEditModal" class="btn-pastel-secondary">Close</button>
    </div>

    <div class="score-edit-summary">
      <div class="score-edit-summary-card">
        <span>Student</span>
        <strong>${escapeHtml(submission.name || submission.email || 'Student')}</strong>
      </div>
      <div class="score-edit-summary-card">
        <span>Quiz</span>
        <strong>${escapeHtml((quiz && quiz.title) || submission.quizId || 'Quiz')}</strong>
      </div>
      <div class="score-edit-summary-card">
        <span>Questions</span>
        <strong>${totalQuestions}</strong>
      </div>
      <div class="score-edit-summary-card">
        <span>Original Auto Score</span>
        <strong>${formatScoreValue(baseGrade.score)} / ${totalQuestions}</strong>
      </div>
    </div>

    <div class="score-edit-grid">
      <div class="form-group">
        <label class="form-label" for="scoreEditValue">Adjusted score</label>
        <input id="scoreEditValue" class="input-beautiful" type="number" min="0" max="${totalQuestions}" step="0.01" value="${currentValue}" />
        <p class="helper-text">Enter a score between 0 and ${totalQuestions}. You can use decimals when needed.</p>
      </div>
      <div class="score-edit-preview" id="scoreEditPreview"></div>
    </div>

    <div class="score-edit-actions">
      <button type="button" id="resetScoreEdit" class="btn-pastel-secondary"${hasManualScoreOverride(submission) ? '' : ' disabled'}>Reset to Auto Score</button>
      <button type="button" id="saveScoreEdit" class="btn-pastel-primary">Save Score</button>
    </div>
  `;

  modal.appendChild(card);
  document.body.appendChild(modal);
  modal.onclick = (ev) => { if (ev.target === modal) modal.remove(); };

  const input = card.querySelector('#scoreEditValue');
  const preview = card.querySelector('#scoreEditPreview');
  const close = card.querySelector('#closeScoreEditModal');
  const save = card.querySelector('#saveScoreEdit');
  const reset = card.querySelector('#resetScoreEdit');

  const renderPreview = () => {
    const raw = Number(input.value);
    if (input.value === '' || !Number.isFinite(raw)) {
      preview.innerHTML = '<div class="score-edit-preview-label">Preview</div><strong>Enter a valid score to preview the result.</strong>';
      return;
    }
    if (raw < 0 || raw > totalQuestions) {
      preview.innerHTML = `<div class="score-edit-preview-label">Preview</div><strong>Score must stay between 0 and ${totalQuestions}.</strong>`;
      return;
    }
    const draftSubmission = { ...submission, manualScoreOverride: raw };
    const nextGrade = buildSubmissionGradeState(draftSubmission, quiz || {}, baseGrade);
    preview.innerHTML = `
      <div class="score-edit-preview-label">Preview</div>
      <strong>${formatScoreValue(nextGrade.score)} / ${totalQuestions}</strong>
      <div>${nextGrade.percent}% • ${escapeHtml(nextGrade.resultStatus)}</div>
      <div class="score-edit-preview-note">Exports will use this adjusted score until you reset it.</div>
    `;
  };

  renderPreview();
  input.oninput = renderPreview;
  close.onclick = () => modal.remove();

  save.onclick = async () => {
    const raw = Number(input.value);
    if (input.value === '' || !Number.isFinite(raw)) return showNotification('Enter a valid score', 'error');
    if (raw < 0 || raw > totalQuestions) return showNotification(`Score must be between 0 and ${totalQuestions}`, 'error');
    if (!confirmTeacherAction(`Apply this adjusted score for ${submission.name || submission.email || 'this student'}?`)) return;
    const all = getAllSubmissions();
    const index = findSubmissionIndexByIdentity(all, submission.quizId, submission.email, submission.submittedAt || '');
    if (index < 0) return showNotification('Submission not found', 'error');
    all[index].manualScoreOverride = Math.round(raw * 100) / 100;
    all[index].manualScoreEditedAt = new Date().toISOString();
    all[index].manualScoreEditedBy = state.teacherId || 'teacher';
    all[index].updatedAt = new Date().toISOString();
    const nextGrade = buildSubmissionGradeState(all[index], quiz || {}, gradeSubmissionForQuiz(all[index], quiz || {}));
    applyGradeToSubmission(all[index], nextGrade);
    saveAllSubmissions(all);
    // Per-quiz submissions push.
    const quizSubs = getAllSubmissions({ includeDeleted: true }).filter((s) => s && s.quizId === submission.quizId);
    const sharedSyncOk = await pushSingleQuizSubmissionsToCloud(submission.quizId, quizSubs);
    modal.remove();
    showNotification(sharedSyncOk ? 'Student score updated' : `Student score updated on this device. ${getSharedSyncWarningMessage()}`, sharedSyncOk ? 'success' : 'warning', 7000);
    render();
  };

  reset.onclick = async () => {
    if (!confirmTeacherAction(`Reset ${submission.name || submission.email || 'this student'} back to the auto-calculated score?`)) return;
    const all = getAllSubmissions();
    const index = findSubmissionIndexByIdentity(all, submission.quizId, submission.email, submission.submittedAt || '');
    if (index < 0) return showNotification('Submission not found', 'error');
    delete all[index].manualScoreOverride;
    delete all[index].manualScoreEditedAt;
    delete all[index].manualScoreEditedBy;
    all[index].updatedAt = new Date().toISOString();
    const nextGrade = buildSubmissionGradeState(all[index], quiz || {}, gradeSubmissionForQuiz(all[index], quiz || {}));
    applyGradeToSubmission(all[index], nextGrade);
    saveAllSubmissions(all);
    const quizSubs = getAllSubmissions({ includeDeleted: true }).filter((s) => s && s.quizId === submission.quizId);
    const sharedSyncOk = await pushSingleQuizSubmissionsToCloud(submission.quizId, quizSubs);
    modal.remove();
    showNotification(sharedSyncOk ? 'Student score reset to auto grade' : `Student score reset locally. ${getSharedSyncWarningMessage()}`, sharedSyncOk ? 'success' : 'warning', 7000);
    render();
  };
}

function openStudentGuideModal() {
  let modal = document.getElementById('studentGuideModal');
  if (modal) modal.remove();
  modal = document.createElement('div');
  modal.id = 'studentGuideModal';
  modal.className = 'student-result-modal';
  const inner = document.createElement('div');
  inner.className = 'card-beautiful admin-modal-card';
  inner.style.width = 'min(760px, 96vw)';
  inner.innerHTML = `
    <div class="page-heading">
      <div>
        <div class="h2">Student Guide</div>
        <div class="small">A simple guide to help students know what to expect before the quiz starts.</div>
      </div>
      <button id="closeStudentGuide" class="btn btn-ghost">Close</button>
    </div>
    <div style="display:grid;gap:14px;line-height:1.75;color:#334155">
      <div class="card" style="padding:14px;border:1px solid #DBEAFE;box-shadow:none">
        <strong>1. Enter your details correctly.</strong>
        <div class="small" style="margin-top:6px">Use your real name and the same email or registration number you want attached to your result.</div>
      </div>
      <div class="card" style="padding:14px;border:1px solid #DBEAFE;box-shadow:none">
        <strong>2. Use the exact quiz code or link from your teacher.</strong>
        <div class="small" style="margin-top:6px">If the quiz has more than one subject, the welcome screen will show the subject names and question count for each subject before you begin.</div>
      </div>
      <div class="card" style="padding:14px;border:1px solid #DBEAFE;box-shadow:none">
        <strong>3. Stay in full screen during the quiz.</strong>
        <div class="small" style="margin-top:6px">Leaving the tab, minimizing the browser, or escaping full screen can be flagged and may auto-submit the quiz.</div>
      </div>
      <div class="card" style="padding:14px;border:1px solid #DBEAFE;box-shadow:none">
        <strong>4. Screenshots, screen recording, copy, and similar shortcuts are not allowed.</strong>
        <div class="small" style="margin-top:6px">On supported devices, these actions can be tracked and may affect the quiz session.</div>
      </div>
      <div class="card" style="padding:14px;border:1px solid #DBEAFE;box-shadow:none">
        <strong>5. Results and corrections.</strong>
        <div class="small" style="margin-top:6px">After submission, your teacher may allow instant results. If you request a correction PDF later, the correction can be sent by email or WhatsApp.</div>
      </div>
    </div>
  `;
  modal.appendChild(inner);
  document.body.appendChild(modal);
  modal.onclick = (event) => { if (event.target === modal) modal.remove(); };
  document.getElementById('closeStudentGuide').onclick = () => modal.remove();
}

function renderResultLinkLanding() {
  const wrapper = document.createElement('div');
  const ui = state.resultLinkUi || buildResultLinkUiState(getActiveResultLinkRequest() || {});
  const request = ui.request || {};
  const preparingCorrection = !!request.downloadCorrection;
  wrapper.className = 'result-link-landing';
  wrapper.innerHTML = `
    <div class="result-link-card card-beautiful">
      <div class="result-link-badge">${escapeHtml(ui.badge || (preparingCorrection ? 'Preparing Correction PDF' : 'Opening Verified Result'))}</div>
      ${ui.showSpinner === false
        ? `<div class="result-link-status-icon result-link-status-${escapeHtml(ui.phase || 'info')}" aria-hidden="true">${ui.phase === 'success' ? '&#10003;' : ui.phase === 'error' ? '!' : 'i'}</div>`
        : '<div class="result-link-spinner" aria-hidden="true"></div>'}
      <div class="h1 result-link-title">${escapeHtml(ui.title || (preparingCorrection ? 'Your correction PDF is being prepared.' : 'Your verified result is loading.'))}</div>
      <div class="small result-link-copy">${escapeHtml(ui.copy || '')}</div>
      ${ui.subjectName ? `<div class="small" style="margin-top:14px">Subject: <strong>${escapeHtml(ui.subjectName)}</strong></div>` : ''}
      <div class="result-link-actions">
        ${ui.phase === 'error' ? '<button id="retryResultLinkAction" class="btn btn-primary">Try Again</button>' : ''}
        ${ui.phase === 'success' && preparingCorrection ? '<button id="openResultSummaryFromLanding" class="btn btn-secondary">View Result Summary</button>' : ''}
        <button id="closeResultLinkLanding" class="btn btn-ghost">${ui.phase === 'loading' ? 'Close Page' : 'Return Home'}</button>
      </div>
    </div>
  `;
  setTimeout(() => {
    const closeBtn = document.getElementById('closeResultLinkLanding');
    if (closeBtn) closeBtn.onclick = () => {
      if (ui.phase === 'loading') dismissStudentResultLanding();
      else closeStudentResultLanding('home');
    };
    const retryBtn = document.getElementById('retryResultLinkAction');
    if (retryBtn) retryBtn.onclick = () => {
      const activeRequest = getActiveResultLinkRequest();
      if (!activeRequest) return closeStudentResultLanding('home');
      setResultLinkUiState(activeRequest);
      render();
      setTimeout(() => { processPendingResultLinkRequest(activeRequest); }, 40);
    };
    const openResultBtn = document.getElementById('openResultSummaryFromLanding');
    if (openResultBtn) openResultBtn.onclick = async () => {
      const activeRequest = getActiveResultLinkRequest();
      if (!activeRequest) return closeStudentResultLanding('home');
      const openOptions = { correctionSubject: activeRequest.correctionSubject || '' };
      if (activeRequest.shareKey) {
        await showStudentResultModalByShareKey(activeRequest.shareKey, true, openOptions);
      } else {
        await showStudentResultModalBySubmissionKey(activeRequest.quizId, activeRequest.submissionId, true, openOptions);
      }
    };
  }, 0);
  return wrapper;
}

function renderStudentEntry() {
  const wrapper = document.createElement('div');
  wrapper.className = 'student-page';
  const quizzes = getAllQuizzes();
  wrapper.innerHTML = `
    <div class="h1">Student - Enter Details</div>
    <div class="small">Provide your name, email or registration number, then enter the Quiz Code or paste the short link.</div>
    <div class="student-shell">
      <div class="form-card">
        <div class="student-fields">
        <label class="small">Full name</label>
        <input id="stuName" class="input-beautiful" />
        <div style="height:8px"></div>
         <label class="small">Email / Registration No</label>
         <input id="stuIdentity" class="input-beautiful" placeholder="Email or registration number" />
         <div style="height:8px"></div>
         <label class="small">Quiz Code / Magic Link</label>
         <input id="stuAccess" class="input-beautiful" placeholder="123456 or https://..." value="${escapeHtml(state.prefillQuizCode || '')}" />
         <div style="height:12px"></div>
         <div class="student-buttons"><button id="startExamBtn" class="btn-main">Start Exam</button><button id="previewLink" class="btn-secondary">Copy Link</button><button id="checkResultBtn" class="btn-secondary">Check Result</button></div>
         </div>
      </div>
      <div class="info-card">
          <h3 class="display-font">Quick Info</h3>
          <p class="text-muted">Enter the Quiz Code provided by your teacher or paste the student link.</p>
          <p class="text-muted">If you later request a correction PDF, the app will ask for your WhatsApp number at the end of the quiz. Your email or registration details from this screen are already saved.</p>
          <p class="text-muted">The app will not show other teachers' quizzes.</p>
          <p class="text-muted">To view the student guide, <button id="openStudentGuideBtn" type="button" class="btn btn-ghost btn-sm" style="padding:4px 10px;vertical-align:middle">click here</button>.</p>
      </div>
    </div>
  `;

  setTimeout(()=>{
    document.getElementById('openStudentGuideBtn').onclick = () => openStudentGuideModal();
    document.getElementById('startExamBtn').onclick = async () => {
      const name = document.getElementById('stuName').value.trim();
      const studentKey = document.getElementById('stuIdentity').value.trim();
      const access = parseQuizAccessInput(document.getElementById('stuAccess').value || '');
      const email = studentKey.includes('@') ? studentKey : '';
      const registrationNo = studentKey.includes('@') ? '' : studentKey;
      if (!name || !studentKey) return showNotification('Please enter name and email or registration number','error');
      let quiz = await resolveQuizFromAccessWithSync(access);
      if (!quiz) {
        return showNotification('Quiz not found or invalid code/link. Ask the teacher to resend the quiz ID or student link.', 'error', 8000);
      }
      let qid = null;
      qid = quiz.id;
      const schedule = getQuizScheduleStatus(quiz);
      if (!schedule.ok) return showNotification(schedule.message, 'error', 6000);
      const attemptLimit = parseInt(quiz.attemptLimit || 1, 10) || 1;
      const usedAttempts = getAttemptCount(qid, studentKey);
      if (usedAttempts >= attemptLimit) return showNotification(`Attempt limit reached (${usedAttempts}/${attemptLimit})`, 'error');
      // enforce whitelist if present on quiz
      if (quiz.whitelist && Array.isArray(quiz.whitelist) && quiz.whitelist.length) {
        const normalized = normalizeEmail(email);
        const normalizedReg = normalizeEmail(registrationNo);
        const found = quiz.whitelist.some(w => {
          const allowedEmail = normalizeEmail((w.email||'').toString());
          const allowedId = normalizeEmail((w.id||w.registrationNo||'').toString());
          return (!!normalized && allowedEmail === normalized) || (!!normalizedReg && allowedId === normalizedReg);
        });
        if (!found) return showNotification('You are not on the allowed list for this quiz', 'error');
      }
      state.currentQuiz = quiz;
      // Defensive cleanup: a prior attempt may have left a snapshot interval,
      // a webcam stream, or a timer running. If we don't kill those before
      // overwriting state.currentSubmission, the references are lost and the
      // intervals keep firing — this is what causes "state not clearing
      // between attempts" and the after-click sluggishness.
      stopWebcam();
      if (typeof timerInterval !== 'undefined' && timerInterval) {
        try { clearInterval(timerInterval); } catch (e) {}
        timerInterval = null;
      }
      timeRemaining = 0;
      startTime = null;
      state.currentSubmission = null; // reset
      state.view = 'take';
      // set student details into submission placeholder
      state.currentSubmission = { name, email: studentKey, registrationNo, correctionContact: email || '', correctionContactChannel: email ? 'email' : '', whatsappNumber: '', answers: {}, flagged: {}, quizId: quiz.id, allQuestions: [], currentIndex: 0, examStarted: false, startedAt: '', snapshots: [], attemptNo: usedAttempts + 1, monitoring: { tabSwitches: 0, fullscreenExits: 0, copyAttempts: 0, screenshotAttempts: 0, webcamEnabled: false, ipAddress: '', userAgent: navigator.userAgent || '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '', deviceId: getAppDeviceId(), ipCapturedAt: '' } };
      const draft = loadExamDraft(quiz.id, studentKey);
      if (draft && confirm('A saved exam draft was found. Resume from where you stopped?')) {
        state.currentSubmission.answers = draft.answers || {};
        state.currentSubmission.flagged = draft.flagged || {};
        state.currentSubmission.currentIndex = draft.currentIndex || 0;
        state.currentSubmission.startedAt = draft.startedAt || '';
      }
      const webcamOn = !!quiz.webcamRequired;
      state.currentSubmission.webcamRequested = webcamOn;
      state.currentSubmission.monitoring.webcamEnabled = webcamOn;
      if (webcamOn) showNotification('This quiz requires camera monitoring. Allow camera access on the next screen to continue.', 'warning', 7000);
      getClientTrackingContext().then((context) => {
        if (state.currentSubmission && state.currentSubmission.quizId === quiz.id) {
          state.currentSubmission.monitoring.ipAddress = context.ipAddress || '';
          state.currentSubmission.monitoring.userAgent = context.userAgent || navigator.userAgent || '';
          state.currentSubmission.monitoring.deviceId = context.deviceId || getAppDeviceId();
          state.currentSubmission.monitoring.ipCapturedAt = context.requestedAt || new Date().toISOString();
          state.currentSubmission.ipAddress = context.ipAddress || '';
          state.currentSubmission.userAgent = context.userAgent || navigator.userAgent || '';
          state.currentSubmission.deviceId = context.deviceId || getAppDeviceId();
          state.currentSubmission.ipCapturedAt = context.requestedAt || new Date().toISOString();
        }
      });
      render();
    };
    document.getElementById('previewLink').onclick = async ()=>{
      const q = await resolveQuizFromAccessWithSync(parseQuizAccessInput(document.getElementById('stuAccess').value || ''));
      if (!q) return showNotification('Quiz not found or invalid code/link', 'error');
      await copyQuizAccessLink(q);
    };
    document.getElementById('checkResultBtn').onclick = ()=>{
      const id = prompt('Enter Quiz ID to check'); if (!id) return;
      const identifier = prompt('Enter your email or registration number used for submission'); if (!identifier) return;
      showStudentResultModalByLookup(id, identifier, true);
    };
  },0);

  return wrapper;
}

let _webcamStream = null;
function makeFloatingPanelDraggable(panel, handle) {
  if (!panel) return;
  if (panel._dragBindings) {
    const previous = panel._dragBindings;
    previous.handle?.removeEventListener('mousedown', previous.startDrag);
    previous.handle?.removeEventListener('touchstart', previous.startDrag);
    previous.stopDrag?.();
  }
  const dragHandle = handle || panel;
  let startX = 0, startY = 0, initialLeft = 0, initialTop = 0, dragging = false;
  const onMove = (event) => {
    if (!dragging) return;
    const clientX = event.touches ? event.touches[0].clientX : event.clientX;
    const clientY = event.touches ? event.touches[0].clientY : event.clientY;
    const nextLeft = initialLeft + (clientX - startX);
    const nextTop = initialTop + (clientY - startY);
    panel.style.left = `${Math.max(8, Math.min(window.innerWidth - panel.offsetWidth - 8, nextLeft))}px`;
    panel.style.top = `${Math.max(8, Math.min(window.innerHeight - panel.offsetHeight - 8, nextTop))}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  };
  const stopDrag = () => {
    dragging = false;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', stopDrag);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', stopDrag);
  };
  const startDrag = (event) => {
    dragging = true;
    const clientX = event.touches ? event.touches[0].clientX : event.clientX;
    const clientY = event.touches ? event.touches[0].clientY : event.clientY;
    const rect = panel.getBoundingClientRect();
    startX = clientX;
    startY = clientY;
    initialLeft = rect.left;
    initialTop = rect.top;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', stopDrag);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', stopDrag);
    if (event.cancelable) event.preventDefault();
  };
  dragHandle.style.cursor = 'move';
  dragHandle.addEventListener('mousedown', startDrag);
  dragHandle.addEventListener('touchstart', startDrag, { passive: false });
  panel._dragBindings = { handle: dragHandle, startDrag, stopDrag };
}

function startWebcam() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return showNotification('Webcam not supported in this browser','error');
    navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } }).then(stream => {
      _webcamStream = stream;
      let feed = document.getElementById('webcamFeed');
      if (!feed) {
        feed = document.createElement('div'); feed.id = 'webcamFeed'; feed.className = 'webcam-feed card-beautiful';
        feed.style.position = 'fixed'; feed.style.right = '18px'; feed.style.bottom = '18px'; feed.style.width = '176px'; feed.style.height = '132px'; feed.style.zIndex = 9999; feed.style.padding = '8px';
        const handle = document.createElement('div');
        handle.className = 'webcam-drag-handle';
        handle.textContent = 'Camera monitor';
        handle.style.fontSize = '11px';
        handle.style.fontWeight = '800';
        handle.style.color = '#475569';
        handle.style.marginBottom = '6px';
        handle.style.userSelect = 'none';
        feed.appendChild(handle);
        const v = document.createElement('video'); v.autoplay = true; v.muted = true; v.playsInline = true; v.className = 'webcam-video'; v.srcObject = stream; feed.appendChild(v); document.body.appendChild(feed);
        makeFloatingPanelDraggable(feed, handle);
      } else {
        const v = feed.querySelector('video'); if (v) v.srcObject = stream;
      }
      // Record that the camera was live, at random intervals — timestamps only.
      // We deliberately do NOT keep the captured frame (a base64 JPEG): nothing
      // in the app renders it, and a handful of them per submission is what blew
      // past the browser's 5 MB localStorage quota and made results vanish. If a
      // proctoring-review UI is ever built, frames should be uploaded to object
      // storage, not embedded in the submission JSON.
      if (state.currentSubmission) {
        state.currentSubmission._snapshotInterval = setInterval(()=>{
          try {
            const v = document.querySelector('#webcamFeed video');
            if (!v) return;
            state.currentSubmission.snapshots = state.currentSubmission.snapshots || [];
            state.currentSubmission.snapshots.push({ at: new Date().toISOString() });
            if (state.currentSubmission.snapshots.length > 6) state.currentSubmission.snapshots = state.currentSubmission.snapshots.slice(-6);
          } catch(e){}
        }, 1000 * (25 + Math.floor(Math.random()*50)));
      }
    }).catch(err => { console.warn('webcam denied', err); showNotification('Webcam permission denied','error'); });
  } catch (e) { console.warn(e); }
}

function stopWebcam() {
  try {
    if (state.currentSubmission && state.currentSubmission._snapshotInterval) { clearInterval(state.currentSubmission._snapshotInterval); delete state.currentSubmission._snapshotInterval; }
    if (_webcamStream) { _webcamStream.getTracks().forEach(t=>t.stop()); _webcamStream = null; }
    const feed = document.getElementById('webcamFeed'); if (feed) feed.remove();
  } catch (e) { console.warn(e); }
}

async function collectAndSubmit(options = {}) {
  try {
    const sub = state.currentSubmission;
    if (!sub) return showNotification('Nothing to submit','error');
    if (hasSubmittedBefore(sub.quizId, sub.email)) return showNotification('This email has already submitted this quiz', 'error');
    const quiz = getAllQuizzes()[sub.quizId] || state.currentQuiz || {};
    const trackingContext = (
      (sub.monitoring && (sub.monitoring.ipAddress || sub.monitoring.userAgent || sub.monitoring.ipCapturedAt || sub.monitoring.deviceId))
      || sub.ipAddress
      || sub.userAgent
      || sub.ipCapturedAt
      || sub.deviceId
    )
      ? {
          ipAddress: (sub.monitoring && sub.monitoring.ipAddress) || sub.ipAddress || '',
          userAgent: (sub.monitoring && sub.monitoring.userAgent) || sub.userAgent || navigator.userAgent || '',
          requestedAt: (sub.monitoring && sub.monitoring.ipCapturedAt) || sub.ipCapturedAt || new Date().toISOString(),
          deviceId: (sub.monitoring && sub.monitoring.deviceId) || sub.deviceId || getAppDeviceId()
        }
      : await getClientTrackingContext();
    sub.monitoring = {
      ...(sub.monitoring || {}),
      ipAddress: (sub.monitoring && sub.monitoring.ipAddress) || trackingContext.ipAddress || '',
      userAgent: (sub.monitoring && sub.monitoring.userAgent) || trackingContext.userAgent || navigator.userAgent || '',
      timezone: (sub.monitoring && sub.monitoring.timezone) || Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      deviceId: (sub.monitoring && sub.monitoring.deviceId) || trackingContext.deviceId || getAppDeviceId(),
      ipCapturedAt: (sub.monitoring && sub.monitoring.ipCapturedAt) || trackingContext.requestedAt || new Date().toISOString()
    };
    sub.ipAddress = sub.monitoring.ipAddress || trackingContext.ipAddress || '';
    sub.userAgent = sub.monitoring.userAgent || trackingContext.userAgent || navigator.userAgent || '';
    sub.deviceId = sub.monitoring.deviceId || trackingContext.deviceId || getAppDeviceId();
    sub.ipCapturedAt = sub.monitoring.ipCapturedAt || trackingContext.requestedAt || new Date().toISOString();
    const all = sub.allQuestions || [];
    const grade = buildSubmissionGradeState(sub, quiz, gradeSubmissionForQuiz(sub, quiz));
    const score = grade.score;
    const percent = grade.percent;
    applyGradeToSubmission(sub, grade);
    sub.timeSpent = sub.startedAt ? (Date.now() - new Date(sub.startedAt).getTime())/1000 : 0;
    sub.submittedAt = new Date().toISOString();
    sub.submissionId = buildSubmissionIdentity(sub);
    sub.shareKey = getSubmissionShareKey(sub, { persist: false });
    const allSubs = getAllSubmissions(); allSubs.push(sub);
    // Keep a local copy (hasSubmittedBefore / instant-result modal / offline use)
    // but DON'T fire the whole-array PUT /api/state/submissions — the cloud copy
    // goes up per-submission via the outbox, which also retries if the POST fails.
    saveAllSubmissions(allSubs, { skipNetworkSync: true });
    enqueueSubmissionToOutbox(sub);
    flushSubmissionOutbox().catch(() => {});
    clearExamDraft(sub.quizId, sub.email);
    showNotification('Submission saved  ','success');
    // cleanup proctoring
    try { if (document.fullscreenElement) document.exitFullscreen(); } catch(e){}
    stopWebcam();
    // Stop the exam timer — otherwise it ticks forever on a removed DOM node,
    // throws on every tick, and leaks interval handles across attempts.
    if (timerInterval) { try { clearInterval(timerInterval); } catch (e) {} timerInterval = null; }
    timeRemaining = 0;
    startTime = null;
    const calculator = document.getElementById('examCalculatorPanel'); if (calculator) calculator.remove();
    // re-enable selection
    try{ document.body.classList.remove('exam-no-select'); }catch(e){}
    state.currentSubmission = null;
    state.view = 'student';
    state.currentQuiz = null;
    render();
    if (quiz.showInstantResult !== false) {
      // Pull the latest submissions from the cloud BEFORE we open the result
      // modal so the displayed rank reflects every other student who has
      // already submitted — not just whatever happens to live in this
      // device's localStorage. Without this, every student tends to see
      // "Rank 1" because they're the only submission their browser knows
      // about. Bounded timeout so a slow backend doesn't block the modal.
      if (canUseNetworkSync()) {
        try { await pullSharedStateSilently({ forcePull: true, timeoutMs: 5000 }); }
        catch (error) { console.warn('Pre-rank cloud pull failed', error); }
      }
      showNotification(`Submitted. Score: ${formatScoreValue(score)}/${formatScoreValue(getSubmissionTotalMarks(sub, quiz))} (${percent}%) - ${sub.resultStatus}`, sub.resultStatus === 'Pass' ? 'success' : 'warning', 7000);
      setTimeout(() => showStudentResultModalFromSubmission(quiz, sub, true), 40);
    } else {
      showNotification('Submitted. Result will be released by your teacher.', 'success', 7000);
    }
  } catch (e) { console.error(e); showNotification('Error submitting','error'); }
  finally {
    if (options.manual === true) examSubmissionIntent.manualSubmitInFlight = false;
  }
}

// Global key/context handlers for copy protection while taking
document.addEventListener('contextmenu', (e)=>{
  if (state.view === 'take' && state.currentSubmission?.examStarted) { e.preventDefault(); showNotification('Right click disabled during exam','warning'); }
});
['copy', 'cut', 'paste', 'selectstart', 'dragstart'].forEach((eventName) => {
  document.addEventListener(eventName, (event) => {
    if (state.view !== 'take' || !state.currentSubmission?.examStarted) return;
    if (state.currentSubmission) {
      state.currentSubmission.monitoring = state.currentSubmission.monitoring || {};
      if (eventName === 'copy' || eventName === 'cut' || eventName === 'paste') {
        state.currentSubmission.monitoring.copyAttempts = (state.currentSubmission.monitoring.copyAttempts || 0) + 1;
      }
    }
    event.preventDefault();
    showNotification('This action is disabled during the quiz', 'warning');
  });
});
window.addEventListener('beforeprint', (event) => {
  if (state.view !== 'take' || !state.currentSubmission?.examStarted) return;
  if (state.currentSubmission) {
    state.currentSubmission.monitoring = state.currentSubmission.monitoring || {};
    state.currentSubmission.monitoring.copyAttempts = (state.currentSubmission.monitoring.copyAttempts || 0) + 1;
  }
  if (event && typeof event.preventDefault === 'function') event.preventDefault();
  showNotification('Printing is disabled during the quiz', 'warning');
});
document.addEventListener('keydown', (e)=>{
  if (state.view === 'take' && state.currentSubmission?.examStarted) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C' || e.key === 'p' || e.key === 'P' || e.key === 's' || e.key === 'S')) {
      if (state.currentSubmission) {
        state.currentSubmission.monitoring = state.currentSubmission.monitoring || {};
        state.currentSubmission.monitoring.copyAttempts = (state.currentSubmission.monitoring.copyAttempts || 0) + 1;
      }
      e.preventDefault(); showNotification('This action is disabled during exam','warning');
    }
  }
});

// detect common screenshot keys and auto-submit (best-effort)
document.addEventListener('keydown', (e)=>{
  if (state.view === 'take' && state.currentSubmission?.examStarted) {
    const k = e.key || '';
    if (k === 'PrintScreen' || (e.ctrlKey && e.shiftKey && (k === 'S' || k === 's')) || (e.metaKey && e.shiftKey && (k === '4' || k === '5'))) {
      state.screenshotDetected = true;
      if (state.currentSubmission) {
        state.currentSubmission.monitoring = state.currentSubmission.monitoring || {};
        state.currentSubmission.monitoring.screenshotAttempts = (state.currentSubmission.monitoring.screenshotAttempts || 0) + 1;
      }
      showNotification('Screenshot attempt detected   submitting exam', 'warning');
      setTimeout(()=>collectAndSubmit(), 800);
      e.preventDefault();
    }
  }
});

// Fullscreen exit detection -> auto submit
document.addEventListener('fullscreenchange', ()=>{
  if (isManualExamSubmitFlowActive()) return;
  if (state.view === 'take' && state.currentSubmission?.examStarted && !document.fullscreenElement) {
    state.currentSubmission.monitoring = state.currentSubmission.monitoring || {};
    state.currentSubmission.monitoring.fullscreenExits = (state.currentSubmission.monitoring.fullscreenExits || 0) + 1;
    // student left fullscreen; auto-submit as configured
    showNotification('Left fullscreen   exam will be submitted','warning');
    setTimeout(()=>collectAndSubmit(), 1200);
  }
});

document.addEventListener('keydown', (e) => {
  if (state.view !== 'take' || !state.currentSubmission?.examStarted) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const key = (e.key || '').toLowerCase();
  if (!['a', 'b', 'c', 'd', 'n', 'p', 's'].includes(key)) return;
  const activeTag = (document.activeElement && document.activeElement.tagName || '').toLowerCase();
  const activeType = (document.activeElement && document.activeElement.type || '').toLowerCase();
  if (['textarea', 'select'].includes(activeTag)) return;
  if (activeTag === 'input' && activeType !== 'radio') return;
  if (['a', 'b', 'c', 'd'].includes(key)) {
    const idx = state.currentSubmission.currentIndex || 0;
    const radio = document.querySelector(`input[name="opt-${idx}"][value="${key.toUpperCase()}"]`);
    if (radio) {
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
      e.preventDefault();
    }
  } else if (key === 'n') {
    document.getElementById('examNext')?.click();
    e.preventDefault();
  } else if (key === 'p') {
    document.getElementById('examPrev')?.click();
    e.preventDefault();
  } else if (key === 's') {
    document.getElementById('submitExam')?.click();
    e.preventDefault();
  }
});
