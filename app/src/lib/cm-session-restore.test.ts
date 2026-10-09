import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDebouncedWrite } from './cm-session-restore.ts';

/** Manual clock: timers only fire when the test says so. */
function fakeTimers() {
  let next = 1;
  const live = new Map<number, () => void>();
  return {
    timers: {
      set: (fn: () => void) => {
        const id = next++;
        live.set(id, fn);
        return id;
      },
      clear: (h: unknown) => {
        live.delete(h as number);
      },
    },
    fireAll() {
      const fns = [...live.values()];
      live.clear();
      for (const fn of fns) fn();
    },
    get armed() {
      return live.size;
    },
  };
}

test('only the last scheduled value is written when the timer fires', () => {
  const clock = fakeTimers();
  const writes: string[] = [];
  const w = createDebouncedWrite<string>((v) => writes.push(v), 500, clock.timers);
  w.schedule('a');
  w.schedule('ab');
  w.schedule('abc');
  assert.equal(clock.armed, 1);
  clock.fireAll();
  assert.deepEqual(writes, ['abc']);
});

test('flush writes the pending value at once (the quit-within-500ms case)', () => {
  const clock = fakeTimers();
  const writes: string[] = [];
  const w = createDebouncedWrite<string>((v) => writes.push(v), 500, clock.timers);
  w.schedule('typed just before quit');
  assert.equal(w.pending, true);
  w.flush();
  assert.deepEqual(writes, ['typed just before quit']);
  assert.equal(w.pending, false);
  assert.equal(clock.armed, 0, 'the timer is cancelled, so the value is not written twice');
  clock.fireAll();
  assert.deepEqual(writes, ['typed just before quit']);
});

test('flush with nothing pending writes nothing', () => {
  const clock = fakeTimers();
  const writes: string[] = [];
  const w = createDebouncedWrite<string>((v) => writes.push(v), 500, clock.timers);
  w.flush();
  w.schedule('x');
  clock.fireAll();
  w.flush();
  assert.deepEqual(writes, ['x']);
});
