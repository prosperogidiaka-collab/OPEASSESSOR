const fs = require('fs');
const path = require('path');

const DEFAULT_STATE = {
  quizzes: {},
  submissions: [],
  teachers: {},
  students: {},
  tokenTransactions: []
};

const VALID_STATE_KEYS = Object.keys(DEFAULT_STATE);
const SUPABASE_SELECT_PAGE_SIZE = 1000;
const SUPABASE_UPSERT_BATCH_SIZE = 250;
const OPTIONAL_SUPABASE_STATE_KEYS = new Set(['tokenTransactions']);
const ADMIN_TEMPLATE_OWNER = 'prosperogidiaka@gmail.com';
const LEGACY_ADMIN_TEMPLATE_SOURCE_TEACHER = 'jillmichae@gmail.com';
const LEGACY_ADMIN_TEMPLATE_CUTOFF_ISO = '2026-05-16T23:59:59.999+01:00';
const LEGACY_ADMIN_TEMPLATE_CUTOFF_TS = Date.parse(LEGACY_ADMIN_TEMPLATE_CUTOFF_ISO);

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeKey(value, fallback = '') {
  return (value || fallback || '').toString().trim();
}

function normalizeLowerKey(value, fallback = '') {
  return normalizeKey(value, fallback).toLowerCase();
}

function toIsoOrNull(value) {
  if (!value) return null;
  const stamp = new Date(value);
  return Number.isNaN(stamp.getTime()) ? null : stamp.toISOString();
}

function recordStamp(item) {
  const raw = item && (item.deletedAt || item.updatedAt || item.editedAt || item.submittedAt || item.uploadedAt || item.tokenUpdatedAt || item.tokenRequestedAt || item.licenseUpdatedAt || item.licenseRequestedAt || item.idChangedAt || item.createdAt || item.startedAt);
  const stamp = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(stamp) ? stamp : 0;
}

function teacherAccessStamp(item = {}) {
  return Math.max(
    item && item.licenseUpdatedAt ? new Date(item.licenseUpdatedAt).getTime() : 0,
    item && item.tokenUpdatedAt ? new Date(item.tokenUpdatedAt).getTime() : 0,
    item && item.tokenRequestedAt ? new Date(item.tokenRequestedAt).getTime() : 0
  );
}

function submissionKey(item, index = 0) {
  if (item && item.submissionId) return normalizeKey(item.submissionId, `submission-${index}`);
  const quizId = (item && item.quizId) || '';
  const email = ((item && item.email) || '').toString().trim().toLowerCase();
  const stamp = item && (item.submittedAt || item.updatedAt || item.startedAt || item.createdAt) || `idx-${index}`;
  return `${quizId}::${email}::${stamp}`;
}

function studentKey(item, index = 0) {
  return ((item && (item.email || item.registrationNo || item.id || item.name)) || `student-${index}`).toString().trim().toLowerCase();
}

function tokenTransactionKey(item, index = 0) {
  if (item && item.id) return normalizeKey(item.id, `txn-${index}`);
  const userId = normalizeLowerKey(item && item.userId, 'teacher');
  const type = normalizeKey(item && item.type, 'transaction');
  const stamp = item && (item.createdAt || item.updatedAt) || `idx-${index}`;
  return `${userId}::${type}::${stamp}`;
}

function mergeStudentLists(currentList = [], incomingList = []) {
  const merged = new Map();
  const add = (item, index) => {
    if (!item || typeof item !== 'object') return;
    const key = studentKey(item, index);
    const current = merged.get(key);
    if (!current || recordStamp(item) >= recordStamp(current)) merged.set(key, item);
  };
  currentList.forEach(add);
  incomingList.forEach(add);
  return Array.from(merged.values()).sort((a, b) => ((a.name || '').localeCompare(b.name || '')));
}

function mergeRecordMaps(currentValue = {}, incomingValue = {}) {
  const merged = { ...(currentValue || {}) };
  Object.keys(incomingValue || {}).forEach((key) => {
    const incomingItem = incomingValue[key];
    const currentItem = currentValue ? currentValue[key] : undefined;
    if (Array.isArray(incomingItem) || Array.isArray(currentItem)) {
      merged[key] = mergeStudentLists(currentItem || [], incomingItem || []);
      return;
    }
    if (!currentItem || recordStamp(incomingItem) >= recordStamp(currentItem)) merged[key] = incomingItem;
  });
  return merged;
}

