const { handlePreflight, readJsonBody, sendJson, sendApiError } = require('../_shared');
const { getSessionFromRequest } = require('../_auth');
const { buildQuizRow } = require('../../state-store');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const SUPABASE_TABLE_PREFIX = (process.env.SUPABASE_TABLE_PREFIX || 'ope_').trim();
const QUIZZES_TABLE = `${SUPABASE_TABLE_PREFIX}quizzes`;

let cachedClient = null;

function getSupabaseClient() {
  if (cachedClient) return cachedClient;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    const error = new Error('Per-quiz sync requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
    error.statusCode = 503;
    throw error;
  }
  const { createClient } = require('@supabase/supabase-js');
  cachedClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  return cachedClient;
}

function getRequestedQuizId(req) {
  const raw = req.query && req.query.id;
  if (Array.isArray(raw)) return raw[0] || '';
  return (raw || '').toString();
}

module.exports = async function quizUpsertHandler(req, res) {
  if (handlePreflight(req, res, { allowMethods: 'PUT, OPTIONS' })) return;
  if (req.method !== 'PUT') {
    return sendJson(req, res, 405, { error: 'Method not allowed' }, {}, { allowMethods: 'PUT, OPTIONS' });
  }

  const session = getSessionFromRequest(req);
  if (!session) {
    return sendJson(req, res, 401, { error: 'Authentication required' }, {}, { allowMethods: 'PUT, OPTIONS' });
  }

  const id = decodeURIComponent(getRequestedQuizId(req)).trim();
  if (!id) {
    return sendJson(req, res, 400, { error: 'Missing quiz id' }, {}, { allowMethods: 'PUT, OPTIONS' });
  }

  let parsed;
  try {
    parsed = await readJsonBody(req);
  } catch (error) {
    return sendJson(req, res, 400, { error: 'Invalid JSON body' }, {}, { allowMethods: 'PUT, OPTIONS' });
  }

  const quiz = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  if (!quiz) {
    return sendJson(req, res, 400, { error: 'Quiz body must be an object' }, {}, { allowMethods: 'PUT, OPTIONS' });
  }

  const bodyTeacherId = (quiz.teacherId || '').toString().trim().toLowerCase();
  const sessionEmail = (session.email || '').toString().trim().toLowerCase();
  const isAdmin = session.role === 'super_admin';
  if (!isAdmin && bodyTeacherId && bodyTeacherId !== sessionEmail) {
    return sendJson(req, res, 403, { error: 'Cannot save a quiz owned by another teacher' }, {}, { allowMethods: 'PUT, OPTIONS' });
  }
  if (!isAdmin && !bodyTeacherId) {
    quiz.teacherId = sessionEmail;
  }

  try {
    const supabase = getSupabaseClient();

    const { data: existing, error: lookupError } = await supabase
      .from(QUIZZES_TABLE)
      .select('teacher_id')
      .eq('quiz_id', id)
      .maybeSingle();
    if (lookupError) {
      const wrapped = new Error(`Supabase lookup failed for ${QUIZZES_TABLE}: ${lookupError.message}`);
      wrapped.cause = lookupError;
      throw wrapped;
    }
    if (existing && existing.teacher_id && existing.teacher_id !== sessionEmail && !isAdmin) {
      return sendJson(req, res, 403, { error: 'Quiz id is already owned by another teacher' }, {}, { allowMethods: 'PUT, OPTIONS' });
    }

    const syncedAt = new Date().toISOString();
    const row = { ...buildQuizRow(id, quiz), synced_at: syncedAt };

    const { error: upsertError } = await supabase
      .from(QUIZZES_TABLE)
      .upsert([row], { onConflict: 'quiz_id' });
    if (upsertError) {
      const wrapped = new Error(`Supabase upsert failed for ${QUIZZES_TABLE}: ${upsertError.message}`);
      wrapped.cause = upsertError;
      throw wrapped;
    }

    return sendJson(req, res, 200, { ok: true, id, syncedAt }, {}, { allowMethods: 'PUT, OPTIONS' });
  } catch (error) {
    return sendApiError(req, res, error, 'Failed to save quiz');
  }
};
