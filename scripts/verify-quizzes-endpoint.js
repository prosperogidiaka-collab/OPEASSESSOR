// Smoke-test the in-process branches of api/quizzes/[id].js without needing a
// live Supabase connection. Covers 401 (no session), 401 (bad token), 403
// (teacher trying to overwrite another teacher's quiz), 405 (GET), and 400
// (missing id / bad body). The 200 path requires real env vars and is skipped.
const { createSessionToken, SUPER_ADMIN_EMAIL } = require('../api/_auth');
const handler = require('../api/quizzes/[id].js');

function makeReq({ method = 'PUT', token = '', id = 'Q123', body = null, headers = {} } = {}) {
  return {
    method,
    query: id == null ? {} : { id },
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body
  };
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k] = v; },
    end(payload) { this.body = payload || ''; }
  };
  return res;
}

async function run(label, req, expectedStatus, bodyMatcher) {
  const res = makeRes();
  await handler(req, res);
  let parsed;
  try { parsed = JSON.parse(res.body); } catch (_) { parsed = res.body; }
  const ok = res.statusCode === expectedStatus && (!bodyMatcher || bodyMatcher(parsed));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  → status=${res.statusCode}, body=${JSON.stringify(parsed)}`);
  return ok;
}

(async () => {
  let passed = 0, total = 0;
  const check = async (...args) => { total++; if (await run(...args)) passed++; };

  // 405 — method check before auth (handler currently checks method first)
  await check('GET returns 405', makeReq({ method: 'GET' }), 405, (b) => /method/i.test(b.error));

  // 401 — no Authorization header
  await check('PUT without token returns 401', makeReq({ method: 'PUT' }), 401, (b) => /auth/i.test(b.error));

  // 401 — bad token
  await check('PUT with garbage token returns 401', makeReq({ method: 'PUT', token: 'not-a-real-token' }), 401);

  const teacherToken = createSessionToken('alice@example.com', 'teacher');
  const adminToken = createSessionToken(SUPER_ADMIN_EMAIL, 'super_admin');

  // 400 — missing id
  await check(
    'PUT with missing id returns 400',
    makeReq({ method: 'PUT', token: teacherToken, id: '', body: { id: 'X', teacherId: 'alice@example.com' } }),
    400,
    (b) => /id/i.test(b.error)
  );

  // 400 — non-object body
  await check(
    'PUT with array body returns 400',
    makeReq({ method: 'PUT', token: teacherToken, body: [] }),
    400,
    (b) => /object/i.test(b.error)
  );

  // 403 — teacher trying to upload another teacher's quiz (body teacherId mismatch)
  await check(
    'PUT cross-teacher returns 403',
    makeReq({ method: 'PUT', token: teacherToken, body: { id: 'Q123', teacherId: 'bob@example.com', title: 't' } }),
    403,
    (b) => /another teacher/i.test(b.error)
  );

  // POST is accepted (would 503 because Supabase env vars are absent in this test)
  await check(
    'POST with own quiz returns 503 (Supabase env not configured here)',
    makeReq({ method: 'POST', token: teacherToken, body: { id: 'Q123', teacherId: 'alice@example.com', title: 't' } }),
    503,
    (b) => /SUPABASE/i.test(b.error)
  );

  // Admin can target any teacher
  await check(
    'PUT super_admin with another teacher\'s quiz returns 503 (env not configured), not 403',
    makeReq({ method: 'PUT', token: adminToken, body: { id: 'Q123', teacherId: 'bob@example.com', title: 't' } }),
    503,
    (b) => /SUPABASE/i.test(b.error)
  );

  console.log(`\n${passed}/${total} checks passed`);
  process.exit(passed === total ? 0 : 1);
})();
