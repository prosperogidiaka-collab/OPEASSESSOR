const puppeteer = require('puppeteer-core');

const EDGE_PATH = process.env.BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE_URL = (process.argv[2] || process.env.E2E_BASE_URL || 'http://127.0.0.1:3020').replace(/\/+$/, '');
const SYNC_API_BASE_URL = (process.argv[3] || process.env.E2E_SYNC_API_BASE_URL || '').trim().replace(/\/+$/, '');
const RUN_ID = Date.now().toString(36);
const TEACHER_ID = `teacher.${RUN_ID}@example.com`;
const TEACHER_PASSWORD = `SyncPass!${RUN_ID}`;
const QUIZ_ID = `E2E${RUN_ID.slice(-6).toUpperCase()}`;
const QUIZ_TITLE = `E2E Sync Quiz ${RUN_ID}`;

function withQuery(label) {
  const target = new URL(`${BASE_URL}/`);
  target.searchParams.set('e2e', RUN_ID);
  target.searchParams.set('ctx', label);
  if (SYNC_API_BASE_URL) target.searchParams.set('syncApiBaseUrl', SYNC_API_BASE_URL);
  return target.toString();
}

async function createPage(context, label) {
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  await page.goto(withQuery(label), { waitUntil: 'networkidle2' });
  await page.waitForSelector('#app');
  return page;
}

async function goToTeacherLogin(page) {
  await page.waitForSelector('#topTeacher');
  await page.click('#topTeacher');
  await page.waitForSelector('#teacherLoginId');
}

async function fillInput(page, selector, value) {
  await page.waitForSelector(selector);
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  if (value) await page.type(selector, value);
}

async function createTeacherViaUi(page) {
  await goToTeacherLogin(page);
  await fillInput(page, '#teacherLoginId', TEACHER_ID);
  await fillInput(page, '#teacherLoginPassword', TEACHER_PASSWORD);
  await page.click('#btnTeacherCreate');
  await page.waitForSelector('#quickCreate');
}

async function grantTeacherTokens(page) {
  return page.evaluate(async (teacherId) => {
    const teachers = getAllTeachers();
    const now = new Date().toISOString();
    teachers[teacherId] = {
      ...(teachers[teacherId] || {}),
      teacherId,
      email: teacherId,
      tokenBalance: 5,
      tokenUpdatedAt: now,
      licenseUpdatedAt: now,
      updatedAt: now
    };
    saveAllTeachers(teachers);
    const synced = await syncSharedKeys([STORAGE_KEYS.teachers]);
    return {
      synced,
      teacher: getAllTeachers()[teacherId],
      status: getTeacherLicenseStatus(getAllTeachers()[teacherId])
    };
  }, TEACHER_ID);
}

async function createQuizFromTeacherContext(page) {
  return page.evaluate(async ({ teacherId, quizId, quizTitle }) => {
    const now = new Date().toISOString();
    const question = {
      question: '2 + 2 = ?',
      options: ['3', '4', '5', '6'],
      answer: 'B',
      mark: 1,
      topic: 'Arithmetic'
    };
    const quiz = {
      id: quizId,
      examName: quizTitle,
      title: quizTitle,
      password: '',
      timeLimit: 5,
      maxGrade: 1,
      attemptLimit: 1,
      passMark: 50,
      negativeMarkEnabled: false,
      negativeMarkValue: 0,
      showInstantResult: true,
      showTopicsAfterSubmission: true,
      subjects: [{
        name: 'Mathematics',
        questionCount: 1,
        totalMarks: 1,
        questions: [question],
        bankQuestions: [question]
      }],
      questionPickCount: 0,
      createdAt: now,
      editedAt: '',
      updatedAt: now,
      teacherId,
      shuffleQs: false,
      shuffleOpts: false,
      verticalLayout: false,
      rankingEnabled: false,
      whitelist: [],
      audienceMode: 'public',
      assignedClassName: '',
      calculatorType: 'none',
      webcamRequired: false,
      certificateSignatories: [],
      scheduleStart: '',
      scheduleEnd: ''
    };
    const quizzes = getAllQuizzes({ includeDeleted: true });
    quizzes[quizId] = quiz;
    saveAllQuizzes(quizzes);
    const synced = await syncSharedKeys([STORAGE_KEYS.quizzes]);
    if (synced) markQuizzesCloudSynced([quizId]);
    return {
      synced,
      quiz: getAllQuizzes()[quizId],
      quizCount: Object.values(getAllQuizzes()).filter((item) => normalizeEmail(item.teacherId) === teacherId).length
    };
  }, {
    teacherId: TEACHER_ID,
    quizId: QUIZ_ID,
    quizTitle: QUIZ_TITLE
  });
}