function mergeTeacherRecord(currentItem = {}, incomingItem = {}) {
  const currentStamp = recordStamp(currentItem);
  const incomingStamp = recordStamp(incomingItem);
  const base = incomingStamp >= currentStamp ? { ...(currentItem || {}), ...(incomingItem || {}) } : { ...(incomingItem || {}), ...(currentItem || {}) };
  const currentAccessStamp = teacherAccessStamp(currentItem);
  const incomingAccessStamp = teacherAccessStamp(incomingItem);
  const licenseSource = incomingAccessStamp >= currentAccessStamp ? incomingItem : currentItem;
  ['licenseEndsAt', 'licenseStopped', 'licenseRequestStatus', 'licenseUpdatedAt', 'tokenBalance', 'unlimitedExpiresAt', 'unlimitedDeviceId', 'tokenRequestStatus', 'tokenRequestedAt', 'tokenRequestedPackageKey', 'tokenRequestedAmount', 'tokenRequestedTokens', 'tokenRequestedDeviceId', 'lastUnlimitedDeviceTransferAt', 'tokenUpdatedAt'].forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(licenseSource || {}, field)) base[field] = licenseSource[field];
  });
  return base;
}

function mergeTeacherMaps(currentValue = {}, incomingValue = {}) {
  const merged = {};
  const keys = new Set([...Object.keys(currentValue || {}), ...Object.keys(incomingValue || {})]);
  keys.forEach((key) => {
    merged[key] = mergeTeacherRecord(currentValue ? currentValue[key] : {}, incomingValue ? incomingValue[key] : {});
  });
  return merged;
}

function mergeSubmissionLists(currentList, incomingList) {
  const merged = new Map();
  const add = (item, index) => {
    if (!item || typeof item !== 'object') return;
    const normalized = item.submissionId ? item : { ...item, submissionId: submissionKey(item, index) };
    const key = submissionKey(normalized, index);
    const current = merged.get(key);
    if (!current || recordStamp(normalized) >= recordStamp(current)) merged.set(key, normalized);
  };
  (currentList || []).forEach(add);
  (incomingList || []).forEach(add);
  return Array.from(merged.values()).sort((a, b) => {
    const left = new Date(a.submittedAt || a.updatedAt || a.startedAt || 0).getTime();
    const right = new Date(b.submittedAt || b.updatedAt || b.startedAt || 0).getTime();
    return left - right;
  });
}

function mergeTokenTransactionLists(currentList, incomingList) {
  const merged = new Map();
  const add = (item, index) => {
    if (!item || typeof item !== 'object') return;
    const normalized = item.id ? item : { ...item, id: tokenTransactionKey(item, index) };
    const key = tokenTransactionKey(normalized, index);
    const current = merged.get(key);
    if (!current || recordStamp(normalized) >= recordStamp(current)) merged.set(key, normalized);
  };
  (currentList || []).forEach(add);
  (incomingList || []).forEach(add);
  return Array.from(merged.values()).sort((a, b) => {
    const left = new Date(a.createdAt || a.updatedAt || 0).getTime();
    const right = new Date(b.createdAt || b.updatedAt || 0).getTime();
    return left - right;
  });
}

function mergeStateValue(stateKey, currentValue, incomingValue) {
  if (stateKey === 'submissions') return mergeSubmissionLists(currentValue || [], incomingValue || []);
  if (stateKey === 'tokenTransactions') return mergeTokenTransactionLists(currentValue || [], incomingValue || []);
  if (stateKey === 'teachers') return mergeTeacherMaps(currentValue || {}, incomingValue || {});
  if (stateKey === 'quizzes' || stateKey === 'students') return mergeRecordMaps(currentValue || {}, incomingValue || {});
  return incomingValue;
}

function ensureParentDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonFile(filePath) {
  ensureParentDirectory(filePath);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(DEFAULT_STATE, null, 2));
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    return {
      quizzes: parsed.quizzes || {},
      submissions: parsed.submissions || [],
      teachers: parsed.teachers || {},
      students: parsed.students || {},
      tokenTransactions: parsed.tokenTransactions || []
    };
  } catch (error) {
    fs.writeFileSync(filePath, JSON.stringify(DEFAULT_STATE, null, 2));
    return { ...DEFAULT_STATE };
  }
}

