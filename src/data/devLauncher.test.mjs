// Development-launcher shutdown behaviour.
//
// Regression cover for a real Windows bug: pressing Ctrl-C once against
// `npm run dev` shut the PANOPTIC backend down but left Vite holding its port.
//
// Two independent causes, one test each:
//
//   1. STDIN MUST NOT BE THE CONSOLE TTY. Vite's bindCLIShortcuts() engages only
//      when `process.stdin.isTTY`, and then builds a readline interface over it.
//      Readline puts the console in raw mode and consumes Ctrl-C itself, so the
//      event never becomes a process signal — and Vite registers SIGTERM but no
//      SIGINT handler, so it survives. Handing the child a pipe keeps isTTY
//      false and the shortcuts unbound.
//
//   2. KILLING A CHILD MUST KILL ITS DESCENDANTS. Vite spawns helpers (a real
//      one was observed as a child of the Vite pid during this investigation).
//      `child.kill()` targets only the immediate PID; whether a descendant then
//      dies is incidental, not guaranteed. This is defence in depth rather than
//      the primary fix — cause 1 is what actually broke Ctrl-C.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { CHILD_STDIO, stopChild } from '../../scripts/dev-panoptic.mjs';

const LAUNCHER = new URL('../../scripts/dev-panoptic.mjs', import.meta.url);

/** Whether a pid is still alive, without signalling it. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

async function waitUntil(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(50);
  }
  return false;
}

// ---------------------------------------------------------------------------
// 1. stdin must never be the console TTY
// ---------------------------------------------------------------------------

test('children never inherit the console stdin', () => {
  // 'inherit' here is what caused Vite to swallow Ctrl-C and outlive the
  // launcher. A pipe makes the child's stdin a non-TTY unconditionally,
  // whatever the launcher itself was given.
  assert.deepEqual([...CHILD_STDIO], ['pipe', 'pipe', 'pipe']);
  assert.notEqual(CHILD_STDIO[0], 'inherit', 'an inherited TTY lets Vite intercept Ctrl-C');
});

test('the launcher passes CHILD_STDIO to spawn, not a literal inherit', async () => {
  const source = await readFile(LAUNCHER, 'utf8');
  assert.match(source, /stdio:\s*\[\.\.\.CHILD_STDIO\]/, 'spawn must use the pinned stdio');
  assert.equal(
    /stdio:\s*\[\s*'inherit'/.test(source),
    false,
    'no child may be spawned with an inherited stdin',
  );
});

test('a child given CHILD_STDIO sees a non-TTY stdin', async () => {
  // The property that gates Vite's bindCLIShortcuts(), asserted directly.
  const child = spawn(process.execPath, ['-e', 'process.stdout.write(String(Boolean(process.stdin.isTTY)))'], {
    stdio: [...CHILD_STDIO],
  });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(out, 'false', 'a piped stdin must never look like a TTY');
});

// ---------------------------------------------------------------------------
// 2. stopChild must take the whole tree
// ---------------------------------------------------------------------------

test('stopChild terminates the child', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: [...CHILD_STDIO] });
  await waitUntil(() => alive(child.pid), 5_000);
  assert.equal(alive(child.pid), true, 'precondition: the child is running');

  stopChild(child);
  assert.equal(await waitUntil(() => !alive(child.pid)), true, 'the child must be gone');
});

test('stopChild terminates grandchildren too', async () => {
  // Vite spawns helper processes; killing only the immediate pid leaks them.
  const script = `
    const { spawn } = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    process.stdout.write(String(grandchild.pid));
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: [...CHILD_STDIO] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  await waitUntil(() => out.length > 0, 10_000);

  const grandchildPid = Number(out.trim());
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, 'grandchild pid was reported');
  assert.equal(alive(grandchildPid), true, 'precondition: the grandchild is running');

  stopChild(child);
  assert.equal(await waitUntil(() => !alive(child.pid)), true, 'the child must be gone');
  assert.equal(
    await waitUntil(() => !alive(grandchildPid)),
    true,
    'the whole tree must be gone, whether or not a plain kill would have sufficed',
  );
});

test('stopChild is safe to call twice and on an already-exited child', async () => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: [...CHILD_STDIO] });
  await new Promise((resolve) => child.on('exit', resolve));
  // Must not throw, and must not signal an unrelated process that inherited the pid.
  stopChild(child);
  stopChild(child);
  stopChild(null);
  assert.ok(true);
});

// ---------------------------------------------------------------------------
// Platform strategy
// ---------------------------------------------------------------------------

test('Windows uses a tree kill; POSIX keeps graceful SIGTERM with escalation', async () => {
  const source = await readFile(LAUNCHER, 'utf8');
  // Windows: taskkill /T walks descendants, /F because a console app with no
  // message loop never answers a polite request.
  assert.match(source, /taskkill/);
  assert.match(source, /'\/T'/);
  assert.match(source, /'\/F'/);
  // POSIX behaviour is unchanged: SIGTERM first so serve.js can shut down
  // gracefully, SIGKILL only as a bounded escalation.
  assert.match(source, /child\.kill\('SIGTERM'\)/);
  assert.match(source, /child\.kill\('SIGKILL'\)/);
});

test('importing the launcher does not start anything', async () => {
  // main() is behind a pathToFileURL self-start guard, so these tests can import
  // the module without spawning a dev stack.
  const source = await readFile(LAUNCHER, 'utf8');
  assert.match(source, /import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/);
});
