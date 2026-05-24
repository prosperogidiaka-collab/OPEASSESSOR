import {
  VALID_STATE_KEYS,
  apiErrorResponse,
  deriveScope,
  ensureLegacyAdminTemplateQuizCopies,
  getStateStore,
  jsonResponse,
  preflightResponse,
  readJsonBody
} from '../_lib/shared.js';
import { getSessionFromRequest } from '../_lib/auth.js';

// Submissions PUT is the one path that legitimately accepts unauthenticated
// requests — students don't have accounts, but they need to be able to
// upload their answer payload when they finish a quiz. Every other key
// requires a logged-in teacher. The `teachers` key is admin-managed except for
// a teacher's own profile/request fields, which can be patched by that teacher.
const PUBLIC_PUT_KEYS = new Set(['submissions']);
const ADMIN_ONLY_PUT_KEYS = new Set(['teachers']);
const TEACHER_SELF_WRITABLE_FIELDS = new Set([
  'name',
  'phone',
  'tokenRequestStatus',
  'tokenRequestedAt',
  'tokenRequestedPackageKey',
  'tokenRequestedAmount',
  'tokenRequestedTokens',
  'tokenRequestedDeviceId',
  'updatedAt'
]);

function redactTeachersValue(value) {
  if (!value || typeof value !== 'object') return value;
  const out = {};
  Object.keys(value).forEach((email) => {
    const record = value[email] || {};
    const safe = { ...record };
    delete safe.passwordHash;
    delete safe.password;
    out[email] = safe;
  });
  return out;
}

function buildTeacherSelfUpdateMap(session, value) {
  const teacherId = (session && session.email ? session.email : '').toString().trim().toLowerCase();
  if (!teacherId) {
    const error = new Error('Teacher session is missing an email ID');
    error.statusCode = 401;
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('Teacher updates must be sent as an object map');
    error.statusCode = 400;
    throw error;
  }
  const rawRecord = value[teacherId];
  if (!rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) {
    const error = new Error('Only your own teacher profile can be updated');
    error.statusCode = 403;
    throw error;
  }
  const safe = {
    teacherId,
    email: teacherId,
    updatedAt: typeof rawRecord.updatedAt === 'string' && rawRecord.updatedAt.trim()
      ? rawRecord.updatedAt.trim()
      : new Date().toISOString()
  };
  TEACHER_SELF_WRITABLE_FIELDS.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(rawRecord, field) || field === 'updatedAt') return;
    if (field === 'tokenRequestedAmount' || field === 'tokenRequestedTokens') {
      safe[field] = Number(rawRecord[field] || 0) || 0;
      return;
    }
    if (field === 'tokenRequestStatus') {
      safe[field] = rawRecord[field] === 'pending' ? 'pending' : '';
      return;
    }
    safe[field] = (rawRecord[field] || '').toString().trim();
  });
  return { [teacherId]: safe };
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const preflight = preflightResponse(request, env);
  if (preflight) return preflight;
  const rawKey = Array.isArray(params.stateKey) ? params.stateKey[0] : params.stateKey;
  const stateKey = decodeURIComponent((rawKey || '').toString());
  if (!VALID_STATE_KEYS.includes(stateKey)) {
    return jsonResponse(request, env, 404, { error: 'Unknown state key' });
  }

  const session = getSessionFromRequest(env, request);

  try {
    const stateStore = getStateStore(env);
    await ensureLegacyAdminTemplateQuizCopies(env);

    if (request.method === 'GET') {
      // GET always requires authentication — the response includes
      // password hashes, student PII, and answer keys.
      if (!session) {
        return jsonResponse(request, env, 401, { error: 'Authentication required' });
      }
      let value = await stateStore.getStateValue(stateKey, deriveScope(session));
      if (stateKey === 'teachers') value = redactTeachersValue(value);
      return jsonResponse(request, env, 200, { key: stateKey, value });
    }

    if (request.method === 'PUT') {
      if (!PUBLIC_PUT_KEYS.has(stateKey)) {
        if (!session) {
          return jsonResponse(request, env, 401, { error: 'Authentication required' });
        }
        const allowsTeacherSelfWrite = stateKey === 'teachers' && session.role === 'teacher';
        if (ADMIN_ONLY_PUT_KEYS.has(stateKey) && session.role !== 'super_admin' && !allowsTeacherSelfWrite) {
          return jsonResponse(request, env, 403, { error: 'Admin authentication required for this state key' });
        }
      }
      const parsed = await readJsonBody(request);
      if (!Object.prototype.hasOwnProperty.call(parsed, 'value')) {
        return jsonResponse(request, env, 400, { error: 'Missing value' });
      }
      const nextValue = stateKey === 'teachers' && session && session.role !== 'super_admin'
        ? buildTeacherSelfUpdateMap(session, parsed.value)
        : parsed.value;
      await stateStore.putStateValue(stateKey, nextValue);
      return jsonResponse(request, env, 200, {
        ok: true,
        key: stateKey,
        backend: stateStore.backend
      });
    }

    return jsonResponse(request, env, 405, { error: 'Method not allowed' });
  } catch (error) {
    return apiErrorResponse(request, env, error, 'Failed to update shared state');
  }
}