function writeJsonFile(filePath, nextState) {
  ensureParentDirectory(filePath);
  const tmpFile = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(nextState, null, 2));
  fs.renameSync(tmpFile, filePath);
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function isSupabaseMissingTableError(error) {
  const message = (error && (error.message || error.cause?.message) || '').toString();
  const code = (error && (error.supabaseCode || error.code || error.cause?.code) || '').toString().trim().toUpperCase();
  if (code === 'PGRST205' || code === '42P01') return true;
  return /schema cache/i.test(message) || /could not find the table/i.test(message) || /relation .* does not exist/i.test(message);
}

function getOptionalStateFallbackValue(stateKey) {
  if (stateKey === 'tokenTransactions') return [];
  if (stateKey === 'submissions') return [];
  return {};
}

function isSharedAdminTemplateQuiz(item = {}) {
  const owner = normalizeLowerKey(item && item.teacherId);
  const visibility = normalizeKey(item && item.templateVisibility);
  return item.isAdminTemplate === true || (owner === ADMIN_TEMPLATE_OWNER && visibility === 'all_teachers');
}

function isLegacyAdminTemplateSourceQuiz(item = {}) {
  const owner = normalizeLowerKey(item && item.teacherId);
  if (owner !== LEGACY_ADMIN_TEMPLATE_SOURCE_TEACHER) return false;
  const sourceTimestamp = Date.parse(((item && (item.createdAt || item.updatedAt)) || '').toString());
  if (Number.isFinite(sourceTimestamp) && Number.isFinite(LEGACY_ADMIN_TEMPLATE_CUTOFF_TS)) {
    return sourceTimestamp <= LEGACY_ADMIN_TEMPLATE_CUTOFF_TS;
  }
  return true;
}

function buildLegacyAdminTemplateTargetId(quizId = '') {
  const normalizedQuizId = normalizeKey(quizId);
  return normalizedQuizId ? `admin-template-${normalizedQuizId}` : '';
}

function filterStateForScope(state, scope) {
  if (!state || scope.isAdmin) return state;
  const teacherId = scope.teacherId;
  const filterOwnedMap = (map) => {
    if (!map || typeof map !== 'object') return {};
    const out = {};
    Object.keys(map).forEach((key) => {
      const item = map[key];
      const owner = normalizeLowerKey(item && (item.teacherId || item.userId));
      if (owner === teacherId) out[key] = item;
    });
    return out;
  };
  const filterVisibleQuizMap = (map) => {
    if (!map || typeof map !== 'object') return {};
    const out = {};
    Object.keys(map).forEach((key) => {
      const item = map[key];
      const owner = normalizeLowerKey(item && (item.teacherId || item.userId));
      if (owner === teacherId || isSharedAdminTemplateQuiz(item)) out[key] = item;
    });
    return out;
  };
  const ownTeacherQuizzes = filterOwnedMap(state.quizzes || {});
  const visibleQuizzes = filterVisibleQuizMap(state.quizzes || {});
  const ownQuizIds = new Set(Object.keys(ownTeacherQuizzes));
  const ownTeachers = {};
  if (state.teachers && state.teachers[teacherId]) ownTeachers[teacherId] = state.teachers[teacherId];
  const ownStudents = {};
  if (state.students && state.students[teacherId]) ownStudents[teacherId] = state.students[teacherId];
  const ownSubmissions = (state.submissions || []).filter((item) => item && ownQuizIds.has(normalizeKey(item.quizId)));
  const ownTokenTxns = (state.tokenTransactions || []).filter((item) => item && normalizeLowerKey(item.userId) === teacherId);
  return {
    quizzes: visibleQuizzes,
    submissions: ownSubmissions,
    teachers: ownTeachers,
    students: ownStudents,
    tokenTransactions: ownTokenTxns
  };
}

function createFileStateStore(options) {
  const dataFile = options.dataFile;
  return {
    backend: 'file',
    details: {
      dataFile
    },
    async getState(scope) {
      requireScope(scope, 'getState');
      return filterStateForScope(readJsonFile(dataFile), scope);
    },
    async getStateValue(stateKey, scope) {
      requireScope(scope, `getStateValue(${stateKey})`);
      const state = filterStateForScope(readJsonFile(dataFile), scope);
      return state[stateKey];
    },
    async putStateValue(stateKey, incomingValue) {
      const state = readJsonFile(dataFile);
      state[stateKey] = mergeStateValue(stateKey, state[stateKey], incomingValue);
      writeJsonFile(dataFile, state);
      return state[stateKey];
    }
  };
}

