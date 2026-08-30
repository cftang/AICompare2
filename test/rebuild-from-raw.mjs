import fs from 'node:fs';
import { INSTR, extract, parseQuestions, entryMd, norm } from './extract.mjs';

// Regenerate an answer sheet offline from the archived VT renders. Never reads
// the answer sheet it is about to write — always rebuilds from the raw renders.
const SRC = process.argv[2] || 'C:\\Users\\thinkpad\\Downloads\\infer\\exam0.txt';
const OUT = process.argv[3] || 'c:\\tmp\\exam0answer.md';
const LOG = process.argv[4] || 'C:\\tmp\\exam0-progress.log';
const RAW = process.argv[5] || 'C:\\tmp\\exam-raw';

const questions = parseQuestions(fs.readFileSync(SRC, 'utf8'));
console.log('parsed questions:', questions.length);

const logAns = new Map();
if (fs.existsSync(LOG)) {
  for (const m of fs.readFileSync(LOG, 'utf8').matchAll(/^Q(\d+) done .*ANSWER=(\S+)$/gm)) {
    logAns.set(parseInt(m[1], 10), m[2]);
  }
}
console.log('answers in log:', logAns.size);

const name = SRC.split(/[\\/]/).pop().replace(/\.txt$/i, '');
const parts = [`# ${name} 答案（aishell / glm-5.2）\n\n来源: ${SRC}\n重建时间: ${new Date().toISOString()}\n`];
let ok = 0, clean = 0, missing = 0;
for (const q of questions) {
  const file = `${RAW}\\q${String(q.num).padStart(2, '0')}.txt`;
  if (!fs.existsSync(file)) { console.log('MISSING raw for Q' + q.num); missing++; continue; }
  const { body, ans, raw } = extract(fs.readFileSync(file, 'utf8').split('\n'), q);
  const answer = ans || logAns.get(q.num) || '未识别';
  if (norm(body).includes(norm(INSTR).slice(0, 18))) console.log('WARN echo remains in Q' + q.num);
  else clean++;
  ok++;
  parts.push(entryMd(q, answer, body || '(未捕获到回答内容)', raw));
}
fs.writeFileSync(OUT, parts.join(''), 'utf8');
console.log(`rebuilt ${ok} entries, clean bodies: ${clean}, missing raw: ${missing}`);
console.log('bytes written:', fs.statSync(OUT).size);
