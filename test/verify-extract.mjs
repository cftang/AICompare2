import fs from 'node:fs';
import { INSTR, extract, parseQuestions, norm } from './extract.mjs';

// Regression gate: replay the shared extract() over every archived VT render and
// confirm each entry is echo-free, yields an ANSWER letter, and produces a raw
// block at least as long as the cleaned one.
const SRC = process.argv[2] || 'C:\\Users\\thinkpad\\Downloads\\infer\\exam0.txt';
const RAW = process.argv[3] || 'C:\\tmp\\exam-raw';

const questions = parseQuestions(fs.readFileSync(SRC, 'utf8'));
const instrHead = norm(INSTR).slice(0, 18);

let checked = 0, echo = 0, noAns = 0, noRaw = 0, shortRaw = 0;
for (const q of questions) {
  const f = `${RAW}\\q${String(q.num).padStart(2, '0')}.txt`;
  if (!fs.existsSync(f)) { noRaw++; continue; }
  const { body, ans, raw } = extract(fs.readFileSync(f, 'utf8').split('\n'), q);
  checked++;
  if (norm(body).includes(instrHead)) { console.log('FAIL echo Q' + q.num); echo++; }
  if (!ans) { console.log('FAIL no ANSWER Q' + q.num); noAns++; }
  if (norm(raw).length < norm(body).length) { console.log('FAIL raw shorter than body Q' + q.num); shortRaw++; }
}
console.log(`checked ${checked} | echo leaks ${echo} | missing ANSWER ${noAns} | missing raw ${noRaw} | short raw ${shortRaw}`);
process.exit(echo || noAns || shortRaw ? 1 : 0);
