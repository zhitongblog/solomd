/**
 * v2.5 F4 — Pomodoro / Zen focus session timer.
 *
 * Single-session at-a-time, no nag. The store persists `{startedAt,
 * durationMs, paused}` to localStorage so a browser reload (or a Tauri
 * window relaunch with session restore on) picks the countdown back up
 * exactly where it left off.
 *
 * Auto-break chains EXACTLY ONE break after a focus session — no
 * infinite Pomodoro loops. The auto-engage-focus-mode toggle (in
 * settings) makes starting a session also flip `settings.focusMode = true`
 * for the duration; ending the session (whether timer-up, manual stop,
 * or auto-break finishing) restores the prior state.
 *
 * Stats persistence: every completed focus session appends one record to
 * `localStorage['solomd.pomodoro.sessions.v1']`. The shape is intentionally
 * minimal — `{date, durationMin, wordsWritten}` — so a future v2.6 stats
 * panel can render historical productivity without a schema migration.
 * NOTE: only focus sessions are recorded; break sessions are not (a break
 * isn't "writing time").
 */
import { defineStore } from 'pinia';
import { useTabsStore } from './tabs';
import { useSettingsStore } from './settings';
import { cjkWordCount } from '../lib/chinese';

const LS_STATE = 'solomd.pomodoro.state.v1';
const LS_SESSIONS = 'solomd.pomodoro.sessions.v1';
const LS_LAST_PRESET = 'solomd.pomodoro.lastPreset.v1';

export type PomodoroPhase = 'focus' | 'break' | 'flash';

export interface PomodoroSessionRecord {
  date: string; // ISO date "YYYY-MM-DD"
  durationMin: number;
  wordsWritten: number;
}

interface PersistedState {
  phase: PomodoroPhase;
  startedAt: number; // epoch ms when current run started (excluding paused time)
  durationMs: number;
  paused: boolean;
  pausedRemainingMs: number; // remaining ms snapshot when paused; 0 if not paused
  // Snapshot at start so we can compute words-written delta + restore focus mode
  startWordCount: number;
  priorFocusMode: boolean;
  // Whether an auto-break should chain after this focus phase
  autoBreakNext: boolean;
  // Whether to fire a notification at the end of the focus phase
  notifyOnEnd: boolean;
}

interface PomodoroState extends Partial<PersistedState> {
  /** Tick-driving timestamp; not persisted, just makes `remaining` reactive. */
  now: number;
  /** Mounted = there's an active or just-finished (flashing) session. */
  active: boolean;
  /** True while we're in the 5-second post-completion green flash. */
  flashing: boolean;
}

let tickHandle: ReturnType<typeof setInterval> | null = null;
let flashHandle: ReturnType<typeof setTimeout> | null = null;

function loadPersisted(): PersistedState | null {
  try {
    const raw = localStorage.getItem(LS_STATE);
    if (!raw) return null;
    const obj = JSON.parse(raw) as PersistedState;
    // Sanity — sessions older than 24h are stale, drop them.
    if (typeof obj?.startedAt !== 'number') return null;
    if (Date.now() - obj.startedAt > 24 * 60 * 60 * 1000) {
      localStorage.removeItem(LS_STATE);
      return null;
    }
    return obj;
  } catch {
    return null;
  }
}

function savePersisted(s: PersistedState) {
  try {
    localStorage.setItem(LS_STATE, JSON.stringify(s));
  } catch {}
}

function clearPersisted() {
  try {
    localStorage.removeItem(LS_STATE);
  } catch {}
}

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function totalWordCount(): number {
  try {
    const tabs = useTabsStore();
    let sum = 0;
    for (const t of tabs.tabs) sum += cjkWordCount(t.content || '').total;
    return sum;
  } catch {
    return 0;
  }
}

function appendSession(rec: PomodoroSessionRecord) {
  try {
    const raw = localStorage.getItem(LS_SESSIONS);
    const arr: PomodoroSessionRecord[] = raw ? JSON.parse(raw) : [];
    arr.push(rec);
    localStorage.setItem(LS_SESSIONS, JSON.stringify(arr));
  } catch {}
}

export function setLastPreset(min: number) {
  try {
    localStorage.setItem(LS_LAST_PRESET, String(min));
  } catch {}
}

