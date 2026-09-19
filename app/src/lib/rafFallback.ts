/**
 * requestAnimationFrame fallback for WebKitGTK environments.
 *
 * In Tauri v2 AppImage builds on Linux, WebKitGTK's requestAnimationFrame
 * may stop firing under certain graphics stack conditions (Mesa 25+
 * libwayland mismatch, DMABUF renderer issues). CodeMirror 6 relies on
 * rAF to schedule its measure() phase which syncs EditorState to the
 * DOM — when rAF stalls, the editor state is correctly updated
 * (forceFlush on keydown is synchronous) but the view never repaints.
 *
 * This module wraps the native rAF with a setTimeout fallback: if the
 * native callback hasn't fired after 100 ms, the fallback fires it.
 * When rAF works normally the timers are immediately cleared and the
 * wrapper has zero behavioural impact.
 *
 * Must be installed BEFORE any CodeMirror EditorView is created.
 */

let installed = false;

function installRAFFallback(): void {
  if (installed) return;
  installed = true;

  const nativeRAF = window.requestAnimationFrame.bind(window);
  const nativeCAF = window.cancelAnimationFrame.bind(window);

  const fallbackTimers = new Map<number, ReturnType<typeof setTimeout>>();

  window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    const rafId = nativeRAF((time: DOMHighResTimeStamp) => {
      const timer = fallbackTimers.get(rafId);
      if (timer !== undefined) {
        clearTimeout(timer);
        fallbackTimers.delete(rafId);
      }
      callback(time);
    });
    const timer = setTimeout(() => {
      if (fallbackTimers.has(rafId)) {
        fallbackTimers.delete(rafId);
        callback(performance.now());
      }
    }, 100);
    fallbackTimers.set(rafId, timer);
    return rafId;
  };

  window.cancelAnimationFrame = (handle: number): void => {
    const timer = fallbackTimers.get(handle);
    if (timer !== undefined) {
      clearTimeout(timer);
      fallbackTimers.delete(handle);
    }
    nativeCAF(handle);
  };
}

export { installRAFFallback };