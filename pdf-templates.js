function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlAttr(value = '') {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function formatDateTime(value = '') {
  if (!value) return 'N/A';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(String(value));
  try {
    return date.toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  } catch (error) {
    return date.toISOString();
  }
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

function normalizeSubjectName(value = '') {
  return (value || '').toString().trim().toLowerCase();
}

function getSubmissionIpAddress(submission = {}) {
  return (
    (submission && submission.monitoring && submission.monitoring.ipAddress)
    || submission.ipAddress
    || ''
  ).toString().trim();
}

function getQuestionSubjectLabel(question = {}) {
  return (question._subject || question.subject || 'General').toString().trim() || 'General';
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
  let text = (value || '').toString();
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

function normalizeRichText(value) {
  return (value == null ? '' : String(value)).replace(/\r\n?/g, '\n');
}

function hasRichTextMarkup(value = '') {
  return /<(\/?)(b|strong|i|em|u|sub|sup|ul|ol|li|p|div|span|font|br)\b/i.test((value || '').toString());
}

function sanitizeBasicHtml(html = '') {
  return (html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed|link|meta|form|input|textarea|select|button)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style|iframe|object|embed|link|meta|form|input|textarea|select|button)\b[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*(['"])[\s\S]*?\1/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/\sstyle\s*=\s*(['"])[\s\S]*?\1/gi, '')
    .replace(/\sclass\s*=\s*(['"])[\s\S]*?\1/gi, '')
    .replace(/\sid\s*=\s*(['"])[\s\S]*?\1/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/<(?!\/?(?:b|strong|i|em|u|sub|sup|ul|ol|li|p|div|span|br)\b)[^>]+>/gi, '')
    .replace(/<(font)\b[^>]*>/gi, '<span>')
    .replace(/<\/font>/gi, '</span>')
    .replace(/(?:<br\s*\/?>\s*){3,}/gi, '<br><br>')
    .trim();
}

function renderRichTextHtml(value = '') {
  const raw = normalizeRichText(value);
  if (!raw) return '';
  if (!hasRichTextMarkup(raw)) {
    return escapeHtml(sanitizeScientificText(raw)).replace(/\n/g, '<br>');
  }
  return sanitizeBasicHtml(raw);
}

function stripHtmlToText(value = '') {
  return normalizeRichText(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function optionText(question, letter) {
  const idx = (letter || '').toString().toUpperCase().charCodeAt(0) - 65;
  return (question.options || [])[idx] || letter || '';
}

function getDisplayOptionText(question, letter) {
  return sanitizeScientificText(optionText(question, letter));
}

function getSanitizedQuestionOptions(question = {}) {
  return (question.options || []).map((option) => sanitizeScientificText(option || ''));
}

function normalizeQuestionImagePlacement(value = '') {
  return (value || '').toString().trim().toLowerCase() === 'after' ? 'after' : 'before';
}

function parseQuestionNumberList(value = '', maxCount = 0) {
  const numbers = (value || '').toString().split(',')
    .map((item) => parseInt(item.trim(), 10))
    .filter((item) => Number.isFinite(item) && item > 0);
  const unique = [...new Set(numbers)];
  return maxCount > 0 ? unique.filter((item) => item <= maxCount) : unique;
}

function sanitizeQuestionMediaAssets(assets = []) {
  return (Array.isArray(assets) ? assets : []).map((asset, index) => ({
    id: asset && asset.id ? asset.id : `asset_${index + 1}`,
    src: (asset && asset.src ? asset.src : '').toString().trim(),
    placement: normalizeQuestionImagePlacement(asset && asset.placement),
    fileName: (asset && asset.fileName ? asset.fileName : '').toString().trim(),
    altText: (asset && asset.altText ? asset.altText : 'Question image').toString().trim()
  })).filter((asset) => !!asset.src);
}

function normalizeSubjectQuestionImages(groups = []) {
  return (Array.isArray(groups) ? groups : []).map((group, index) => ({
    id: group && group.id ? group.id : `group_${index + 1}`,
    src: (group && group.src ? group.src : '').toString().trim(),
    placement: normalizeQuestionImagePlacement(group && group.placement),
    fileName: (group && group.fileName ? group.fileName : '').toString().trim(),
    altText: (group && group.altText ? group.altText : 'Question image').toString().trim(),
    questionNumbers: parseQuestionNumberList(group && (group.questionNumbersText || group.questionNumbers || ''))
  })).filter((group) => !!group.src && group.questionNumbers.length);
}

function stripQuestionMediaAssets(questions = []) {
  return (Array.isArray(questions) ? questions : []).map((question) => ({
    ...question,
    mediaAssets: []
  }));
}

function applySubjectQuestionImagesToQuestions(questions = [], questionImages = []) {
  const nextQuestions = (Array.isArray(questions) ? questions : []).map((question) => ({
    ...question,
    mediaAssets: sanitizeQuestionMediaAssets(question && question.mediaAssets)
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

function buildQuestionsWithSubjectImages(sourceQuestions = [], subjectName = 'General', questionImages = [], options = {}) {
  const normalizedSubjectName = (subjectName || 'General').toString().trim() || 'General';
  const normalizedQuestions = (Array.isArray(sourceQuestions) ? sourceQuestions : []).map((question, index) => ({
    ...question,
    subject: normalizedSubjectName,
    _subject: question && question._subject ? question._subject : normalizedSubjectName,
    _sourceId: question && question._sourceId ? question._sourceId : makeQuestionId(question || {}, index),
    mediaAssets: sanitizeQuestionMediaAssets(question && question.mediaAssets)
  }));
  const normalizedImages = normalizeSubjectQuestionImages(questionImages);
  const baseQuestions = options && options.replaceExistingMedia ? stripQuestionMediaAssets(normalizedQuestions) : normalizedQuestions;
  if (!normalizedImages.length) return baseQuestions;
  return applySubjectQuestionImagesToQuestions(baseQuestions, normalizedImages);
}

function getQuestionMediaAssets(question = {}, placement = 'before') {
  const normalizedPlacement = normalizeQuestionImagePlacement(placement);
  return sanitizeQuestionMediaAssets(question && question.mediaAssets).filter((asset) => asset.placement === normalizedPlacement);
}

function renderQuestionMediaAssets(question = {}, placement = 'before') {
  const assets = getQuestionMediaAssets(question, placement);
  if (!assets.length) return '';
  return `
    <div class="media-stack">
      ${assets.map((asset) => `
        <figure class="media-card">
          <img src="${escapeHtmlAttr(asset.src)}" alt="${escapeHtmlAttr(asset.altText || 'Question image')}" />
          ${asset.fileName ? `<figcaption class="meta-text muted">${escapeHtml(asset.fileName)}</figcaption>` : ''}
        </figure>
      `).join('')}
    </div>
  `;
}

function makeQuestionId(question = {}, index = 0) {
  const raw = [
    question._sourceId || question.id || '',
    question.subject || question._subject || '',
    question.question || '',
    (question.options || []).join('|'),
    question.answer || '',
    index
  ].join('::');
  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  return `q_${Math.abs(hash).toString(36)}`;
}

function getQuestionCountForSubject(subject = {}) {
  const configuredCount = Number(subject.questionCount);
  if (Number.isFinite(configuredCount) && configuredCount > 0) return configuredCount;
  const bankCount = Array.isArray(subject.bankQuestions) ? subject.bankQuestions.length : 0;
  const questionCount = Array.isArray(subject.questions) ? subject.questions.length : 0;
  return Math.max(bankCount, questionCount, 0);
}

function getSubjectTotalMarks(subject = {}) {
  const configured = Number(subject.totalMarks ?? subject.maxScore ?? subject.maxGrade ?? 0);
  if (Number.isFinite(configured) && configured > 0) return Math.round(configured * 100) / 100;
  return getQuestionCountForSubject(subject);
}

function getQuizTotalMarks(quiz = {}, fallbackQuestions = []) {
  const subjectTotal = Array.isArray(quiz.subjects)
    ? quiz.subjects.reduce((sum, subject) => sum + getSubjectTotalMarks(subject), 0)
    : 0;
  if (subjectTotal > 0) return Math.round(subjectTotal * 100) / 100;
  const configured = Number(quiz.maxGrade);
  if (Number.isFinite(configured) && configured > 0) return Math.round(configured * 100) / 100;
  return Array.isArray(fallbackQuestions) ? fallbackQuestions.length : 0;
}

function getQuizSubjectMetaMap(quiz = {}) {
  const map = new Map();
  (quiz.subjects || []).forEach((subject, index) => {
    const name = (subject && subject.name ? subject.name : `Subject ${index + 1}`).toString().trim() || `Subject ${index + 1}`;
    map.set(normalizeSubjectName(name), {
      name,
      totalMarks: getSubjectTotalMarks(subject),
      questionCount: getQuestionCountForSubject(subject)
    });
  });
  return map;
}

function buildQuestionSubjectSections(questions = []) {
  const subjectMap = new Map();
  (Array.isArray(questions) ? questions : []).forEach((question, globalIndex) => {
    const subjectName = (question && (question._subject || question.subject) ? (question._subject || question.subject) : 'General').toString().trim() || 'General';
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

function computeSubmissionSubjectBreakdown(quiz, submission) {
  const sections = buildQuestionSubjectSections((submission && submission.allQuestions) || []);
  const answers = (submission && submission.answers) || {};
  const negativeEnabled = !!(quiz && quiz.negativeMarkEnabled);
  const negativeValue = parseFloat((quiz && quiz.negativeMarkValue) || 0) || 0;
  const subjectMetaMap = getQuizSubjectMetaMap(quiz || {});
  return sections.map((section) => {
    let attempted = 0;
    let correct = 0;
    let wrong = 0;
    section.indices.forEach((globalIndex) => {
      const question = submission.allQuestions[globalIndex];
      const chosen = (answers[globalIndex] || '').toString().toUpperCase();
      if (!chosen) return;
      attempted += 1;
      const expected = (question && question.answer ? question.answer : '').toString().toUpperCase();
      if (chosen === expected) correct += 1;
      else wrong += 1;
    });
    const meta = subjectMetaMap.get(normalizeSubjectName(section.name)) || {};
    const totalMarks = getSubjectTotalMarks({ totalMarks: meta.totalMarks, questionCount: section.total });
    const markPerQuestion = section.total > 0 ? totalMarks / section.total : 0;
    const rawUnits = correct - (negativeEnabled ? wrong * negativeValue : 0);
    const rawScore = rawUnits * markPerQuestion;
    const score = Math.max(0, Math.round(rawScore * 100) / 100);
    const negativePenalty = negativeEnabled ? Math.round((wrong * negativeValue * markPerQuestion) * 100) / 100 : 0;
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
      negativePenalty
    };
  });
}

function getSubmissionTotalMarks(submission, quiz) {
  if (Number.isFinite(Number(submission && submission.totalMarks)) && Number(submission.totalMarks) > 0) {
    return Math.round(Number(submission.totalMarks) * 100) / 100;
  }
  const breakdown = Array.isArray(submission && submission.subjectBreakdown) && submission.subjectBreakdown.length
    ? submission.subjectBreakdown
    : computeSubmissionSubjectBreakdown(quiz, submission || {});
  const total = breakdown.reduce((sum, item) => sum + (item.totalMarks || 0), 0);
  return total > 0 ? Math.round(total * 100) / 100 : getQuizTotalMarks(quiz, submission && submission.allQuestions);
}

function computeSubmissionCounts(submission = {}, quiz = {}) {
  const answers = submission.answers || {};
  const allQuestions = submission.allQuestions || [];
  let attempted = 0;
  let correct = 0;
  let wrong = 0;
  allQuestions.forEach((question, index) => {
    const chosen = (answers[index] || '').toString().toUpperCase();
    if (!chosen) return;
    attempted += 1;
    const expected = (question.answer || '').toString().toUpperCase();
    if (chosen === expected) correct += 1;
    else wrong += 1;
  });
  const totalMarks = getSubmissionTotalMarks(submission, quiz);
  const score = Number.isFinite(Number(submission.score))
    ? Number(submission.score)
    : correct;
  const percent = Number.isFinite(Number(submission.percent))
    ? clampPercent(submission.percent)
    : (totalMarks ? clampPercent((score / totalMarks) * 100) : 0);
  return {
    attempted,
    correct,
    wrong,
    score,
    totalMarks,
    percent
  };
}

function buildCorrectionQuestionEntries(submission, options = {}) {
  const requestedSubject = normalizeSubjectName(options.subjectName || '');
  const entries = ((submission && submission.allQuestions) || []).map((question, index) => ({
    question,
    originalIndex: index,
    subject: getQuestionSubjectLabel(question)
  }));
  if (!requestedSubject) return { entries, subjectName: '', matchedRequestedSubject: true };
  const filtered = entries.filter((entry) => normalizeSubjectName(entry.subject) === requestedSubject);
  return {
    entries: filtered.length ? filtered : entries,
    subjectName: filtered.length ? filtered[0].subject : '',
    matchedRequestedSubject: filtered.length > 0
  };
}

function isLongCard(...values) {
  const totalLength = values.reduce((sum, item) => sum + stripHtmlToText(item).length, 0);
  return totalLength > 900;
}

function buildOptionListHtml(question = {}, options = {}) {
  const selectedAnswer = (options.selectedAnswer || '').toString().trim().toUpperCase();
  const correctAnswer = (options.correctAnswer || question.answer || '').toString().trim().toUpperCase();
  const rows = getSanitizedQuestionOptions(question).map((option, index) => {
    const letter = String.fromCharCode(65 + index);
    const classes = [
      'option-row',
      letter === correctAnswer ? 'is-correct' : '',
      selectedAnswer && letter === selectedAnswer ? 'is-selected' : ''
    ].filter(Boolean).join(' ');
    return `
      <div class="${classes}">
        <div class="option-letter">${letter}.</div>
        <div class="option-text rich-text-output">${renderRichTextHtml(option)}</div>
      </div>
    `;
  }).join('');
  return `
    <div class="options">
      ${rows || '<div class="option-row"><div class="option-text">No options provided.</div></div>'}
    </div>
  `;
}

function getResultStatus(submission = {}, quiz = {}) {
  const raw = (submission.resultStatus || '').toString().trim().toLowerCase();
  if (raw === 'pass') return 'Pass';
  if (raw === 'fail') return 'Fail';
  return clampPercent(submission.percent || 0) >= clampPercent(quiz.passMark || 50) ? 'Pass' : 'Fail';
}

function computeFacilityIndexFromQuizAndSubmissions(quiz = {}, submissions = []) {
  if (!quiz || typeof quiz !== 'object' || !quiz.id) return [];
  const quizQuestions = [];
  for (const subject of (quiz.subjects || [])) {
    const source = Array.isArray(subject.bankQuestions) && subject.bankQuestions.length ? subject.bankQuestions : subject.questions;
    const normalizedSource = buildQuestionsWithSubjectImages(source || [], subject.name || 'General', subject.questionImages || [], {
      replaceExistingMedia: Array.isArray(subject.questionImages)
    });
    for (let i = 0; i < normalizedSource.length; i += 1) {
      const question = normalizedSource[i];
      quizQuestions.push({
        _sourceId: question._sourceId,
        question: question.question || '',
        subject: subject.name || question.subject || 'General',
        topic: question.topic || '',
        explanation: question.explanation || '',
        learningPoint: question.learningPoint || '',
        keyConcept: question.keyConcept || question.topic || '',
        mediaAssets: sanitizeQuestionMediaAssets(question.mediaAssets || []),
        options: question.options || [],
        answer: question.answer || null,
        difficulty: question.difficulty || 'Medium'
      });
    }
  }

  const results = quizQuestions.map((sourceQuestion, index) => {
    const optionCounts = (sourceQuestion.options || []).map((option, optionIndex) => ({
      letter: String.fromCharCode(65 + optionIndex),
      option,
      count: 0
    }));
    let seen = 0;
    let attempted = 0;
    let correct = 0;
    let unanswered = 0;

    (submissions || []).forEach((submission) => {
      const allQuestions = submission.allQuestions || [];
      const answerMap = submission.answers || {};
      allQuestions.forEach((studentQuestion, studentIndex) => {
        const sourceId = studentQuestion._sourceId || makeQuestionId(studentQuestion, studentIndex);
        if (sourceId !== sourceQuestion._sourceId) return;
        seen += 1;
        const answer = answerMap[studentIndex];
        if (typeof answer === 'undefined' || answer === null || answer === '') {
          unanswered += 1;
          return;
        }
        attempted += 1;
        if (answer === studentQuestion.answer) correct += 1;
        const chosenText = optionText(studentQuestion, answer);
        const originalOptionIndex = (sourceQuestion.options || []).findIndex((option) => option === chosenText);
        if (originalOptionIndex >= 0 && optionCounts[originalOptionIndex]) {
          optionCounts[originalOptionIndex].count += 1;
        }
      });
    });

    const facilityIndex = attempted > 0 ? correct / attempted : null;
    return {
      index: index + 1,
      sourceId: sourceQuestion._sourceId,
      subject: sourceQuestion.subject,
      topic: sourceQuestion.topic || '',
      explanation: sourceQuestion.explanation || '',
      learningPoint: sourceQuestion.learningPoint || '',
      keyConcept: sourceQuestion.keyConcept || sourceQuestion.topic || '',
      mediaAssets: sanitizeQuestionMediaAssets(sourceQuestion.mediaAssets || []),
      question: sourceQuestion.question,
      options: sourceQuestion.options,
      answer: sourceQuestion.answer,
      difficulty: sourceQuestion.difficulty,
      correct,
      seen,
      attempted,
      unanswered,
      notSeen: Math.max(0, submissions.length - seen),
      optionCounts,
      facilityIndex
    };
  });

  return results;
}

function getFacilityDifficultyBand(facilityIndex) {
  if (facilityIndex == null) return { label: 'No Attempts', shortLabel: 'No Attempts', min: 0, max: 0, color: '#F8FAFC', accent: '#CBD5E1', text: '#111827' };
  const percent = Math.round(facilityIndex * 100);
  if (percent >= 90) return { label: 'Very Easy', shortLabel: 'Very Easy', min: 90, max: 100, color: '#D1FAE5', accent: '#10B981', text: '#111827' };
  if (percent >= 75) return { label: 'Easy', shortLabel: 'Easy', min: 75, max: 89, color: '#E0F2FE', accent: '#0EA5E9', text: '#111827' };
  if (percent >= 50) return { label: 'Moderate', shortLabel: 'Moderate', min: 50, max: 74, color: '#FEF9C3', accent: '#EAB308', text: '#111827' };
  if (percent >= 30) return { label: 'Difficult', shortLabel: 'Difficult', min: 30, max: 49, color: '#FFE4E6', accent: '#F43F5E', text: '#111827' };
  return { label: 'Very Difficult', shortLabel: 'Very Difficult', min: 0, max: 29, color: '#FEE2E2', accent: '#EF4444', text: '#111827' };
}

function getFacilityAnalysisSummary(items = []) {
  const usable = items.filter((item) => item.facilityIndex != null);
  const average = usable.length ? Math.round((usable.reduce((sum, item) => sum + item.facilityIndex, 0) / usable.length) * 100) : 0;
  const counts = { veryEasy: 0, easy: 0, moderate: 0, difficult: 0, veryDifficult: 0 };
  usable.forEach((item) => {
    const label = getFacilityDifficultyBand(item.facilityIndex).label;
    if (label === 'Very Easy') counts.veryEasy += 1;
    else if (label === 'Easy') counts.easy += 1;
    else if (label === 'Moderate') counts.moderate += 1;
    else if (label === 'Difficult') counts.difficult += 1;
    else if (label === 'Very Difficult') counts.veryDifficult += 1;
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

function buildStatusBadge(status = '') {
  const safe = (status || '').toString().trim().toLowerCase();
  const className = safe === 'pass' ? 'status-pill status-pass' : safe === 'fail' ? 'status-pill status-fail' : 'status-pill status-neutral';
  return `<span class="${className}">${escapeHtml(status || 'Pending')}</span>`;
}

function buildMetaCard(label, value) {
  return `
    <div class="meta-card">
      <div class="meta-label">${escapeHtml(label)}</div>
      <div class="meta-value">${value}</div>
    </div>
  `;
}

function buildStatCard(label, value, accent = '') {
  return `
    <div class="stat-card${accent ? ` ${accent}` : ''}">
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value">${value}</div>
    </div>
  `;
}

function buildResultSummaryBody(payload = {}) {
  const quiz = payload.quiz || {};
  const submission = payload.submission || {};
  const counts = computeSubmissionCounts(submission, quiz);
  const breakdown = Array.isArray(submission.subjectBreakdown) && submission.subjectBreakdown.length
    ? submission.subjectBreakdown
    : computeSubmissionSubjectBreakdown(quiz, submission);
  const status = getResultStatus(submission, quiz);
  const reference = (submission.shareKey || '').toString().trim().toUpperCase() || 'N/A';

  return `
    <div class="page-shell">
      <section class="page-header">
        <div class="eyebrow">OPE Assessor PDF Route</div>
        <h1 class="page-title">Result Summary</h1>
        <div class="page-subtitle">${escapeHtml(sanitizeScientificText(quiz.examName || 'OPE Assessor'))} • ${escapeHtml(sanitizeScientificText(quiz.title || quiz.id || 'Quiz'))}</div>
      </section>

      <section class="section-card">
        <h2 class="section-title">Student Details</h2>
        <div class="meta-grid">
          ${buildMetaCard('Student', escapeHtml(sanitizeScientificText(submission.name || 'Student')))}
          ${buildMetaCard('Email / ID', escapeHtml(sanitizeScientificText(submission.email || submission.registrationNo || 'N/A')))}
          ${buildMetaCard('Submitted', escapeHtml(formatDateTime(submission.submittedAt)))}
          ${buildMetaCard('Reference', escapeHtml(reference))}
          ${buildMetaCard('Quiz', escapeHtml(sanitizeScientificText(quiz.title || submission.quizId || 'Quiz')))}
          ${buildMetaCard('Status', buildStatusBadge(status))}
        </div>
      </section>

      <section class="section-card">
        <h2 class="section-title">Performance Summary</h2>
        <div class="stat-grid">
          ${buildStatCard('Score', `${formatScoreValue(counts.score)} / ${formatScoreValue(counts.totalMarks)}`)}
          ${buildStatCard('Percent', `${counts.percent}%`)}
          ${buildStatCard('Correct', String(Number.isFinite(Number(submission.correctCount)) ? Number(submission.correctCount) : counts.correct))}
          ${buildStatCard('Attempted', String(Number.isFinite(Number(submission.attemptedCount)) ? Number(submission.attemptedCount) : counts.attempted))}
          ${buildStatCard('Wrong', String(Number.isFinite(Number(submission.wrongCount)) ? Number(submission.wrongCount) : counts.wrong))}
          ${buildStatCard('Rank', escapeHtml((payload.rankValue || '-').toString()))}
          ${buildStatCard('Pass Mark', `${clampPercent(quiz.passMark || 50)}%`)}
          ${buildStatCard('Negative Penalty', formatScoreValue(submission.negativePenalty || 0))}
        </div>
      </section>

      ${breakdown.length ? `
        <section class="section-card">
          <h2 class="section-title">Subject Breakdown</h2>
          <div class="meta-grid">
            ${breakdown.map((item) => buildMetaCard(
              sanitizeScientificText(item.name || 'General'),
              `
                <div>${formatScoreValue(item.score || 0)} / ${formatScoreValue(item.totalMarks || item.total || 0)}</div>
                <div class="meta-text muted">${clampPercent(item.percent || 0)}% • ${item.correct || 0} correct • ${item.attempted || 0} attempted</div>
              `
            )).join('')}
          </div>
        </section>
      ` : ''}

      <section class="section-card">
        <h2 class="section-title">Verification</h2>
        <div class="verification-grid">
          <div class="verification-copy">
            <p class="meta-text">This PDF was generated from the dedicated OPE Assessor PDF route and contains real selectable text.</p>
            <p class="meta-text"><strong>Reference:</strong> ${escapeHtml(reference)}</p>
            <p class="meta-text"><strong>Submitted:</strong> ${escapeHtml(formatDateTime(submission.submittedAt))}</p>
          </div>
          <div class="verification-qr">
            ${payload.verificationQrSvg || '<div class="qr-fallback">QR unavailable</div>'}
          </div>
        </div>
      </section>
    </div>
  `;
}

function buildStudentCorrectionBody(payload = {}) {
  const quiz = payload.quiz || {};
  const submission = payload.submission || {};
  const correctionView = buildCorrectionQuestionEntries(submission, { subjectName: payload.subjectName || '' });
  const entries = correctionView.entries.slice();
  const resolvedSubjectName = correctionView.subjectName || (payload.subjectName || '').toString().trim();
  const breakdown = Array.isArray(submission.subjectBreakdown) && submission.subjectBreakdown.length
    ? submission.subjectBreakdown
    : computeSubmissionSubjectBreakdown(quiz, submission);
  const subjectSummary = resolvedSubjectName
    ? (breakdown.find((item) => normalizeSubjectName(item.name) === normalizeSubjectName(resolvedSubjectName)) || null)
    : null;
  const overallCounts = computeSubmissionCounts(submission, quiz);
  const displayScore = subjectSummary ? subjectSummary.score : overallCounts.score;
  const displayTotalMarks = subjectSummary ? subjectSummary.totalMarks : overallCounts.totalMarks;
  const displayPercent = subjectSummary ? subjectSummary.percent : overallCounts.percent;
  const displayCorrect = subjectSummary ? subjectSummary.correct : overallCounts.correct;
  const displayAttempted = subjectSummary ? subjectSummary.attempted : overallCounts.attempted;
  const displayWrong = subjectSummary ? subjectSummary.wrong : overallCounts.wrong;
  const displaySubject = resolvedSubjectName || 'All Subjects';

  return `
    <div class="page-shell">
      <section class="page-header">
        <div class="eyebrow">OPE Assessor PDF Route</div>
        <h1 class="page-title">Student Correction</h1>
        <div class="page-subtitle">${escapeHtml(sanitizeScientificText(quiz.title || submission.quizId || 'Quiz'))} • ${escapeHtml(sanitizeScientificText(displaySubject))}</div>
      </section>

      <section class="section-card">
        <h2 class="section-title">Correction Summary</h2>
        <div class="meta-grid">
          ${buildMetaCard('Student', escapeHtml(sanitizeScientificText(submission.name || 'Student')))}
          ${buildMetaCard('Email / ID', escapeHtml(sanitizeScientificText(submission.email || submission.registrationNo || 'N/A')))}
          ${buildMetaCard('IP Address', escapeHtml(getSubmissionIpAddress(submission) || 'Not captured'))}
          ${buildMetaCard('Submitted', escapeHtml(formatDateTime(submission.submittedAt)))}
          ${buildMetaCard('Quiz', escapeHtml(sanitizeScientificText(quiz.title || submission.quizId || 'Quiz')))}
          ${buildMetaCard('Subject', escapeHtml(sanitizeScientificText(displaySubject)))}
        </div>
        <div class="stat-grid">
          ${buildStatCard('Score', `${formatScoreValue(displayScore)} / ${formatScoreValue(displayTotalMarks)}`)}
          ${buildStatCard('Percent', `${clampPercent(displayPercent)}%`)}
          ${buildStatCard('Correct', String(displayCorrect || 0))}
          ${buildStatCard('Attempted', String(displayAttempted || 0))}
          ${buildStatCard('Wrong', String(displayWrong || 0))}
          ${buildStatCard('Negative Penalty', formatScoreValue(payload.showNegativePenalty === false ? 0 : (submission.negativePenalty || 0)))}
        </div>
      </section>

      <section class="section-card">
        <h2 class="section-title">Question Corrections</h2>
        <div class="question-list">
          ${entries.map((entry) => {
            const question = entry.question || {};
            const chosen = submission.answers && submission.answers[entry.originalIndex] ? submission.answers[entry.originalIndex] : '';
            const correct = (question.answer || '').toString().toUpperCase();
            const isCorrect = !!chosen && chosen === correct;
            const statusText = isCorrect ? 'Correct' : 'Incorrect';
            const topic = question.topic || entry.subject || 'General';
            const keyConcept = question.keyConcept || question.topic || entry.subject || 'General';
            const explanation = question.explanation || 'No explanation provided yet.';
            const learningPoint = question.learningPoint || question.explanation || question.topic || 'Review the correct answer again.';
            const studentAnswerText = chosen ? `${chosen}. ${getDisplayOptionText(question, chosen)}` : 'No answer';
            const correctAnswerText = correct ? `${correct}. ${getDisplayOptionText(question, correct)}` : 'Not set';
            const longClass = isLongCard(question.question || '', explanation, learningPoint) ? ' long' : '';
            return `
              <article class="question-card${longClass}">
                <div class="question-head">
                  <div class="question-number">Question ${entry.originalIndex + 1}</div>
                  ${buildStatusBadge(statusText)}
                </div>
                ${renderQuestionMediaAssets(question, 'before')}
                <div class="question-text rich-text-output">${renderRichTextHtml(question.question || '')}</div>
                ${renderQuestionMediaAssets(question, 'after')}
                ${breakdown.length > 1 ? `<div class="meta-text"><strong>Subject:</strong> ${escapeHtml(sanitizeScientificText(entry.subject || 'General'))}</div>` : ''}
                <div class="meta-text"><strong>Status:</strong> ${escapeHtml(statusText)}</div>
                <div class="meta-text"><strong>Key Concept:</strong> <span class="rich-text-output">${renderRichTextHtml(keyConcept)}</span></div>
                <div class="meta-text"><strong>Options:</strong></div>
                ${buildOptionListHtml(question, { selectedAnswer: chosen, correctAnswer: correct })}
                <div class="meta-text"><strong>Student Answer:</strong> ${escapeHtml(studentAnswerText)}</div>
                <div class="meta-text"><strong>Correct Answer:</strong> ${escapeHtml(correctAnswerText)}</div>
                <div class="meta-text"><strong>Topic:</strong> <span class="rich-text-output">${renderRichTextHtml(topic)}</span></div>
                <div class="meta-text"><strong>Explanation:</strong> <span class="rich-text-output">${renderRichTextHtml(explanation)}</span></div>
                <div class="meta-text"><strong>Learning Point:</strong> <span class="rich-text-output">${renderRichTextHtml(learningPoint)}</span></div>
              </article>
            `;
          }).join('') || '<div class="meta-text">No questions recorded for this submission.</div>'}
        </div>
      </section>
    </div>
  `;
}

function buildFacilityIndexBody(payload = {}) {
  const quiz = payload.quiz || {};
  const subjectName = (payload.subjectName || '').toString().trim();
  const rawData = computeFacilityIndexFromQuizAndSubmissions(quiz, payload.submissions || []);
  const data = subjectName
    ? rawData.filter((item) => normalizeSubjectName(item.subject || 'General') === normalizeSubjectName(subjectName))
    : rawData;
  const summary = getFacilityAnalysisSummary(data);
  const sections = [
    'Very Difficult',
    'Difficult',
    'Moderate',
    'Easy',
    'Very Easy',
    'No Attempts'
  ].map((label) => ({
    label,
    items: data.filter((item) => getFacilityDifficultyBand(item.facilityIndex).label === label)
  })).filter((section) => section.items.length);

  return `
    <div class="page-shell">
      <section class="page-header">
        <div class="eyebrow">OPE Assessor PDF Route</div>
        <h1 class="page-title">Facility Index</h1>
        <div class="page-subtitle">${escapeHtml(sanitizeScientificText(quiz.title || quiz.id || 'Quiz'))} • ${escapeHtml(sanitizeScientificText(subjectName || 'All Subjects'))}</div>
      </section>

      <section class="section-card">
        <h2 class="section-title">Summary</h2>
        <div class="meta-grid">
          ${buildMetaCard('Quiz', escapeHtml(sanitizeScientificText(quiz.title || quiz.id || 'Quiz')))}
          ${buildMetaCard('Subject', escapeHtml(sanitizeScientificText(subjectName || 'All Subjects')))}
          ${buildMetaCard('Submissions Reviewed', escapeHtml(String((payload.submissions || []).length)))}
          ${buildMetaCard('Question Count', escapeHtml(String(summary.totalQuestions || 0)))}
        </div>
        <div class="stat-grid">
          ${buildStatCard('Average Facility', `${summary.average}%`)}
          ${buildStatCard('Easy', `${summary.percentages.easy}%`)}
          ${buildStatCard('Moderate', `${summary.percentages.moderate}%`)}
          ${buildStatCard('Difficult', `${summary.percentages.difficult}%`)}
        </div>
      </section>

      ${sections.map((section) => {
        const bandMeta = getFacilityDifficultyBand(section.items[0].facilityIndex);
        return `
          <section class="section-card">
            <h2 class="section-title">${escapeHtml(section.label)}${section.label === 'No Attempts' ? '' : ` (${bandMeta.min}-${bandMeta.max}%)`}</h2>
            <div class="question-list">
              ${section.items.map((item) => {
                const percentText = item.facilityIndex == null ? 'No attempts' : `${Math.round(item.facilityIndex * 100)}%`;
                const correctAnswerText = item.answer ? `${item.answer}. ${getDisplayOptionText(item, item.answer)}` : 'Not set';
                const optionCounts = (item.optionCounts || []).map((option) => `${option.letter}: ${option.count}`).join(' | ');
                const longClass = isLongCard(item.question || '', item.explanation || '', item.learningPoint || '') ? ' long' : '';
                return `
                  <article class="question-card${longClass}">
                    <div class="question-head">
                      <div class="question-number">Question ${item.index} • ${escapeHtml(percentText)}</div>
                      <span class="band-pill" style="background:${bandMeta.color};border-color:${bandMeta.accent};color:${bandMeta.text}">${escapeHtml(section.label)}</span>
                    </div>
                    ${renderQuestionMediaAssets(item, 'before')}
                    <div class="question-text rich-text-output">${renderRichTextHtml(item.question || '')}</div>
                    ${renderQuestionMediaAssets(item, 'after')}
                    <div class="meta-text"><strong>Options:</strong></div>
                    ${buildOptionListHtml(item, { correctAnswer: item.answer || '' })}
                    <div class="meta-text"><strong>Correct Answer:</strong> ${escapeHtml(correctAnswerText)}</div>
                    <div class="meta-text"><strong>Seen:</strong> ${item.seen} • <strong>Attempted:</strong> ${item.attempted} • <strong>Correct:</strong> ${item.correct} • <strong>Wrong:</strong> ${Math.max(0, item.attempted - item.correct)}</div>
                    <div class="meta-text"><strong>Topic:</strong> <span class="rich-text-output">${renderRichTextHtml(item.topic || 'Not set')}</span></div>
                    <div class="meta-text"><strong>Option Counts:</strong> ${escapeHtml(optionCounts || 'No option counts yet.')}</div>
                    <div class="meta-text"><strong>Explanation:</strong> <span class="rich-text-output">${renderRichTextHtml(item.explanation || 'No explanation provided yet.')}</span></div>
                    <div class="meta-text"><strong>Learning Point:</strong> <span class="rich-text-output">${renderRichTextHtml(item.learningPoint || item.keyConcept || 'Review this question again.')}</span></div>
                  </article>
                `;
              }).join('')}
            </div>
          </section>
        `;
      }).join('') || `
        <section class="section-card">
          <h2 class="section-title">Facility Index</h2>
          <div class="meta-text">No facility index data was available for this route.</div>
        </section>
      `}
    </div>
  `;
}

function buildGlobalStyles() {
  return `
    @page {
      size: A4 portrait;
      margin: 10mm;
    }

    html, body {
      width: 210mm;
      min-height: 297mm;
      margin: 0;
      padding: 0;
      background: white;
      font-family: Arial, "Noto Sans", "DejaVu Sans", sans-serif;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    body {
      font-size: 15px;
      line-height: 1.55;
      color: #111827;
    }

    #pdf-root {
      width: 190mm;
      margin: 0 auto;
      padding: 0;
      background: white;
      color: #111827;
      overflow: visible;
    }

    * {
      box-sizing: border-box;
    }

    img, svg {
      max-width: 100%;
    }

    .page-shell {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 0;
    }

    .page-header {
      border: 1px solid #d1d5db;
      border-radius: 12px;
      padding: 16px;
      background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .eyebrow {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #2563eb;
      margin-bottom: 8px;
    }

    .page-title {
      margin: 0;
      font-size: 24px;
      line-height: 1.25;
      color: #111827;
    }

    .page-subtitle {
      margin-top: 8px;
      font-size: 15px;
      line-height: 1.55;
      color: #374151;
    }

    .section-card {
      width: 100%;
      padding: 14px;
      margin: 0;
      border: 1px solid #d1d5db;
      border-radius: 10px;
      background: #ffffff;
      break-inside: avoid;
      page-break-inside: avoid;
      overflow: visible;
    }

    .section-title {
      margin: 0 0 10px;
      font-size: 18px;
      line-height: 1.35;
      font-weight: 700;
      color: #111827;
    }

    .meta-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .meta-card {
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      background: #f9fafb;
      padding: 12px;
      break-inside: avoid;
      page-break-inside: avoid;
      overflow: visible;
    }

    .meta-label {
      font-size: 14px;
      line-height: 1.45;
      font-weight: 700;
      color: #4b5563;
      margin-bottom: 4px;
    }

    .meta-value {
      font-size: 15px;
      line-height: 1.55;
      color: #111827;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .stat-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-top: 10px;
    }

    .stat-card {
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      background: #ffffff;
      padding: 12px;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .stat-label {
      font-size: 14px;
      line-height: 1.45;
      font-weight: 700;
      color: #4b5563;
      margin-bottom: 4px;
    }

    .stat-value {
      font-size: 18px;
      line-height: 1.35;
      font-weight: 700;
      color: #111827;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .question-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .question-card {
      width: 100%;
      padding: 14px;
      margin-bottom: 12px;
      border: 1px solid #d1d5db;
      border-radius: 10px;
      background: #ffffff;
      break-inside: avoid;
      page-break-inside: avoid;
      overflow: visible;
    }

    .question-card.long {
      break-inside: auto;
      page-break-inside: auto;
    }

    .question-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      flex-wrap: wrap;
      margin-bottom: 8px;
    }

    .question-number {
      font-size: 15px;
      line-height: 1.45;
      font-weight: 700;
      color: #111827;
    }

    .question-text {
      font-size: 16px;
      line-height: 1.6;
      color: #111827;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .meta-text {
      font-size: 14px;
      line-height: 1.55;
      color: #111827;
      margin-top: 8px;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .options {
      font-size: 15px;
      line-height: 1.6;
      margin-top: 8px;
    }

    .option-row {
      display: grid;
      grid-template-columns: 24px 1fr;
      gap: 8px;
      align-items: flex-start;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      background: #ffffff;
      padding: 8px 10px;
      margin-top: 6px;
    }

    .option-row.is-correct {
      border-color: #93c5fd;
      background: #eff6ff;
    }

    .option-row.is-selected {
      box-shadow: inset 0 0 0 1px rgba(37, 99, 235, 0.28);
    }

    .option-letter {
      font-size: 15px;
      line-height: 1.6;
      font-weight: 700;
      color: #111827;
    }

    .option-text {
      font-size: 15px;
      line-height: 1.6;
      color: #111827;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .media-stack {
      display: grid;
      gap: 10px;
      margin: 12px 0;
    }

    .media-card {
      margin: 0;
      border: 1px solid #dbeafe;
      border-radius: 10px;
      background: #eff6ff;
      padding: 10px;
      overflow: visible;
    }

    .media-card img {
      display: block;
      width: auto;
      max-width: 100%;
      height: auto;
      margin: 0 auto;
      border-radius: 8px;
    }

    .rich-text-output {
      display: block;
      white-space: normal;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .rich-text-output > :first-child {
      margin-top: 0;
    }

    .rich-text-output > :last-child {
      margin-bottom: 0;
    }

    .rich-text-output p,
    .rich-text-output div,
    .rich-text-output ul,
    .rich-text-output ol {
      margin: 0 0 0.45em;
    }

    .rich-text-output li {
      margin: 0 0 0.2em;
    }

    .status-pill,
    .band-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 4px 10px;
      border: 1px solid #d1d5db;
      border-radius: 999px;
      font-size: 14px;
      line-height: 1.4;
      font-weight: 700;
      white-space: nowrap;
    }

    .status-pass {
      background: #dcfce7;
      border-color: #86efac;
      color: #166534;
    }

    .status-fail {
      background: #fee2e2;
      border-color: #fca5a5;
      color: #991b1b;
    }

    .status-neutral {
      background: #eff6ff;
      border-color: #93c5fd;
      color: #1d4ed8;
    }

    .verification-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.4fr) minmax(0, 0.6fr);
      gap: 12px;
      align-items: center;
    }

    .verification-copy {
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      background: #f9fafb;
      padding: 12px;
    }

    .verification-qr {
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      background: #ffffff;
      padding: 12px;
      text-align: center;
    }

    .verification-qr svg {
      display: inline-block;
      max-width: 100%;
      height: auto;
    }

    .qr-fallback,
    .muted {
      color: #4b5563;
    }
  `;
}

function buildDedicatedPdfRouteDocument(payload = {}) {
  let title = 'OPE Assessor PDF';
  let bodyHtml = '';

  if (payload.type === 'result-summary') {
    title = 'Result Summary PDF';
    bodyHtml = buildResultSummaryBody(payload);
  } else if (payload.type === 'student-correction') {
    title = 'Student Correction PDF';
    bodyHtml = buildStudentCorrectionBody(payload);
  } else if (payload.type === 'facility-index') {
    title = 'Facility Index PDF';
    bodyHtml = buildFacilityIndexBody(payload);
  } else {
    bodyHtml = `
      <div class="page-shell">
        <section class="section-card">
          <h1 class="section-title">PDF export could not be prepared.</h1>
          <div class="meta-text">The requested record was not found or the PDF route type is unsupported.</div>
        </section>
      </div>
    `;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex,nofollow" />
  <title>${escapeHtml(title)}</title>
  <style>
    ${buildGlobalStyles()}
  </style>
</head>
<body>
  <main id="pdf-root">
    ${bodyHtml}
  </main>
</body>
</html>`;
}

function isDedicatedPdfRouteType(type = '') {
  return ['result-summary', 'student-correction', 'facility-index'].includes((type || '').toString().trim().toLowerCase());
}

module.exports = {
  buildDedicatedPdfRouteDocument,
  isDedicatedPdfRouteType
};
