import fs from 'node:fs';

const SRC = process.argv[2] || 'C:\\Users\\thinkpad\\Downloads\\infer\\exam0.txt';
const OUT = process.argv[3] || 'c:\\tmp\\exam0answer.md';
const LOG = process.argv[4] || 'C:\\tmp\\exam0-progress.log';
const RAW = process.argv[5] || 'C:\\tmp\\exam-raw';
const INSTR = '请先给出详细解析，然后在最后单独一行输出 ANSWER 加英文冒号加答案字母（多选用逗号分隔）。';

// ---- 1. parse questions exactly like the runner does ----
const raw = fs.readFileSync(SRC, 'utf8').replace(/^\uFEFF/, '');
const blocks = raw.split(/\r?\n(?=(?:单选题|多选题)(?:\r?\n|$))/);
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
  const sig = body.replace(/\s+/g, '');
  if (seenBodies.has(sig)) continue;
  seenBodies.add(sig);
  while (usedNums.has(num)) num++;
  usedNums.add(num);
  questions.push({ num, type, body });
}
console.log('parsed questions:', questions.length);

// ---- 2. answers recorded in the progress log ----
const logAns = new Map();
for (const m of fs.readFileSync(LOG, 'utf8').matchAll(/^Q(\d+) done .*ANSWER=(\S+)$/gm)) {
  logAns.set(parseInt(m[1], 10), m[2]);
}
console.log('answers in log:', logAns.size);

// ---- 3. noise filtering ----
const NOISE = [
  'Tab to accept', 'enter send', 'esc cancel', 'ctrl+c quit', 'ctrl+p commands',
  'ASK glm', 'huawei-inner-provider', 'Thinking...', 'Thinking Done',
  'Run /sessions', 'Run /models', 'ctrl+c clean'
];
function cleanLines(lines) {
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

const norm = s => s.replace(/\s+/g, '');
const stripBox = s => s.replace(/^[\s╹┃│▏▕]+/, '').replace(/[\s╹]+$/, '');
const normLine = s => norm(stripBox(s));
const INSTR_N = norm(INSTR);

function extract(rawLines, q) {
  const qLines = q.body.split('\n').map(l => l.trim()).filter(Boolean);
  const anchorN = norm(qLines[qLines.length - 1]);
  const qLineSet = new Set(qLines.map(norm).filter(s => s.length > 3));

  // candidate anchor line indices (echoed final option), in file order.
  // The terminal hard-wraps long options, so test a sliding window of up to
  // 4 consecutive lines joined together, and anchor on the window's last line.
  const anchors = [];
  for (let i = 0; i < rawLines.length; i++) {
    const n = normLine(rawLines[i]);
    if (!n) continue;
    if (n === anchorN || (anchorN.length >= 4 && n.includes(anchorN))) { anchors.push(i); continue; }
    let joined = n;
    for (let w = 1; w < 4 && i - w >= 0; w++) {
      joined = normLine(rawLines[i - w]) + joined;
      if (joined.includes(anchorN)) { anchors.push(i); break; }
    }
  }

  // Try each anchor from the last backwards; accept the first slice that
  // contains an ANSWER line and does NOT start with the echoed instruction.
  const tries = anchors.length ? anchors.slice().reverse() : [-1];
  let best = null;
  for (const a of tries) {
    let cand = cleanLines(rawLines.slice(a + 1));
    // drop any leading echo: instruction line, type header, or question/option lines
    while (cand.length) {
      const n = norm(cand[0]);
      if (!n) { cand.shift(); continue; }
      if (n.includes(INSTR_N.slice(0, 18))) { cand.shift(); continue; }
      if (n === '多选题' || n === '单选题') { cand.shift(); continue; }
      if (qLineSet.has(n)) { cand.shift(); continue; }
      if (/^\d+[、.．]/.test(n)) { cand.shift(); continue; }
      break;
    }
    const text = cand.join('\n').trim();
    if (!text) continue;
    const clean = !norm(text).includes(INSTR_N.slice(0, 18));
    if (!best) best = text;
    if (/ANSWER\s*[:：]/.test(text) && clean) { best = text; break; }
  }

  const joined = rawLines.join('\n');
  const ms = [...joined.matchAll(/ANSWER\s*[:：]\s*([A-Da-d](?:\s*[,，、\/]\s*[A-Da-d])*)/g)];
  const ans = ms.length ? ms[ms.length - 1][1].toUpperCase().replace(/[\s，、\/]+/g, ',') : null;
  return { body: best || '(未捕获到回答内容)', ans };
}

// ---- 4. rebuild ----
const parts = [`# 答案（aishell / glm-5.2）\n\n来源: ${SRC}\n重建时间: ${new Date().toISOString()}\n`];
let ok = 0, echoFixed = 0, missing = 0;
for (const q of questions) {
  const file = `${RAW}\\q${String(q.num).padStart(2, '0')}.txt`;
  if (!fs.existsSync(file)) { console.log('MISSING raw for Q' + q.num); missing++; continue; }
  const rawLines = fs.readFileSync(file, 'utf8').split('\n');
  const { body, ans } = extract(rawLines, q);
  const answer = ans || logAns.get(q.num) || '未识别';
  if (norm(body).includes(INSTR_N.slice(0, 18))) { console.log('WARN echo remains in Q' + q.num); }
  else echoFixed++;
  ok++;
  parts.push(`\n## 第${q.num}题（${q.type}）\n\n${q.body}\n\n**答案：** ${answer}\n\n<details><summary>aishell 回答</summary>\n\n\`\`\`\n${body}\n\`\`\`\n\n</details>\n\n---\n`);
}
fs.writeFileSync(OUT, parts.join(''), 'utf8');
console.log(`rebuilt ${ok} entries, clean bodies: ${echoFixed}, missing raw: ${missing}`);
console.log('bytes written:', fs.statSync(OUT).size);