function requireSupabaseClientFactory() {
  try {
    return require('@supabase/supabase-js').createClient;
  } catch (error) {
    throw new Error('Supabase backend requires @supabase/supabase-js. Run npm install before starting the server.');
  }
}

function buildSupabaseTableNames(prefix) {
  return {
    quizzes: `${prefix}quizzes`,
    submissions: `${prefix}submissions`,
    teachers: `${prefix}teachers`,
    students: `${prefix}students`,
    tokenTransactions: `${prefix}token_transactions`
  };
}

// Per-table SELECT projections. The full record always lives in `payload`; the
// columns below are the ones the rowsTo* helpers actually read off the row to
// fall back when a payload field is missing. If a future rowsTo* needs another
// column, add it here.
const SUPABASE_SELECT_COLUMNS = {
  quizzes: 'quiz_id, teacher_id, title, created_at, updated_at, payload',
  teachers: 'teacher_id, email, role, created_at, updated_at, payload',
  students: 'teacher_id, student_key, name, email, registration_no, uploaded_at, updated_at, payload',
  submissions: 'submission_id, quiz_id, student_email, submitted_at, updated_at, payload',
  tokenTransactions: 'transaction_id, user_id, type, created_at, updated_at, payload'
};

// Scope contract: every read into the storage layer must declare whether it is
// allowed to see all rows or just one teacher's. There is no implicit default
// because forgetting to pass a scope at a new call site would silently leak
// other teachers' data.
function buildAdminScope() {
  return { isAdmin: true, teacherId: '' };
}

function buildTeacherScope(email) {
  return { isAdmin: false, teacherId: normalizeLowerKey(email) };
}

function requireScope(scope, callerName) {
  if (!scope || typeof scope !== 'object') {
    throw new Error(`${callerName} requires a scope object (use buildAdminScope() or buildTeacherScope(email))`);
  }
  if (!scope.isAdmin && !scope.teacherId) {
    throw new Error(`${callerName}: non-admin scope requires a teacherId`);
  }
}

function buildQuizRow(id, item) {
  const quizId = normalizeKey(item && item.id, id);
  return {
    quiz_id: quizId,
    teacher_id: normalizeLowerKey(item && item.teacherId),
    title: normalizeKey(item && item.title),
    created_at: toIsoOrNull(item && item.createdAt),
    updated_at: toIsoOrNull(item && (item.updatedAt || item.editedAt || item.createdAt)),
    payload: { ...(item || {}), id: quizId }
  };
}

function buildTeacherRow(id, item) {
  const teacherId = normalizeLowerKey(item && (item.teacherId || item.email), id);
  return {
    teacher_id: teacherId,
    email: normalizeLowerKey(item && (item.email || item.teacherId), teacherId),
    role: normalizeKey(item && item.role, 'teacher') || 'teacher',
    created_at: toIsoOrNull(item && item.createdAt),
    updated_at: toIsoOrNull(item && (item.updatedAt || item.tokenUpdatedAt || item.tokenRequestedAt || item.licenseUpdatedAt || item.passwordResetAt || item.createdAt)),
    payload: { ...(item || {}), teacherId, email: normalizeLowerKey(item && (item.email || item.teacherId), teacherId) }
  };
}

function buildStudentRows(stateValue) {
  const rows = [];
  Object.keys(stateValue || {}).forEach((teacherId) => {
    const normalizedTeacherId = normalizeLowerKey(teacherId);
    const list = Array.isArray(stateValue[teacherId]) ? stateValue[teacherId] : [];
    list.forEach((item, index) => {
      const rowStudentKey = studentKey(item, index);
      rows.push({
        teacher_id: normalizedTeacherId,
        student_key: rowStudentKey,
        name: normalizeKey(item && item.name),
        email: normalizeLowerKey(item && item.email),
        registration_no: normalizeKey(item && (item.registrationNo || item.id)),
        uploaded_at: toIsoOrNull(item && item.uploadedAt),
        updated_at: toIsoOrNull(item && (item.updatedAt || item.uploadedAt || item.createdAt)),
        payload: { ...(item || {}) }
      });
    });
  });
  return rows;
}

