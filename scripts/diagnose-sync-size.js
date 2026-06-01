/*
Diagnostic: compute raw JSON and gzipped sizes for submissions of a quiz.
Usage:
  node scripts/diagnose-sync-size.js --quiz=458830 [--file=path/to/submissions.json]

If --file is omitted, the script looks for ./data/submissions.json or
./submissions.json in the repo root. The JSON file should be the array saved
in localStorage under the key used by the app (an array of submission objects).

Output: raw payload bytes, gzipped payload bytes, number of submissions,
client limit (16 MB) check, legacy server 8 MB check.
*/

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  args.forEach((a) => {
    if (a.startsWith('--quiz=')) out.quiz = a.split('=')[1];
    if (a.startsWith('--file=')) out.file = a.split('=')[1];
  });
  return out;
}

function findDefaultFile() {
  const candidates = [path.join(__dirname, '..', 'data', 'submissions.json'), path.join(__dirname, '..', 'submissions.json')];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

(async function main() {
  const args = parseArgs();
  const quizId = (args.quiz || '').toString().trim();
  if (!quizId) {
    console.error('Specify --quiz=<id>');
    process.exit(2);
  }
  const file = args.file || findDefaultFile();
  if (!file) {
    console.error('No submissions file provided and no default found. Use --file=path or place a submissions.json in ./data or repo root.');
    process.exit(2);
  }
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { console.error('Failed to read', file, e.message); process.exit(2); }
  let list;
  try { list = JSON.parse(raw); } catch (e) { console.error('Failed to parse JSON in', file, e.message); process.exit(2); }
  if (!Array.isArray(list)) { console.error('Submissions JSON must be an array'); process.exit(2); }
  const selected = list.filter(s => s && String(s.quizId) === String(quizId));
  const trimmed = selected.map(s => {
    // emulate slimSubmissionListForStorage -> slimSubmissionForStorage behaviour
    const copy = JSON.parse(JSON.stringify(s));
    if (Array.isArray(copy.allQuestions)) {
      copy.allQuestions = copy.allQuestions.map(q => {
        if (!q || !Array.isArray(q.mediaAssets) || !q.mediaAssets.length) return q;
        return Object.assign({}, q, { mediaAssets: [] });
      });
    }
    if (Array.isArray(copy.snapshots)) {
      copy.snapshots = copy.snapshots.map(sn => {
        if (!sn || typeof sn !== 'object') return sn;
        const nxt = Object.assign({}, sn);
        if (nxt.data) delete nxt.data;
        if (nxt.question && Array.isArray(nxt.question.mediaAssets) && nxt.question.mediaAssets.length) {
          nxt.question = Object.assign({}, nxt.question, { mediaAssets: [] });
        }
        return nxt;
      });
    }
    return copy;
  });
  const payloadObj = { submissions: trimmed };
  const payloadJson = JSON.stringify(payloadObj);
  const rawBytes = Buffer.byteLength(payloadJson, 'utf8');
  let gzipped;
  try { gzipped = zlib.gzipSync(Buffer.from(payloadJson, 'utf8')); } catch (e) { gzipped = null; }
  const gzipBytes = gzipped ? gzipped.length : null;
  const clientLimit = 16 * 1024 * 1024; // 16 MB
  const legacyServerLimit = 8 * 1024 * 1024; // 8 MB

  console.log('Diagnostic report for quiz', quizId);
  console.log('- submissions found:', selected.length);
  console.log('- raw payload bytes:', rawBytes, `(${(rawBytes/1024/1024).toFixed(2)} MB)`);
  if (gzipBytes != null) console.log('- gzipped payload bytes:', gzipBytes, `(${(gzipBytes/1024/1024).toFixed(2)} MB)`);
  else console.log('- gzipped payload: compression failed');
  console.log('- client limit (16 MB):', clientLimit, `(${(clientLimit/1024/1024).toFixed(0)} MB)`, gzipBytes != null ? (gzipBytes <= clientLimit ? 'OK' : 'TOO LARGE') : (rawBytes <= clientLimit ? 'OK' : 'TOO LARGE'));
  console.log('- legacy server limit (8 MB):', legacyServerLimit, `(${(legacyServerLimit/1024/1024).toFixed(0)} MB)`, gzipBytes != null ? (gzipBytes <= legacyServerLimit ? 'OK' : 'TOO LARGE') : (rawBytes <= legacyServerLimit ? 'OK' : 'TOO LARGE'));

  // If gzipped is OK but raw is over older limit, note that server may reject
  if (gzipBytes != null && gzipBytes <= clientLimit && gzipBytes > legacyServerLimit) {
    console.log('\nNote: client accepts gzipped payload but legacy server limit (8 MB) would still reject if enforced server-side.');
  }

  process.exit(0);
})();