async function loginTeacherOnFreshDevice(page) {
  await goToTeacherLogin(page);
  await fillInput(page, '#teacherLoginId', TEACHER_ID);
  await fillInput(page, '#teacherLoginPassword', TEACHER_PASSWORD);
  await page.click('#btnTeacherLogin');
  await page.waitForSelector('#quickCreate');
  return readTeacherState(page);
}

async function readTeacherState(page) {
  return page.evaluate(({ teacherId, quizId }) => {
    const teacher = getCurrentTeacher();
    const status = getTeacherLicenseStatus(teacher);
    const quizCount = Object.values(getAllQuizzes()).filter((item) => normalizeEmail(item.teacherId) === teacherId).length;
    const quiz = getAllQuizzes()[quizId] || null;
    return {
      teacherId: teacher?.teacherId || '',
      tokenBalance: teacher?.tokenBalance ?? null,
      licenseLabel: status.label,
      canSaveQuiz: !!status.canSaveQuiz,
      quizCount,
      hasQuiz: !!quiz,
      quizTitle: quiz?.title || ''
    };
  }, {
    teacherId: TEACHER_ID,
    quizId: QUIZ_ID
  });
}

async function verifyStudentCanOpenQuiz(page) {
  await page.waitForSelector('#topStudent');
  await page.click('#topStudent');
  await page.waitForSelector('#stuName');
  await fillInput(page, '#stuName', 'Sync Student');
  await fillInput(page, '#stuIdentity', `student.${RUN_ID}@example.com`);
  await fillInput(page, '#stuAccess', QUIZ_ID);
  await page.click('#startExamBtn');
  await page.waitForSelector('#beginQuizBtn');
  return page.evaluate(() => {
    const heading = document.querySelector('.quiz-welcome-card h1');
    const questionCountText = document.querySelector('.quiz-welcome-grid strong')?.textContent?.trim() || '';
    return {
      title: heading ? heading.textContent.trim() : '',
      questionCountText
    };
  });
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH,
    headless: 'new',
    args: [
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });

  const teacherContext = await browser.createBrowserContext();
  const secondTeacherContext = await browser.createBrowserContext();
  const studentContext = await browser.createBrowserContext();

  try {
    const teacherPage = await createPage(teacherContext, 'teacher-a');
    await createTeacherViaUi(teacherPage);
    const grantResult = await grantTeacherTokens(teacherPage);
    const quizResult = await createQuizFromTeacherContext(teacherPage);

    const secondTeacherPage = await createPage(secondTeacherContext, 'teacher-b');
    const secondTeacherResult = await loginTeacherOnFreshDevice(secondTeacherPage);
    await secondTeacherPage.reload({ waitUntil: 'networkidle2' });
    await secondTeacherPage.waitForSelector('#quickCreate');
    const secondTeacherReloadResult = await readTeacherState(secondTeacherPage);

    const studentPage = await createPage(studentContext, 'student');
    const studentResult = await verifyStudentCanOpenQuiz(studentPage);

    const failures = [];
    if (!grantResult.synced) failures.push('Teacher license update did not sync to the shared store.');
    if (!quizResult.synced) failures.push('Quiz save did not sync to the shared store.');
    if (secondTeacherResult.teacherId !== TEACHER_ID) failures.push('Fresh device could not log in with the synced teacher account.');
    if (Number(secondTeacherResult.tokenBalance || 0) < 5) failures.push('Fresh device did not receive the teacher license/token update.');
    if (!secondTeacherResult.hasQuiz || secondTeacherResult.quizTitle !== QUIZ_TITLE) failures.push('Fresh device did not receive the synced quiz.');
    if (secondTeacherReloadResult.teacherId !== TEACHER_ID || !secondTeacherReloadResult.hasQuiz) failures.push('Reloading the fresh teacher device lost the synced teacher session or quiz list.');
    if (studentResult.title !== QUIZ_TITLE) failures.push('Student device could not open the synced quiz.');

    const summary = {
      ok: failures.length === 0,
      runId: RUN_ID,
      baseUrl: BASE_URL,
      syncApiBaseUrl: SYNC_API_BASE_URL || null,
      teacherId: TEACHER_ID,
      quizId: QUIZ_ID,
      grantResult,
      quizResult,
      secondTeacherResult,
      secondTeacherReloadResult,
      studentResult,
      failures
    };

    console.log(JSON.stringify(summary, null, 2));
    if (failures.length) process.exitCode = 1;
  } finally {
    await teacherContext.close().catch(() => {});
    await secondTeacherContext.close().catch(() => {});
    await studentContext.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
