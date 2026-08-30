import fs from 'node:fs';
import { Term } from './vt.mjs';

const SRC = process.argv[2] || 'C:\\Users\\thinkpad\\Downloads\\infer\\exam1.txt';
const OUT = process.argv[3] || 'c:\\tmp\\exam1answer.md';
const PROG = process.argv[4] || 'C:\\tmp\\exam1-progress.log';
const COLS = 73, ROWS = 28;
const MAX_WAIT_MS = 300000;
const POLL_MS = 2000;

const INSTR = '请先给出详细解析，然后在最后单独一行输出 ANSWER 加英文冒号加答案字母（多选用逗号分隔）。';

function log(s) { fs.appendFileSync(PROG, s + '\n', 'utf8'); console.log(s); }

const raw = fs.readFileSync(SRC, 'utf8').replace(/^﻿/, '');
const blocks = raw.split(/\r?\n(?=(?:单选题|多选题)(?:\r?\n|$))/);
const questions = [];
const seenBodies = new Set();
const usedNums = new Set();
for (const b of blocks) {
  const lines = b.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!/^(单选题|多选题)/.test(lines[0])) continue;
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
log(`parsed ${questions.length} questions`);

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

function norm(s) { return s.replace(/\s+/g, ''); }
function stripBox(s) { return s.replace(/^[\s╹┃│▏▕]+/, '').replace(/[\s╹]+$/, ''); }
function normLine(s) { return norm(stripBox(s)); }

function extract(allLines, q) {
  const qLines = q.body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const anchorN = norm(qLines[qLines.length - 1] || '');
  const qLineSet = new Set(qLines.map(norm).filter(s => s.length > 3));
  const instrN = norm(INSTR);

  // Candidate anchors: the echoed final option inside the prompt box.
  // Box-drawing prefixes are stripped, and because the terminal hard-wraps
  // long options we also test a sliding window of up to 4 joined lines.
  const anchors = [];
  for (let i = 0; i < allLines.length; i++) {
    const n = normLine(allLines[i]);
    if (!n) continue;
    if (n === anchorN || (anchorN.length >= 4 && n.includes(anchorN))) { anchors.push(i); continue; }
    let joined = n;
    for (let w = 1; w < 4 && i - w >= 0; w++) {
      joined = normLine(allLines[i - w]) + joined;
      if (anchorN.length >= 4 && joined.includes(anchorN)) { anchors.push(i); break; }
    }
  }

  // Walk anchors newest-first; accept the first slice that yields an ANSWER
  // line and is free of the echoed instruction/question.
  const tries = anchors.length ? anchors.slice().reverse() : [-1];
  let best = null;
  for (const a of tries) {
    const cand = cleanLines(allLines.slice(a + 1));
    while (cand.length) {
      const n = norm(cand[0]);
      if (!n) { cand.shift(); continue; }
      if (n.includes(instrN.slice(0, 18))) { cand.shift(); continue; }
      if (n === '多选题' || n === '单选题') { cand.shift(); continue; }
      if (qLineSet.has(n)) { cand.shift(); continue; }
      if (/^\d+[、.．]/.test(n)) { cand.shift(); continue; }
      break;
    }
    const text = cand.join('\n').trim();
    if (!text) continue;
    if (!best) best = text;
    const clean = !norm(text).includes(instrN.slice(0, 18));
    if (/ANSWER\s*[:：]/.test(text) && clean) { best = text; break; }
  }

  const joined = allLines.join('\n');
  const ms = [...joined.matchAll(/ANSWER\s*[:：]\s*([A-Da-d](?:\s*[,，、\/]\s*[A-Da-d])*)/g)];
  const ans = ms.length ? ms[ms.length - 1][1].toUpperCase().replace(/[\s，、\/]+/g, ',') : null;
  return { body: best || '', ans };
}

