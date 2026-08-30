import { promptState } from './extract.mjs';

// Unit tests for the pre-submit prompt guard. The footer of the aishell input
// box is the only reliable signal that Enter will actually submit.

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) { pass++; return; }
  fail++;
  console.log(`FAIL ${name}\n  got  ${got}\n  want ${want}`);
}

const IDLE = [
  '┃ > ',
  '┃',
  '  (Tab to accept)   enter send   ctrl+c quit   ctrl+p commands'
].join('\n');

const BUSY = [
  '  / Thinking...',
  '  esc cancel'
].join('\n');

// A slash command reached the box: Enter now runs a command instead of sending,
// and the box never clears, so every later paste just appends.
const STUCK_EXECUTE = [
  '┃ > /help',
  '  enter execute   esc cancel'
].join('\n');

const STUCK_NOMATCH = [
  '┃ > /help 请先给出详细解析',
  '  No matching items'
].join('\n');

check('idle prompt', promptState(IDLE), 'idle');
check('streaming response', promptState(BUSY), 'busy');
check('slash-command execute footer', promptState(STUCK_EXECUTE), 'stuck');
check('slash-command no-match list', promptState(STUCK_NOMATCH), 'stuck');
check('blank screen', promptState(''), 'unknown');
// "stuck" must win even while a request is still draining, otherwise the run
// submits into a box that will never clear.
check('stuck outranks busy', promptState(STUCK_EXECUTE + '\n  esc cancel'), 'stuck');

console.log(`extract tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
