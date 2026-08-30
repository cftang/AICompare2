// Shared answer-extraction logic. Imported by exam-runner.mjs (live capture),
// rebuild-from-raw.mjs (offline regeneration) and verify-extract.mjs (regression
// gate) so the three can never drift apart.

export const INSTR = '请先给出详细解析，然后在最后单独一行输出 ANSWER 加英文冒号加答案字母（多选用逗号分隔）。';

const NOISE = [
  'Tab to accept', 'enter send', 'esc cancel', 'ctrl+c quit', 'ctrl+p commands',
  'ASK glm', 'huawei-inner-provider', 'Thinking...', 'Thinking Done',
  'Run /sessions', 'Run /models', 'ctrl+c clean'
];

// Terminal chrome that marks the end of the answer region.
const TRAILING = [
  '(Tab to accept)', 'enter send', 'esc cancel', 'ctrl+c quit',
  'ctrl+p commands', 'ctrl+c clean', 'ASK glm', 'huawei-inner-provider'
];

export function cleanLines(lines) {
  const out = [];
  for (let l of lines) {
    l = l.replace(/^[\s╹┃│▏▕]+/, '').replace(/[\s╹]+$/, '');
    if (!l.trim()) { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
    if (NOISE.some(n => l.includes(n))) continue;
    if (/^[\s┃│╹▀▄█▔░▒\-\\|\/]+$/.test(l)) continue;
    out.push(l);
  }
  while (out.length && out[0] === '') out.shift();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

export function norm(s) { return s.replace(/\s+/g, ''); }
function stripBox(s) { return s.replace(/^[\s╹┃│▏▕]+/, '').replace(/[\s╹]+$/, ''); }
function normLine(s) { return norm(stripBox(s)); }
function isBox(s) { return /^\s*[╹┃│▏▕]/.test(s); }

// Candidate anchors: the echoed final option inside the prompt box. Because the
// terminal hard-wraps long options a sliding window of up to 4 joined lines is
// also tested. Anchors are restricted to lines carrying a box-drawing prefix:
// the echo box always has one, while the model's answer never does — and the
// answer routinely quotes the option text verbatim while analysing it, which
// would otherwise anchor inside the answer and truncate its beginning.
function findAnchors(allLines, anchorN, boxOnly) {
  const anchors = [];
  if (!anchorN) return anchors;
  for (let i = 0; i < allLines.length; i++) {
    if (boxOnly && !isBox(allLines[i])) continue;
    const n = normLine(allLines[i]);
    if (!n) continue;
    if (n === anchorN || (anchorN.length >= 4 && n.includes(anchorN))) { anchors.push(i); continue; }
    if (anchorN.length < 4) continue;
    let joined = n;
    for (let w = 1; w < 4 && i - w >= 0; w++) {
      if (boxOnly && !isBox(allLines[i - w])) break;
      joined = normLine(allLines[i - w]) + joined;
      if (joined.includes(anchorN)) { anchors.push(i); break; }
    }
  }
  return anchors;
}

function anchorsFor(allLines, anchorN) {
  const boxed = findAnchors(allLines, anchorN, true);
  return boxed.length ? boxed : findAnchors(allLines, anchorN, false);
}

function skipEcho(lines, q, shiftFn) {
  const qLines = q.body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const qLineSet = new Set(qLines.map(norm).filter(s => s.length > 3));
  const instrN = norm(INSTR);
  let s = 0;
  while (s < lines.length) {
    const n = norm(lines[s]);
    if (!n) { s++; continue; }
    if (n.includes(instrN.slice(0, 18))) { s++; continue; }
    if (n === '多选题' || n === '单选题') { s++; continue; }
    if (qLineSet.has(n) || /^\d+[、.．]/.test(n)) { s++; continue; }
    if (shiftFn && shiftFn(lines[s], n)) { s++; continue; }
    break;
  }
  return s;
}

// The model occasionally misspells the marker (observed: "ANSER:"), so the W is
// optional. Everything else must still match exactly to avoid false positives.
const ANSWER_RE = /\bANS(?:W)?ER\s*[:：]\s*([A-Da-d](?:\s*[,，、\/]\s*[A-Da-d])*)/g;

export function extract(allLines, q) {
  const qLines = q.body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const anchorN = norm(qLines[qLines.length - 1] || '');
  const instrN = norm(INSTR);
  const anchors = anchorsFor(allLines, anchorN);

  // Walk anchors newest-first; accept the first slice that yields an ANSWER
  // line and is free of the echoed instruction/question.
  const tries = anchors.length ? anchors.slice().reverse() : [-1];
  let best = null;
  for (const a of tries) {
    const cand = cleanLines(allLines.slice(a + 1)).slice(0);
    const text = cand.slice(skipEcho(cand, q)).join('\n').trim();
    if (!text) continue;
    if (!best) best = text;
    const clean = !norm(text).includes(instrN.slice(0, 18));
    if (new RegExp(ANSWER_RE.source).test(text) && clean) { best = text; break; }
  }

  const ms = [...allLines.join('\n').matchAll(ANSWER_RE)];
  const ans = ms.length ? ms[ms.length - 1][1].toUpperCase().replace(/[\s，、\/]+/g, ',') : null;
  return { body: best || '', ans, raw: extractRaw(allLines, q) };
}

// Verbatim answer text as aishell rendered it: same anchor search as extract(),
// but no noise filtering and no re-indentation inside the answer region, so the
// model's original indentation, bullets and ✅ marks survive. Only the leading
// echo/spinner noise and the trailing terminal chrome are cut.
export function extractRaw(allLines, q) {
  const qLines = q.body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const anchorN = norm(qLines[qLines.length - 1] || '');
  const anchors = anchorsFor(allLines, anchorN);
  const anchor = anchors.length ? anchors[anchors.length - 1] : -1;

  let out = allLines.slice(anchor + 1);
  out = out.slice(skipEcho(out, q, (line, n) =>
    /^[┃│╹▀▄█▔░▒\-\\|\/]+$/.test(n) ||
    n.includes('ThinkingDone') || n.includes('Thinking...') ||
    TRAILING.some(t => line.includes(t))
  ));

  const cut = out.findIndex(l => TRAILING.some(t => l.includes(t)));
  if (cut >= 0) out = out.slice(0, cut);

  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join('\n');
}

// Both input layouts: an explicit 第N/M题 marker, or a stem-numbered block
// (26、...). Dedup is by normalised body text rather than number, because some
// papers repeat numbers across different questions; colliding numbers are
// reassigned upward.
export function parseQuestions(srcText) {
  const blocks = srcText.replace(/^\uFEFF/, '').split(/\r?\n(?=(?:单选题|多选题)(?:\r?\n|$))/);
  const questions = [];
  const seenBodies = new Set();
  const usedNums = new Set();
  for (const b of blocks) {
    const lines = b.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length || !/^(单选题|多选题)/.test(lines[0])) continue;
    const type = lines[0].startsWith('多选') ? '多选题' : '单选题';
    let num = null, body = null;
    const marker = lines.findIndex(l => /第(\d+)\/\d+题/.test(l));
    if (marker >= 0) {
      num = parseInt(lines[marker].match(/第(\d+)\/\d+题/)[1], 10);
      body = lines.slice(marker + 1).join('\n');
    } else {
      const stem = lines.findIndex(l => /^(\d+)[、.．]/.test(l));
      if (stem < 0) continue;
      num = parseInt(lines[stem].match(/^(\d+)[、.．]/)[1], 10);
      body = lines.slice(stem).join('\n');
    }
    if (num === null || !body) continue;
    const sig = norm(body);
    if (seenBodies.has(sig)) continue;
    seenBodies.add(sig);
    while (usedNums.has(num)) num++;
    usedNums.add(num);
    questions.push({ num, type, body });
  }
  return questions;
}

// Markdown entry shared by the runner and the offline rebuilder.
export function entryMd(q, ansText, bodyText, rawText) {
  const rawBlock = rawText
    ? `\n<details><summary>aishell 原始输出</summary>\n\n\`\`\`text\n${rawText}\n\`\`\`\n\n</details>\n`
    : '';
  return `\n## 第${q.num}题（${q.type}）\n\n${q.body}\n\n**答案：** ${ansText || '未识别'}\n\n` +
    `<details><summary>aishell 回答</summary>\n\n\`\`\`\n${bodyText}\n\`\`\`\n\n</details>\n${rawBlock}\n---\n`;
}
