import {
  apiErrorResponse,
  jsonResponse,
  preflightResponse,
  readEnv,
  readJsonBody
} from '../_lib/shared.js';

// POST /api/submissions  — append ONE student submission for an existing quiz.
//
// Public and code-gated, the same trust model as GET /api/quizzes/<id>: a
// student taking the quiz has no session, so the quiz id (its 6-digit code) is
// the access token. We only accept a submission whose quizId names a quiz that
// already exists, and we upsert a single row keyed by submission_id — so this
// can't clobber other quizzes' data and re-submitting the same attempt is
// idempotent. This is the per-submission alternative to the legacy public
// PUT /api/state/submissions, which replicated the whole client-side array.

const ALLOW = 'POST, OPTIONS';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeKey(value, fallback = '') {
  return ((value == null ? '' : value) || fallback || '').toString().trim();
}

function normalizeLowerKey(value, fallback = '') {
  return normalizeKey(value, fallback).toLowerCase();
}

function toIsoOrNull(value) {
  if (!value) return null;
  const stamp = new Date(value);
  return Number.isNaN(stamp.getTime()) ? null : stamp.toISOString();
}

// Mirror buildSubmissionRowForQuiz() in functions/api/quizzes/[id].js so a row
// written here is indistinguishable from one written through the per-quiz path.
function buildSubmissionRow(item, quizId) {
  const baseSubmissionId = (item && item.submissionId)
    ? normalizeKey(item.submissionId)
    : `${quizId}::${normalizeLowerKey(item && item.email)}::${(item && (item.submittedAt || item.updatedAt || item.startedAt || item.createdAt)) || `idx-0`}`;
  return {
    submission_id: baseSubmissionId,
    quiz_id: quizId,
    student_email: normalizeLowerKey(item && item.email),
    submitted_at: toIsoOrNull(item && item.submittedAt),
    updated_at: toIsoOrNull(item && (item.updatedAt || item.submittedAt || item.startedAt || item.createdAt)),
    payload: { ...(item || {}), submissionId: baseSubmissionId, quizId }
  };
}

let cachedClient = null;

async function getSupabaseClient(env) {
  if (cachedClient) return cachedClient;
  const supabaseUrl = readEnv(env, 'SUPABASE_URL').trim();
  const supabaseServiceRoleKey = readEnv(env, 'SUPABASE_SERVICE_ROLE_KEY').trim();
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    const error = new Error('Submission sync requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
    error.statusCode = 503;
    throw error;
  }
  const { createClient } = await import('@supabase/supabase-js');
  cachedClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  return cachedClient;
}

export async function onRequest(context) {
  const { request, env } = context;
  const preflight = preflightResponse(request, env, { allowMethods: ALLOW });
  if (preflight) return preflight;

  if (request.method !== 'POST') {
    return jsonResponse(request, env, 405, { error: 'Method not allowed' }, {}, { allowMethods: ALLOW });
  }

  let parsed;
  try {
    parsed = await readJsonBody(request);
  } catch (error) {
    return jsonResponse(request, env, 400, { error: 'Invalid JSON body' }, {}, { allowMethods: ALLOW });
  }

  // Accept { submission: <obj> } or a bare submission object.
  const submission = isPlainObject(parsed) && isPlainObject(parsed.submission) ? parsed.submission : parsed;
  if (!isPlainObject(submission)) {
    return jsonResponse(request, env, 400, { error: 'Body must be a submission object (or { submission })' }, {}, { allowMethods: ALLOW });
  }
  const quizId = normalizeKey(submission.quizId);
  if (!quizId) {
    return jsonResponse(request, env, 400, { error: 'Submission is missing quizId' }, {}, { allowMethods: ALLOW });
  }

  try {
    const supabase = await getSupabaseClient(env);
    const tablePrefix = readEnv(env, 'SUPABASE_TABLE_PREFIX', 'ope_').trim();
    const quizzesTable = `${tablePrefix}quizzes`;
    const submissionsTable = `${tablePrefix}submissions`;

    // The quiz must exist — knowing its id is the access gate.
    const { data: quizRow, error: quizError } = await supabase
      .from(quizzesTable)
      .select('quiz_id')
      .eq('quiz_id', quizId)
      .maybeSingle();
    if (quizError) {
      const wrapped = new Error(`Supabase lookup failed for ${quizzesTable}: ${quizError.message}`);
      wrapped.cause = quizError;
      throw wrapped;
    }
    if (!quizRow) {
      return jsonResponse(request, env, 404, { error: 'Quiz not found' }, {}, { allowMethods: ALLOW });
    }

    const row = buildSubmissionRow(submission, quizId);
    const { error: upsertError } = await supabase
      .from(submissionsTable)
      .upsert([row], { onConflict: 'submission_id' });
    if (upsertError) {
      const wrapped = new Error(`Supabase upsert failed for ${submissionsTable}: ${upsertError.message}`);
      wrapped.cause = upsertError;
      throw wrapped;
    }

    return jsonResponse(request, env, 200, { ok: true, quizId, submissionId: row.submission_id }, {}, { allowMethods: ALLOW });
  } catch (error) {
    return apiErrorResponse(request, env, error, 'Failed to save submission', { allowMethods: ALLOW });
  }
}