export function getLastPreset(): number {
  try {
    const v = localStorage.getItem(LS_LAST_PRESET);
    if (v) {
      const n = parseFloat(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {}
  return 25;
}

function fireNotification(title: string, body: string) {
  // Browser Notification API — works inside Tauri WKWebView once the user
  // grants permission. Async-await without blocking is fine; we ignore the
  // permission promise's rejection (best-effort).
  try {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') {
      new Notification(title, { body });
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then((p) => {
        if (p === 'granted') new Notification(title, { body });
      }).catch(() => {});
    }
  } catch {}
}

export const usePomodoroStore = defineStore('pomodoro', {
  state: (): PomodoroState => {
    const persisted = loadPersisted();
    const base: PomodoroState = {
      now: Date.now(),
      active: false,
      flashing: false,
    };
    if (persisted) {
      Object.assign(base, persisted);
      base.active = true;
    }
    return base;
  },
  getters: {
    /** Time remaining in ms. While paused, returns the snapshot. */
    remainingMs(state): number {
      if (!state.active) return 0;
      if (state.flashing) return 0;
      if (!state.startedAt || !state.durationMs) return 0;
      if (state.paused) return state.pausedRemainingMs ?? 0;
      const elapsed = state.now - state.startedAt;
      return Math.max(0, state.durationMs - elapsed);
    },
    /**
     * MM:SS for the pill. Always shows zero-padded minutes + seconds.
     * Long sessions (>=100 min) get 3-digit minutes — same number of
     * characters drift but never wraps the pill.
     */
    countdown(): string {
      const ms = (this as any).remainingMs as number;
      const total = Math.ceil(ms / 1000);
      const m = Math.floor(total / 60);
      const s = total % 60;
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    },
    running(state): boolean {
      return state.active && !state.flashing;
    },
    isPaused(state): boolean {
      return !!state.paused;
    },
    isBreak(state): boolean {
      return state.phase === 'break';
    },
  },
  actions: {
    _ensureTick() {
      if (tickHandle) return;
      tickHandle = setInterval(() => {
        this.now = Date.now();
        if (!this.active || this.flashing || this.paused) return;
        if (this.remainingMs <= 0) {
          this._finishPhase();
        }
      }, 1000);
    },
    _stopTick() {
      if (tickHandle) {
        clearInterval(tickHandle);
        tickHandle = null;
      }
    },
    _persist() {
      if (!this.active || this.flashing) {
        clearPersisted();
        return;
      }
      const s: PersistedState = {
        phase: this.phase as PomodoroPhase,
        startedAt: this.startedAt as number,
        durationMs: this.durationMs as number,
        paused: !!this.paused,
        pausedRemainingMs: this.pausedRemainingMs ?? 0,
        startWordCount: this.startWordCount as number,
        priorFocusMode: !!this.priorFocusMode,
        autoBreakNext: !!this.autoBreakNext,
        notifyOnEnd: !!this.notifyOnEnd,
      };
      savePersisted(s);
    },
    /**
     * Start a focus session. `minutes` accepts decimals (0.05 ≈ 3s) so the
     * dev-bridge self-test can drive a tiny session without waiting 25 min.
     *
     * `opts.autoBreak` — chain a 5-min break after this focus session.
     * `opts.notify` — fire a system notification when time's up.
     * `opts.engageFocusMode` — flip settings.focusMode on while running
     *   (defaults to settings.pomodoroAutoEngageFocus).
     */
    start(
      minutes: number,
      opts: { autoBreak?: boolean; notify?: boolean; engageFocusMode?: boolean } = {},
    ) {
      // Hard-stop any prior session before starting a new one.
      if (this.active) this._abort();
      const settings = useSettingsStore();
      const durationMs = Math.max(1, Math.round(minutes * 60 * 1000));
      const priorFocusMode = settings.focusMode;
      const engage = opts.engageFocusMode ?? settings.pomodoroAutoEngageFocus;
      if (engage && !settings.focusMode) {
        settings.focusMode = true;
        settings.persist();
      }
      this.phase = 'focus';
      this.startedAt = Date.now();
      this.durationMs = durationMs;
      this.paused = false;
      this.pausedRemainingMs = 0;
      this.startWordCount = totalWordCount();
      this.priorFocusMode = priorFocusMode;
      this.autoBreakNext = !!opts.autoBreak;
      this.notifyOnEnd = !!opts.notify;
      this.active = true;
      this.flashing = false;
      this.now = Date.now();
      setLastPreset(minutes);
      this._ensureTick();
      this._persist();
    },
    pause() {
      if (!this.active || this.flashing || this.paused) return;
      this.pausedRemainingMs = this.remainingMs;
      this.paused = true;
      this._persist();
    },
    resume() {
      if (!this.active || this.flashing || !this.paused) return;
      // Re-anchor startedAt so the existing remaining math keeps working.
      this.startedAt = Date.now() - (this.durationMs! - this.pausedRemainingMs!);
      this.paused = false;
      this.pausedRemainingMs = 0;
      this._persist();
    },
    togglePause() {
      if (this.paused) this.resume();
      else this.pause();
    },
    /** User-initiated stop. Does NOT chain a break and does NOT record a session. */
    stop() {
      this._abort();
    },
    /** Reset = stop. Kept as a separate action for the right-click menu UX. */
    reset() {
      this._abort();
    },
    _abort() {
      this._restoreFocusMode();
      this.active = false;
      this.flashing = false;
      this.paused = false;
      this.phase = undefined;
      this.startedAt = undefined;
      this.durationMs = undefined;
      this.pausedRemainingMs = 0;
      if (flashHandle) { clearTimeout(flashHandle); flashHandle = null; }
      this._stopTick();
      clearPersisted();
    },
    _restoreFocusMode() {
      try {
        const settings = useSettingsStore();
        // Only restore if we had flipped it on at start. If the user
        // toggled focus mode manually mid-session we DO still restore to
        // their pre-session preference — that's the documented contract.
        if (settings.focusMode !== this.priorFocusMode) {
          settings.focusMode = !!this.priorFocusMode;
          settings.persist();
        }
      } catch {}
    },
    _finishPhase() {
      const wasFocus = this.phase === 'focus';
      const durationMin = Math.round((this.durationMs ?? 0) / 60000);
      // Record stats only for focus phases.
      if (wasFocus) {
        const after = totalWordCount();
        const delta = Math.max(0, after - (this.startWordCount ?? after));
        appendSession({ date: todayIso(), durationMin, wordsWritten: delta });
      }
      const shouldNotify = !!this.notifyOnEnd && wasFocus;
      const willChainBreak = wasFocus && !!this.autoBreakNext;
      // Fire the green flash for 5s before either chaining or fully ending.
      this.flashing = true;
      this.paused = false;
      // Don't restore focus mode yet if we're chaining — keep it engaged
      // through the break.
      if (!willChainBreak) {
        this._restoreFocusMode();
      }
      clearPersisted();
      if (shouldNotify) {
        // Borrow tab name into the body if we have one, else just minutes.
        const wordsDelta = wasFocus
          ? Math.max(0, totalWordCount() - (this.startWordCount ?? 0))
          : 0;
        fireNotification(
          'SoloMD — focus session complete',
          `${durationMin} min · ${wordsDelta} words written`,
        );
      }
      if (flashHandle) clearTimeout(flashHandle);
      flashHandle = setTimeout(() => {
        flashHandle = null;
        if (willChainBreak) {
          this._startBreak();
        } else {
          this.active = false;
          this.flashing = false;
          this.phase = undefined;
          this._stopTick();
        }
      }, 5000);
    },
    _startBreak() {
      const breakMs = 5 * 60 * 1000;
      this.phase = 'break';
      this.startedAt = Date.now();
      this.durationMs = breakMs;
      this.paused = false;
      this.pausedRemainingMs = 0;
      this.flashing = false;
      // Break does NOT chain another break — set autoBreakNext false so
      // _finishPhase ends the cycle.
      this.autoBreakNext = false;
      this.notifyOnEnd = false; // breaks are silent by design
      this.now = Date.now();
      this._ensureTick();
      this._persist();
    },
    /**
     * Hydrate from localStorage on first store creation. Call once at
     * app boot — see App.vue. Safe to call repeatedly.
     */
    rehydrate() {
      const persisted = loadPersisted();
      if (!persisted) return;
      Object.assign(this, persisted);
      this.active = true;
      this.flashing = false;
      this.now = Date.now();
      // If the stored session has already elapsed past its end, finish it
      // immediately — better than showing a 00:00 pill forever.
      if (!persisted.paused) {
        const elapsed = Date.now() - persisted.startedAt;
        if (elapsed >= persisted.durationMs) {
          this._finishPhase();
          return;
        }
      }
      this._ensureTick();
    },
  },
});
