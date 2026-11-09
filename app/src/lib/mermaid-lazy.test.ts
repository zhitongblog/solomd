import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queueMermaidJob, yieldToMain, peekMermaidSvg } from './mermaid-lazy.ts';

/**
 * #522 — the scheduling guarantees behind "render in background". mermaid's
 * own render is CPU-bound JS; a chain of `await`s on already-resolved
 * promises never ends the current task, so input and frames starve until the
 * whole note has been drawn. These tests pin down the queue that fixes it.
 */

test('#522 queue runs render jobs strictly one at a time, in FIFO order', async () => {
  let active = 0;
  let maxActive = 0;
  const order: number[] = [];
  const jobs = Array.from({ length: 12 }, (_unused, i) =>
    queueMermaidJob(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(i);
      // A resolved promise is a microtask: still inside the same job. If the
      // queue used plain `await` chaining instead of a serial drain, the
      // next job would start here and maxActive would exceed 1.
      await Promise.resolve();
      active -= 1;
    }),
  );
  await Promise.all(jobs);
  assert.equal(maxActive, 1, 'two mermaid renders must never overlap');
  assert.deepEqual(order, Array.from({ length: 12 }, (_unused, i) => i));
});

test('#522 viewport (front) jobs overtake the background queue in their own order', async () => {
  const order: string[] = [];
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const running = new Promise<void>((resolve) => { started = resolve; });

  // Wait until this job is actually running: the drain loop from a previous
  // test may still be finishing its last yield, and only then are we sure
  // every job below is enqueued behind a blocked first one.
  const blocker = queueMermaidJob(async () => { started(); await gate; order.push('blocker'); });
  await running;
  const back1 = queueMermaidJob(async () => { order.push('back-1'); });
  const front1 = queueMermaidJob(async () => { order.push('front-1'); }, { front: true });
  const front2 = queueMermaidJob(async () => { order.push('front-2'); }, { front: true });
  const back2 = queueMermaidJob(async () => { order.push('back-2'); });

  release();
  await Promise.all([blocker, back1, front1, front2, back2]);
  assert.deepEqual(order, ['blocker', 'front-1', 'front-2', 'back-1', 'back-2']);
});

test('#522 the queue ends its task between jobs, so a pending timer can run', async () => {
  const events: string[] = [];
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const running = new Promise<void>((resolve) => { started = resolve; });

  const first = queueMermaidJob(async () => { started(); await gate; events.push('job-1'); });
  await running;
  // Queued while job-1 is blocked. With microtask-only chaining the second
  // job would run before this timer got a turn and input would starve.
  setTimeout(() => events.push('timer'), 0);
  const second = queueMermaidJob(async () => { events.push('job-2'); });

  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['job-1', 'timer', 'job-2']);
});

test('#522 a throwing job neither rejects the caller nor stalls the drain', async () => {
  const seen: string[] = [];
  const bad = queueMermaidJob(async () => { throw new Error('render failed'); });
  const good = queueMermaidJob(async () => { seen.push('after'); });
  await Promise.all([bad, good]);
  assert.deepEqual(seen, ['after']);
});

test('#522 yieldToMain resolves on a macrotask, not a microtask', async () => {
  const events: string[] = [];
  // Register this timer *before* yieldToMain's own timer, so it proves a
  // real task boundary was crossed rather than just a promise resolution.
  setTimeout(() => { events.push('timer'); }, 0);
  const yielded = yieldToMain().then(() => { events.push('yield'); });
  void Promise.resolve().then(() => { events.push('microtask'); });
  await yielded;
  assert.deepEqual(events, ['microtask', 'timer', 'yield']);
});

test('#522 the SVG cache starts empty for an unseen theme + source pair', () => {
  assert.equal(peekMermaidSvg('default', 'flowchart TD\n  A-->B#522-unseen'), undefined);
});
