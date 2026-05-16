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
// requires a logged-in teacher. The `teachers` key additionally requires a
// super_admin role since it's the account-management table.
const PUBLIC_PUT_KEYS = new Set(['submissions']);
const ADMIN_ONLY_PUT_KEYS = new Set(['teachers']);

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
        if (ADMIN_ONLY_PUT_KEYS.has(stateKey) && session.role !== 'super_admin') {
          return jsonResponse(request, env, 403, { error: 'Admin authentication required for this state key' });
        }
      }
      const parsed = await readJsonBody(request);
      if (!Object.prototype.hasOwnProperty.call(parsed, 'value')) {
        return jsonResponse(request, env, 400, { error: 'Missing value' });
      }
      await stateStore.putStateValue(stateKey, parsed.value);
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
