// Workers-compatible HTTP helpers and Supabase state-store accessor.
//
// Pages Functions receive `(context)` with `{ request, env, params, ... }`.
// `env` is where bindings and environment variables live — there's no
// `process.env` at request time. Helpers below take `env` so handlers can
// stay pure.

import {
  ADMIN_TEMPLATE_OWNER,
  buildLegacyAdminTemplateTargetId,
  isLegacyAdminTemplateSourceQuiz,
  createStateStore,
  VALID_STATE_KEYS,
  buildAdminScope,
  buildTeacherScope
} from '../../../state-store.js';

export { VALID_STATE_KEYS, buildAdminScope, buildTeacherScope };

// Mirror of server.js#deriveScope for the Workers runtime. Super-admin sessions
// get full-table reads; teacher sessions are restricted to their own rows.
export function deriveScope(session) {
  if (!session) throw new Error('Session required to derive scope');
  if (session.role === 'super_admin') return buildAdminScope();
  return buildTeacherScope(session.email);
}

let cachedStateStore = null;
let adminTemplateMigrationPromise = null;

export function readEnv(env, key, fallback = '') {
  const raw = env && env[key];
  if (raw == null) return fallback;
  return raw.toString();
}

export function getAllowedOrigins(env) {
  return readEnv(env, 'ALLOWED_ORIGINS', '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function hasSupabaseCredentials(env) {
  return !!(readEnv(env, 'SUPABASE_URL').trim() && readEnv(env, 'SUPABASE_SERVICE_ROLE_KEY').trim());
}

function getCorsOrigin(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return '';
  const allowed = getAllowedOrigins(env);
  if (allowed.includes('*')) return '*';
  return allowed.includes(origin) ? origin : '';
}

function buildHeaders(request, env, extraHeaders = {}, options = {}) {
  const allowMethods = Array.isArray(options.allowMethods)
    ? options.allowMethods.join(', ')
    : (options.allowMethods || 'GET, PUT, OPTIONS');
  const headers = new Headers();
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  const corsOrigin = getCorsOrigin(request, env);
  if (corsOrigin) {
    headers.set('Access-Control-Allow-Origin', corsOrigin);
    headers.set('Access-Control-Allow-Methods', allowMethods);
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    headers.set('Vary', 'Origin');
  }
  Object.entries(extraHeaders).forEach(([key, value]) => headers.set(key, value));
  return headers;
}

export function jsonResponse(request, env, status, payload, extraHeaders = {}, options = {}) {
  const headers = buildHeaders(request, env, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders }, options);
  return new Response(JSON.stringify(payload), { status, headers });
}

export function preflightResponse(request, env, options = {}) {
  if (request.method !== 'OPTIONS') return null;
  const headers = buildHeaders(request, env, { 'Content-Type': 'text/plain; charset=utf-8' }, options);
  return new Response('', { status: 204, headers });
}

export async function readJsonBody(request) {
  // Honour Content-Encoding: gzip (clients gzip the body when sending big
  // per-quiz payloads to cut egress). DecompressionStream is part of the Web
  // Streams API and is available in the Workers runtime.
  const encoding = ((request.headers && request.headers.get && request.headers.get('content-encoding')) || '').toLowerCase().trim();
  let text;
  if (encoding === 'gzip' && typeof DecompressionStream === 'function') {
    const decompressed = request.body
      ? request.body.pipeThrough(new DecompressionStream('gzip'))
      : null;
    if (!decompressed) return {};
    text = await new Response(decompressed).text();
  } else {
    text = await request.text();
  }
  if (!text || !text.trim()) return {};
  return JSON.parse(text);
}

export function getStateStore(env) {
  if (cachedStateStore) return cachedStateStore;
  if (!hasSupabaseCredentials(env)) {
    const error = new Error('Shared sync requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
    error.statusCode = 503;
    throw error;
  }
  cachedStateStore = createStateStore({
    storageBackend: 'supabase',
    supabaseUrl: readEnv(env, 'SUPABASE_URL').trim(),
    supabaseServiceRoleKey: readEnv(env, 'SUPABASE_SERVICE_ROLE_KEY').trim(),
    supabaseTablePrefix: readEnv(env, 'SUPABASE_TABLE_PREFIX', 'ope_').trim()
  });
  return cachedStateStore;
}

function buildLegacyAdminTemplateQuizCopy(sourceQuiz = {}, targetQuizId = '') {
  const now = new Date().toISOString();
  return {
    ...sourceQuiz,
    id: targetQuizId,
    teacherId: ADMIN_TEMPLATE_OWNER,
    isAdminTemplate: true,
    templateVisibility: 'all_teachers',
    sourceTeacherId: (sourceQuiz.teacherId || '').toString().trim().toLowerCase(),
    sourceQuizId: sourceQuiz.id || '',
    copiedToAdminAt: now,
    updatedAt: now,
    createdAt: sourceQuiz.createdAt || now,
    cloudSyncedAt: now
  };
}

export async function ensureLegacyAdminTemplateQuizCopies(env) {
  if (adminTemplateMigrationPromise) return adminTemplateMigrationPromise;
  adminTemplateMigrationPromise = (async () => {
    try {
      const stateStore = getStateStore(env);
      const quizzes = await stateStore.getStateValue('quizzes', buildAdminScope());
      if (!quizzes || typeof quizzes !== 'object') return 0;
      const pendingCopies = {};
      Object.keys(quizzes).forEach((quizId) => {
        const sourceQuiz = quizzes[quizId];
        if (!isLegacyAdminTemplateSourceQuiz(sourceQuiz)) return;
        const targetQuizId = buildLegacyAdminTemplateTargetId(sourceQuiz.id || quizId);
        if (!targetQuizId || quizzes[targetQuizId] || pendingCopies[targetQuizId]) return;
        pendingCopies[targetQuizId] = buildLegacyAdminTemplateQuizCopy(sourceQuiz, targetQuizId);
      });
      const count = Object.keys(pendingCopies).length;
      if (!count) return 0;
      await stateStore.putStateValue('quizzes', pendingCopies);
      return count;
    } catch (error) {
      console.warn('[Admin Templates] Workers migration skipped:', error && error.message ? error.message : error);
      return 0;
    }
  })();
  return adminTemplateMigrationPromise;
}

export function apiErrorResponse(request, env, error, fallbackMessage, options = {}) {
  const status = error && error.statusCode ? error.statusCode : 500;
  return jsonResponse(request, env, status, { error: error && error.message ? error.message : fallbackMessage }, {}, options);
}
