import fs from 'node:fs';

// Regression check: run the runner's extract() logic against the archived raw
// VT renders and confirm every entry is echo-free and yields an ANSWER letter.
const SRC = process.argv[2] || 'C:\\Users\\thinkpad\\Downloads\\infer\\exam0.txt';
const RAW = process.argv[3] || 'C:\\tmp\\exam-raw';
const RUNNER = new URL('./exam-runner.mjs', import.meta.url).pathname.replace(/^\//, '');

const src = fs.readFileSync(RUNNER, 'utf8');
const INSTR = src.match(/const INSTR = '([^']+)'/)[1];

// lift cleanLines / norm / stripBox / normLine / extract out of the runner
const start = src.indexOf('const NOISE = [');
const end = src.indexOf('async function connect()');
const mod = src.slice(start, end) + '\nexport { extract, cleanLines };\n';
fs.writeFileSync('C:\\tmp\\_extract-only.mjs', `const INSTR = ${JSON.stringify(INSTR)};\n` + mod, 'utf8');
const { extract } = await import('file:///C:/tmp/_extract-only.mjs');

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

let checked = 0, echo = 0, noAns = 0, noRaw = 0;
for (const q of questions) {
  const f = `${RAW}\\q${String(q.num).padStart(2, '0')}.txt`;
  if (!fs.existsSync(f)) { noRaw++; continue; }
  const { body, ans } = extract(fs.readFileSync(f, 'utf8').split('\n'), q);
  checked++;
  if (body.replace(/\s+/g, '').includes(INSTR.replace(/\s+/g, '').slice(0, 18))) { console.log('FAIL echo Q' + q.num); echo++; }
  if (!ans) { console.log('FAIL no ANSWER Q' + q.num); noAns++; }
}
fs.unlinkSync('C:\\tmp\\_extract-only.mjs');
console.log(`checked ${checked} | echo leaks ${echo} | missing ANSWER ${noAns} | missing raw ${noRaw}`);
process.exit(echo || noAns ? 1 : 0);
