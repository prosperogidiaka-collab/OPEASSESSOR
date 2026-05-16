import {
  apiErrorResponse,
  deriveScope,
  ensureLegacyAdminTemplateQuizCopies,
  getStateStore,
  jsonResponse,
  preflightResponse
} from '../_lib/shared.js';
import { getSessionFromRequest } from '../_lib/auth.js';

// Strip secrets from the snapshot before it leaves the server. Even though
// this endpoint is auth-gated below, defense in depth: a teacher session
// shouldn't expose other teachers' password hashes, and a stolen session
// token should reveal as little as possible.
function redactState(state) {
  if (!state || typeof state !== 'object') return state;
  const teachers = {};
  Object.keys(state.teachers || {}).forEach((email) => {
    const record = state.teachers[email] || {};
    const safe = { ...record };
    delete safe.passwordHash;
    delete safe.password;
    teachers[email] = safe;
  });
  return { ...state, teachers };
}

export async function onRequest(context) {
  const { request, env } = context;
  const preflight = preflightResponse(request, env);
  if (preflight) return preflight;
  if (request.method !== 'GET') {
    return jsonResponse(request, env, 405, { error: 'Method not allowed' });
  }
  const session = getSessionFromRequest(env, request);
  if (!session) {
    return jsonResponse(request, env, 401, { error: 'Authentication required' });
  }
  try {
    const stateStore = getStateStore(env);
    await ensureLegacyAdminTemplateQuizCopies(env);
    const state = await stateStore.getState(deriveScope(session));
    return jsonResponse(request, env, 200, redactState(state));
  } catch (error) {
    return apiErrorResponse(request, env, error, 'Failed to load shared state');
  }
}
