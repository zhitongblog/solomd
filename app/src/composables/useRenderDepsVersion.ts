import { onBeforeUnmount, ref, type Ref } from 'vue';
import { onRenderDepsChange, renderDepsVersion } from '../lib/render-deps';

/**
 * `renderDepsVersion()` as a ref: read it inside a computed that calls
 * `renderMarkdown()` and the computed re-runs when KaTeX / highlight.js
 * finish loading, swapping placeholder source for typeset math and coloured
 * code (lib/render-deps.ts).
 */
export function useRenderDepsVersion(): Ref<number> {
  const version = ref(renderDepsVersion());
  const off = onRenderDepsChange(() => {
    version.value = renderDepsVersion();
  });
  onBeforeUnmount(off);
  return version;
}