function buildSubmissionRows(stateValue) {
  return (stateValue || []).map((item, index) => ({
    submission_id: submissionKey(item, index),
    quiz_id: normalizeKey(item && item.quizId),
    student_email: normalizeLowerKey(item && item.email),
    submitted_at: toIsoOrNull(item && item.submittedAt),
    updated_at: toIsoOrNull(item && (item.updatedAt || item.submittedAt || item.startedAt || item.createdAt)),
    payload: { ...(item || {}), submissionId: submissionKey(item, index) }
  }));
}

function buildTokenTransactionRows(stateValue) {
  return (stateValue || []).map((item, index) => ({
    transaction_id: tokenTransactionKey(item, index),
    user_id: normalizeLowerKey(item && item.userId),
    type: normalizeKey(item && item.type),
    created_at: toIsoOrNull(item && item.createdAt),
    updated_at: toIsoOrNull(item && (item.updatedAt || item.createdAt)),
    payload: { ...(item || {}), id: tokenTransactionKey(item, index) }
  }));
}

function rowsToQuizMap(rows) {
  const quizzes = {};
  (rows || []).forEach((row) => {
    if (!row || !row.quiz_id) return;
    const payload = isObject(row.payload) ? { ...row.payload } : {};
    if (!payload.id) payload.id = row.quiz_id;
    if (!payload.teacherId && row.teacher_id) payload.teacherId = row.teacher_id;
    if (!payload.title && row.title) payload.title = row.title;
    if (!payload.createdAt && row.created_at) payload.createdAt = row.created_at;
    if (!payload.updatedAt && row.updated_at) payload.updatedAt = row.updated_at;
    quizzes[row.quiz_id] = payload;
  });
  return quizzes;
}

function rowsToTeacherMap(rows) {
  const teachers = {};
  (rows || []).forEach((row) => {
    if (!row || !row.teacher_id) return;
    const payload = isObject(row.payload) ? { ...row.payload } : {};
    if (!payload.teacherId) payload.teacherId = row.teacher_id;
    if (!payload.email && row.email) payload.email = row.email;
    if (!payload.role && row.role) payload.role = row.role;
    if (!payload.createdAt && row.created_at) payload.createdAt = row.created_at;
    if (!payload.updatedAt && row.updated_at) payload.updatedAt = row.updated_at;
    teachers[row.teacher_id] = payload;
  });
  return teachers;
}

function rowsToStudentMap(rows) {
  const grouped = {};
  (rows || []).forEach((row) => {
    if (!row || !row.teacher_id) return;
    const payload = isObject(row.payload) ? { ...row.payload } : {};
    if (!payload.name && row.name) payload.name = row.name;
    if (!payload.email && row.email) payload.email = row.email;
    if (!payload.registrationNo && row.registration_no) payload.registrationNo = row.registration_no;
    if (!payload.id && row.registration_no) payload.id = row.registration_no;
    if (!payload.uploadedAt && row.uploaded_at) payload.uploadedAt = row.uploaded_at;
    grouped[row.teacher_id] = grouped[row.teacher_id] || [];
    grouped[row.teacher_id].push(payload);
  });
  Object.keys(grouped).forEach((teacherId) => {
    grouped[teacherId] = grouped[teacherId].sort((a, b) => ((a.name || '').localeCompare(b.name || '')));
  });
  return grouped;
}

function rowsToSubmissionList(rows) {
  return (rows || []).map((row) => {
    const payload = isObject(row.payload) ? { ...row.payload } : {};
    if (!payload.submissionId && row.submission_id) payload.submissionId = row.submission_id;
    if (!payload.quizId && row.quiz_id) payload.quizId = row.quiz_id;
    if (!payload.email && row.student_email) payload.email = row.student_email;
    if (!payload.submittedAt && row.submitted_at) payload.submittedAt = row.submitted_at;
    if (!payload.updatedAt && row.updated_at) payload.updatedAt = row.updated_at;
    return payload;
  }).sort((a, b) => {
    const left = new Date(a.submittedAt || a.updatedAt || a.startedAt || 0).getTime();
    const right = new Date(b.submittedAt || b.updatedAt || b.startedAt || 0).getTime();
    return left - right;
  });
}

