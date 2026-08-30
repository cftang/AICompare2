import fs from 'node:fs';
import { Term } from './vt.mjs';
import { INSTR, extract, parseQuestions, entryMd } from './extract.mjs';

const SRC = process.argv[2] || 'C:\\Users\\thinkpad\\Downloads\\infer\\exam1.txt';
const OUT = process.argv[3] || 'c:\\tmp\\exam1answer.md';
const PROG = process.argv[4] || 'C:\\tmp\\exam1-progress.log';
const RAWDIR = process.argv[5] || 'C:\\tmp\\exam-raw';
const LIMIT = parseInt(process.argv[6] || '0', 10);
const ONLY = process.env.ONLY_Q ? new Set(process.env.ONLY_Q.split(',').map(n => parseInt(n, 10))) : null;
const COLS = 73, ROWS = 28;
const MAX_WAIT_MS = 300000;
const POLL_MS = 2000;

function log(s) { fs.appendFileSync(PROG, s + '\n', 'utf8'); console.log(s); }

const questions = parseQuestions(fs.readFileSync(SRC, 'utf8'));
log(`parsed ${questions.length} questions`);

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
    // stdout frames only, base64 as received — the ground truth for offline
    // re-rendering when the VT emulator is improved
    stdoutFrames: () => frames.filter(d => {
      const b = Buffer.from(d, 'base64');
      return b.length >= 20 && b.readUInt32BE(4) === 0xfd;
    }),
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
  const name = SRC.split(/[\\/]/).pop().replace(/\.txt$/i, '');
  fs.writeFileSync(OUT, `# ${name} 答案（aishell / glm-5.2）\n\n生成时间: ${new Date().toISOString()}\n`, 'utf8');
}
const existing = fs.readFileSync(OUT, 'utf8');
const done = new Set([...existing.matchAll(/## 第(\d+)题/g)].map(m => parseInt(m[1], 10)));
let todo = ONLY ? questions.filter(q => ONLY.has(q.num)) : questions.filter(q => !done.has(q.num));
if (LIMIT > 0) todo = todo.slice(0, LIMIT);
log(`resume: ${done.size} done, ${todo.length} pending${ONLY ? ' (ONLY_Q)' : ''}${LIMIT ? ' (limited)' : ''}`);

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
  let bodyText = '', rawText = '', ansText = null;
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
    rawText = ex.raw || '';
    ansText = ex.ans;
    log(`Q${q.num} ${finished ? 'done' : 'TIMEOUT'} ${((Date.now() - start) / 1000).toFixed(0)}s | lines=${all.length} | ANSWER=${ansText || 'N/A'}`);
    fs.writeFileSync(`${RAWDIR}\\q${String(q.num).padStart(2, '0')}.txt`, all.join('\n'), 'utf8');
    // Archive the undecoded stdout frames too: the render above is only as good
    // as vt.mjs, but the frames let any future emulator fix be applied offline.
    fs.writeFileSync(
      `${RAWDIR}\\q${String(q.num).padStart(2, '0')}.frames.json`,
      JSON.stringify(s.stdoutFrames()),
      'utf8'
    );
  } catch (e) {
    log(`Q${q.num} ERROR: ${e.message}`);
    bodyText = `(执行错误: ${e.message})`;
    try { session?.ws.close(); } catch (_) {}
    session = null;
  }

  fs.appendFileSync(OUT, entryMd(q, ansText, bodyText, rawText), 'utf8');
  log(`Q${q.num} saved`);
}

try { session?.ws.close(); } catch (_) {}
log('ALL DONE');