async function connect() {
  const targets = await fetch('http://127.0.0.1:9222/json/list').then(r => r.json());
  const t = targets.find(x => x.type === 'iframe' && x.url.includes('devstation.connect.huaweicloud.com'));
  if (!t) throw new Error('aishell iframe target not found');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 1;
  const pending = new Map();
  let isoCtx = null;
  let frames = [];
  const call = (m, p) => new Promise((res, rej) => {
    const i = id++;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method: m, params: p }));
  });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id).res(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.executionContextCreated') {
      const c = m.params.context;
      if (String(c.origin).startsWith('chrome-extension://')) isoCtx = c.id;
    }
    if (m.method === 'Network.webSocketFrameReceived') frames.push(m.params.response.payloadData);
  };
  ws.onerror = () => {};
  await new Promise(r => ws.onopen = r);
  await call('Network.enable');
  await call('Runtime.enable');
  await new Promise(r => setTimeout(r, 1800));
  if (!isoCtx) throw new Error('isolated world not found');
  return {
    ws,
    resetFrames: () => { frames = []; },
    frameCount: () => frames.length,
    render: () => {
      const term = new Term(COLS, ROWS);
      for (const d of frames) {
        const b = Buffer.from(d, 'base64');
        if (b.length < 20 || b.readUInt32BE(4) !== 0xfd) continue;
        term.write(b.subarray(20).toString('utf8'));
      }
      return { all: term.allLines(), visible: term.visibleLines() };
    },
    submit: async (query) => {
      const r = await call('Runtime.evaluate', {
        contextId: isoCtx,
        expression: `(async () => { const h = await getSiteHandler('devstation.connect.huaweicloud.com'); await executeSiteHandler(${JSON.stringify(query)}, h.searchHandler); return 'ok'; })()`,
        awaitPromise: true, returnByValue: true
      });
      if (r.result?.result?.value !== 'ok') throw new Error('submit failed: ' + (r.result?.exceptionDetails?.text || JSON.stringify(r.result)));
    }
  };
}

if (!fs.existsSync(OUT) || fs.readFileSync(OUT, 'utf8').trim().length === 0) {
  fs.writeFileSync(OUT, `# exam1 答案（aishell / glm-5.2）\n\n生成时间: ${new Date().toISOString()}\n`, 'utf8');
}
const existing = fs.readFileSync(OUT, 'utf8');
const done = new Set([...existing.matchAll(/## 第(\d+)题/g)].map(m => parseInt(m[1], 10)));
let todo = questions.filter(q => !done.has(q.num));
const LIMIT = parseInt(process.argv[2] || '0', 10);
if (LIMIT > 0) todo = todo.slice(0, LIMIT);
log(`resume: ${done.size} done, ${todo.length} pending${LIMIT ? ' (limited)' : ''}`);

let session = null;
async function ensure() {
  if (session) return session;
  for (let a = 0; a < 4; a++) {
    try { session = await connect(); return session; }
    catch (e) { log(`connect retry ${a + 1}: ${e.message}`); await new Promise(r => setTimeout(r, 4000)); }
  }
  throw new Error('cannot connect to aishell target');
}

for (const q of todo) {
  let bodyText = '', ansText = null;
  try {
    const s = await ensure();
    s.resetFrames();
    await s.submit(INSTR + '\n' + q.type + '\n' + q.body);
    log(`--- Q${q.num} (${q.type}) submitted`);

    const start = Date.now();
    let stable = 0, lastSig = '', finished = false;
    while (Date.now() - start < MAX_WAIT_MS) {
      await new Promise(r => setTimeout(r, POLL_MS));
      const { all, visible } = s.render();
      const running = visible.join('\n').includes('esc cancel');
      const ex = extract(all, q);
      const sig = (ex.ans || '') + '|' + ex.body.length;
      if (!running && Date.now() - start > 6000) {
        stable = (sig === lastSig) ? stable + 1 : 0;
        if (ex.ans && stable >= 2) { finished = true; break; }
        if (stable >= 10) { finished = true; break; }
      } else stable = 0;
      lastSig = sig;
    }

    const { all } = s.render();
    const ex = extract(all, q);
    bodyText = ex.body || '(未捕获到回答内容)';
    ansText = ex.ans;
    log(`Q${q.num} ${finished ? 'done' : 'TIMEOUT'} ${((Date.now() - start) / 1000).toFixed(0)}s | lines=${all.length} | ANSWER=${ansText || 'N/A'}`);
    fs.writeFileSync(`C:\\tmp\\exam-raw\\q${String(q.num).padStart(2, '0')}.txt`, all.join('\n'), 'utf8');
  } catch (e) {
    log(`Q${q.num} ERROR: ${e.message}`);
    bodyText = `(执行错误: ${e.message})`;
    try { session?.ws.close(); } catch (_) {}
    session = null;
  }

  fs.appendFileSync(
    OUT,
    `\n## 第${q.num}题（${q.type}）\n\n${q.body}\n\n**答案：** ${ansText || '未识别'}\n\n<details><summary>aishell 回答</summary>\n\n\`\`\`\n${bodyText}\n\`\`\`\n\n</details>\n\n---\n`,
    'utf8'
  );
  log(`Q${q.num} saved`);
}

try { session?.ws.close(); } catch (_) {}
log('ALL DONE');