function rowsToTokenTransactionList(rows) {
  return (rows || []).map((row) => {
    const payload = isObject(row.payload) ? { ...row.payload } : {};
    if (!payload.id && row.transaction_id) payload.id = row.transaction_id;
    if (!payload.userId && row.user_id) payload.userId = row.user_id;
    if (!payload.type && row.type) payload.type = row.type;
    if (!payload.createdAt && row.created_at) payload.createdAt = row.created_at;
    if (!payload.updatedAt && row.updated_at) payload.updatedAt = row.updated_at;
    return payload;
  }).sort((a, b) => {
    const left = new Date(a.createdAt || a.updatedAt || 0).getTime();
    const right = new Date(b.createdAt || b.updatedAt || 0).getTime();
    return left - right;
  });
}

function createSupabaseStateStore(options) {
  const supabaseUrl = (options.supabaseUrl || '').trim();
  const supabaseServiceRoleKey = (options.supabaseServiceRoleKey || '').trim();
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('Supabase backend requires both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }

  const createClient = requireSupabaseClientFactory();
  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });

  const tables = buildSupabaseTableNames(options.supabaseTablePrefix || 'ope_');
  const missingOptionalStateKeys = new Set();
  const warnedOptionalStateKeys = new Set();

  function markOptionalStateKeyAvailable(stateKey) {
    missingOptionalStateKeys.delete(stateKey);
  }

  function handleOptionalStateKeyError(stateKey, error, phase = 'read') {
    if (!OPTIONAL_SUPABASE_STATE_KEYS.has(stateKey) || !isSupabaseMissingTableError(error)) throw error;
    missingOptionalStateKeys.add(stateKey);
    if (!warnedOptionalStateKeys.has(stateKey)) {
      warnedOptionalStateKeys.add(stateKey);
      console.warn(`[Supabase] Optional table for ${stateKey} is missing (${tables[stateKey]}). Continuing without ${stateKey} sync during ${phase}.`);
    }
    return getOptionalStateFallbackValue(stateKey);
  }

  async function selectAllRows(table, columns = '*', orderings = [], shapeQuery = null) {
    const rows = [];
    let from = 0;
    while (true) {
      let query = supabase.from(table).select(columns).range(from, from + SUPABASE_SELECT_PAGE_SIZE - 1);
      orderings.forEach((ordering) => {
        query = query.order(ordering.column, { ascending: ordering.ascending !== false });
      });
      if (typeof shapeQuery === 'function') query = shapeQuery(query);
      const { data, error } = await query;
      if (error) {
        const wrapped = new Error(`Supabase select failed for ${table}: ${error.message}`);
        wrapped.supabaseCode = error.code || '';
        wrapped.cause = error;
        throw wrapped;
      }
      rows.push(...(data || []));
      if (!data || data.length < SUPABASE_SELECT_PAGE_SIZE) break;
      from += SUPABASE_SELECT_PAGE_SIZE;
    }
    return rows;
  }

  async function upsertRows(table, rows, onConflict) {
    if (!rows.length) return;
    const batches = chunkArray(rows, SUPABASE_UPSERT_BATCH_SIZE);
    for (const batch of batches) {
      const { error } = await supabase.from(table).upsert(batch, { onConflict });
      if (error) {
        const wrapped = new Error(`Supabase upsert failed for ${table}: ${error.message}`);
        wrapped.supabaseCode = error.code || '';
        wrapped.cause = error;
        throw wrapped;
      }
    }
  }

  function teacherIdFilter(column, scope) {
    if (scope.isAdmin) return null;
    return (query) => query.eq(column, scope.teacherId);
  }

  async function loadQuizzesMap(scope) {
    if (scope.isAdmin) {
      const rows = await selectAllRows(
        tables.quizzes,
        SUPABASE_SELECT_COLUMNS.quizzes,
        [{ column: 'quiz_id' }]
      );
      return rowsToQuizMap(rows);
    }
    const [teacherRows, adminTemplateRows] = await Promise.all([
      selectAllRows(
        tables.quizzes,
        SUPABASE_SELECT_COLUMNS.quizzes,
        [{ column: 'quiz_id' }],
        (query) => query.eq('teacher_id', scope.teacherId)
      ),
      selectAllRows(
        tables.quizzes,
        SUPABASE_SELECT_COLUMNS.quizzes,
        [{ column: 'quiz_id' }],
        (query) => query.eq('teacher_id', ADMIN_TEMPLATE_OWNER)
      )
    ]);
    const visibleAdminTemplateRows = (adminTemplateRows || []).filter((row) => {
      const payload = isObject(row && row.payload) ? row.payload : {};
      return isSharedAdminTemplateQuiz({
        ...payload,
        teacherId: payload.teacherId || row.teacher_id
      });
    });
    return rowsToQuizMap([...(teacherRows || []), ...visibleAdminTemplateRows]);
  }

  async function loadTeachersMap(scope) {
    // Even non-admin sessions can resolve their own row (so /api/state continues
    // to render the teacher's profile). Cross-tenant rows are admin-only.
    const rows = await selectAllRows(
      tables.teachers,
      SUPABASE_SELECT_COLUMNS.teachers,
      [{ column: 'teacher_id' }],
      teacherIdFilter('teacher_id', scope)
    );
    return rowsToTeacherMap(rows);
  }

  async function loadStudentsMap(scope) {
    const rows = await selectAllRows(
      tables.students,
      SUPABASE_SELECT_COLUMNS.students,
      [{ column: 'teacher_id' }, { column: 'student_key' }],
      teacherIdFilter('teacher_id', scope)
    );
    return rowsToStudentMap(rows);
  }

  async function loadTeacherQuizIds(scope) {
    if (scope.isAdmin) return null;
    const rows = await selectAllRows(
      tables.quizzes,
      'quiz_id',
      [{ column: 'quiz_id' }],
      (query) => query.eq('teacher_id', scope.teacherId)
    );
    return rows.map((row) => row.quiz_id).filter(Boolean);
  }

  async function loadSubmissionList(scope) {
    let shape = null;
    if (!scope.isAdmin) {
      // Submissions has no teacher_id column, so scope it via the teacher's
      // own quiz_ids. Empty quiz set → no submissions, skip the round-trip
      // (PostgREST rejects an empty .in() filter with a 400).
      const quizIds = await loadTeacherQuizIds(scope);
      if (!quizIds || quizIds.length === 0) return [];
      shape = (query) => query.in('quiz_id', quizIds);
    }
    const rows = await selectAllRows(
      tables.submissions,
      SUPABASE_SELECT_COLUMNS.submissions,
      [{ column: 'submitted_at' }, { column: 'submission_id' }],
      shape
    );
    return rowsToSubmissionList(rows);
  }

  async function loadTokenTransactionList(scope) {
    try {
      const rows = await selectAllRows(
        tables.tokenTransactions,
        SUPABASE_SELECT_COLUMNS.tokenTransactions,
        [{ column: 'created_at' }, { column: 'transaction_id' }],
        teacherIdFilter('user_id', scope)
      );
      markOptionalStateKeyAvailable('tokenTransactions');
      return rowsToTokenTransactionList(rows);
    } catch (error) {
      return handleOptionalStateKeyError('tokenTransactions', error, 'read');
    }
  }

  async function persistStateValue(stateKey, nextValue) {
    if (stateKey === 'quizzes') {
      const rows = Object.keys(nextValue || {}).map((id) => buildQuizRow(id, nextValue[id]));
      await upsertRows(tables.quizzes, rows, 'quiz_id');
      return;
    }
    if (stateKey === 'teachers') {
      const rows = Object.keys(nextValue || {}).map((id) => buildTeacherRow(id, nextValue[id]));
      await upsertRows(tables.teachers, rows, 'teacher_id');
      return;
    }
    if (stateKey === 'students') {
      const rows = buildStudentRows(nextValue);
      await upsertRows(tables.students, rows, 'teacher_id,student_key');
      return;
    }
    if (stateKey === 'submissions') {
      const rows = buildSubmissionRows(nextValue);
      await upsertRows(tables.submissions, rows, 'submission_id');
      return;
    }
    if (stateKey === 'tokenTransactions') {
      try {
        const rows = buildTokenTransactionRows(nextValue);
        await upsertRows(tables.tokenTransactions, rows, 'transaction_id');
        markOptionalStateKeyAvailable('tokenTransactions');
      } catch (error) {
        handleOptionalStateKeyError('tokenTransactions', error, 'write');
      }
      return;
    }
    throw new Error(`Unsupported state key: ${stateKey}`);
  }

  return {
    backend: 'supabase',
    details: {
      supabaseUrl,
      tables,
      get missingOptionalStateKeys() {
        return Array.from(missingOptionalStateKeys);
      }
    },
    async getState(scope) {
      requireScope(scope, 'getState');
      const [quizzes, submissions, teachers, students, tokenTransactions] = await Promise.all([
        loadQuizzesMap(scope),
        loadSubmissionList(scope),
        loadTeachersMap(scope),
        loadStudentsMap(scope),
        loadTokenTransactionList(scope)
      ]);
      return { quizzes, submissions, teachers, students, tokenTransactions };
    },
    async getStateValue(stateKey, scope) {
      requireScope(scope, `getStateValue(${stateKey})`);
      if (stateKey === 'quizzes') return loadQuizzesMap(scope);
      if (stateKey === 'submissions') return loadSubmissionList(scope);
      if (stateKey === 'teachers') return loadTeachersMap(scope);
      if (stateKey === 'students') return loadStudentsMap(scope);
      if (stateKey === 'tokenTransactions') return loadTokenTransactionList(scope);
      throw new Error(`Unsupported state key: ${stateKey}`);
    },
    async putStateValue(stateKey, incomingValue) {
      // Writes previously fetched the full admin-state (entire table) before
      // merging and persisting. That causes heavy DB IO for large tables when
      // many writes occur. For fairly-scoped state keys like `quizzes` and
      // `teachers` we can fetch only the existing rows for the incoming keys
      // and merge those, avoiding a full-table read. For other keys we keep
      // the existing behaviour to preserve merge semantics.
      if (stateKey === 'quizzes' || stateKey === 'teachers') {
        const ids = Object.keys(incomingValue || {});
        let currentSubset = {};
        if (ids.length > 0) {
          const table = stateKey === 'quizzes' ? tables.quizzes : tables.teachers;
          const idColumn = stateKey === 'quizzes' ? 'quiz_id' : 'teacher_id';
          const columns = stateKey === 'quizzes' ? SUPABASE_SELECT_COLUMNS.quizzes : SUPABASE_SELECT_COLUMNS.teachers;
          const { data, error } = await supabase.from(table).select(columns).in(idColumn, ids);
          if (error) {
            const wrapped = new Error(`Supabase select failed for ${table}: ${error.message}`);
            wrapped.supabaseCode = error.code || '';
            wrapped.cause = error;
            throw wrapped;
          }
          if (data && data.length) {
            currentSubset = stateKey === 'quizzes' ? rowsToQuizMap(data) : rowsToTeacherMap(data);
          }
        }
        const nextValue = mergeStateValue(stateKey, currentSubset, incomingValue || {});
        await persistStateValue(stateKey, nextValue);
        return nextValue;
      }
      // Fallback: preserve original behaviour for complex state keys.
      const currentValue = await this.getStateValue(stateKey, buildAdminScope());
      const nextValue = mergeStateValue(stateKey, currentValue, incomingValue);
      await persistStateValue(stateKey, nextValue);
      return nextValue;
    }
  };
}

function createStateStore(options) {
  const requestedBackend = (options.storageBackend || 'file').trim().toLowerCase();
  const hasSupabaseCredentials = !!((options.supabaseUrl || '').trim() && (options.supabaseServiceRoleKey || '').trim());

  if (!['file', 'supabase', 'auto'].includes(requestedBackend)) {
    throw new Error(`Unsupported STORAGE_BACKEND value "${options.storageBackend}". Use file, supabase, or auto.`);
  }

  if (requestedBackend === 'supabase') return createSupabaseStateStore(options);
  if (requestedBackend === 'auto' && hasSupabaseCredentials) return createSupabaseStateStore(options);
  return createFileStateStore(options);
}

module.exports = {
  ADMIN_TEMPLATE_OWNER,
  LEGACY_ADMIN_TEMPLATE_CUTOFF_ISO,
  LEGACY_ADMIN_TEMPLATE_SOURCE_TEACHER,
  DEFAULT_STATE,
  VALID_STATE_KEYS,
  buildLegacyAdminTemplateTargetId,
  createStateStore,
  buildQuizRow,
  buildAdminScope,
  buildTeacherScope,
  isLegacyAdminTemplateSourceQuiz
};
