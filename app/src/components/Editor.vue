<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, computed } from 'vue';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches, search } from '@codemirror/search';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { LanguageDescription } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { html as htmlLang } from '@codemirror/lang-html';
import { css as cssLang } from '@codemirror/lang-css';
import { json as jsonLang } from '@codemirror/lang-json';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { go } from '@codemirror/lang-go';
import { yaml } from '@codemirror/lang-yaml';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { vim } from '@replit/codemirror-vim';
import { cmThemeFor } from '../lib/themes';
import { useTabsStore } from '../stores/tabs';
import { useSettingsStore, buildEditorFontStack } from '../stores/settings';
import type { Tab } from '../types';
import { livePreviewExtension, richHighlightOnly } from '../lib/cm-live-preview';
import { imagePasteExtension, insertImageFromPath as cmInsertImageFromPath } from '../lib/cm-image-paste';
import { focusModeExtension, typewriterModeExtension } from '../lib/cm-focus-mode';
import { taskListExtension } from '../lib/cm-task-list';
import {
  sessionRestoreExtension,
  readSession,
  clearSession,
} from '../lib/cm-session-restore';

const codeLanguages = [
  LanguageDescription.of({ name: 'javascript', alias: ['js', 'jsx'], support: javascript({ jsx: true }) }),
  LanguageDescription.of({ name: 'typescript', alias: ['ts', 'tsx'], support: javascript({ jsx: true, typescript: true }) }),
  LanguageDescription.of({ name: 'python', alias: ['py'], support: python() }),
  LanguageDescription.of({ name: 'rust', alias: ['rs'], support: rust() }),
  LanguageDescription.of({ name: 'html', support: htmlLang() }),
  LanguageDescription.of({ name: 'css', support: cssLang() }),
  LanguageDescription.of({ name: 'json', support: jsonLang() }),
  LanguageDescription.of({ name: 'cpp', alias: ['c', 'c++'], support: cpp() }),
  LanguageDescription.of({ name: 'java', support: java() }),
  LanguageDescription.of({ name: 'go', alias: ['golang'], support: go() }),
  LanguageDescription.of({ name: 'yaml', alias: ['yml'], support: yaml() }),
  LanguageDescription.of({ name: 'sql', support: sql() }),
  LanguageDescription.of({ name: 'xml', support: xml() }),
];

const props = withDefaults(
  defineProps<{
    tab: Tab;
    focusMode?: boolean;
    typewriterMode?: boolean;
    spellCheck?: boolean;
  }>(),
  {
    focusMode: false,
    typewriterMode: false,
    spellCheck: true,
  },
);
const emit = defineEmits<{ (e: 'cursor', line: number, col: number): void }>();

const tabs = useTabsStore();
const settings = useSettingsStore();

const host = ref<HTMLDivElement | null>(null);
let view: EditorView | null = null;

const themeCompartment = new Compartment();
const langCompartment = new Compartment();
const wrapCompartment = new Compartment();
const lineNumCompartment = new Compartment();
const fontSizeCompartment = new Compartment();
const richCompartment = new Compartment();
const spellCheckCompartment = new Compartment();
const focusCompartment = new Compartment();
const typewriterCompartment = new Compartment();
const vimCompartment = new Compartment();

function markdownExt() {
  // Use `markdownLanguage` as the base so GFM features (including task
  // list parsing with TaskMarker nodes) are enabled.
  return markdown({ base: markdownLanguage, codeLanguages, addKeymap: true });
}

function spellCheckExt(on: boolean) {
  return EditorView.contentAttributes.of({ spellcheck: on ? 'true' : 'false' });
}

function richExtensionsFor(tab: Tab) {
  if (tab.language !== 'markdown') return [];
  return settings.livePreview ? livePreviewExtension() : richHighlightOnly();
}

const fontSizeTheme = (px: number, family: string) =>
  EditorView.theme({
    '&': { fontSize: `${px}px`, height: '100%' },
    '.cm-scroller': { fontFamily: buildEditorFontStack(family), lineHeight: '1.6' },
    '.cm-content': { padding: '12px 16px' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      border: 'none',
      color: 'var(--text-faint)',
    },
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--accent)' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
    '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(255,159,64,0.25) !important' },
  });

function buildExtensions() {
  return [
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    lineNumCompartment.of(settings.showLineNumbers ? lineNumbers() : []),
    wrapCompartment.of(settings.wordWrap ? EditorView.lineWrapping : []),
    langCompartment.of(props.tab.language === 'markdown' ? [markdownExt()] : []),
    richCompartment.of(richExtensionsFor(props.tab)),
    themeCompartment.of(cmThemeFor(settings.theme)),
    vimCompartment.of(settings.vimMode ? vim() : []),
    fontSizeCompartment.of(fontSizeTheme(settings.fontSize, settings.fontFamily)),
    spellCheckCompartment.of(spellCheckExt(props.spellCheck)),
    focusCompartment.of(props.focusMode ? focusModeExtension() : []),
    typewriterCompartment.of(props.typewriterMode ? typewriterModeExtension() : []),
    imagePasteExtension({ getFilePath: () => props.tab.filePath }),
    taskListExtension(),
    sessionRestoreExtension(props.tab.id),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        const text = u.state.doc.toString();
        tabs.setContent(props.tab.id, text);
      }
      if (u.selectionSet || u.docChanged) {
        const head = u.state.selection.main.head;
        const line = u.state.doc.lineAt(head);
        emit('cursor', line.number, head - line.from + 1);
      }
    }),
  ];
}

function maybeRestoreSession() {
  if (!view) return;
  const saved = readSession(props.tab.id);
  if (
    saved &&
    saved !== '' &&
    props.tab.content === '' &&
    view.state.doc.length === 0 &&
    saved !== view.state.doc.toString()
  ) {
    view.dispatch({ changes: { from: 0, to: 0, insert: saved } });
  }
}

onMounted(() => {
  if (!host.value) return;
  view = new EditorView({
    state: EditorState.create({ doc: props.tab.content, extensions: buildExtensions() }),
    parent: host.value,
  });
  maybeRestoreSession();
});

onBeforeUnmount(() => {
  view?.destroy();
  view = null;
});

// Switching tabs: replace doc (and rebuild extensions so the
// session-restore plugin is recreated with the new tab id).
watch(
  () => props.tab.id,
  () => {
    if (!view) return;
    view.setState(
      EditorState.create({ doc: props.tab.content, extensions: buildExtensions() })
    );
    maybeRestoreSession();
  }
);

// Clean-save watcher: when the buffer matches savedContent, drop any
// stale session snapshot for this tab.
watch(
  () => [props.tab.content, props.tab.savedContent] as const,
  ([content, saved]) => {
    if (content === saved) clearSession(props.tab.id);
  },
);

watch(
  () => props.spellCheck,
  (v) => {
    view?.dispatch({
      effects: spellCheckCompartment.reconfigure(spellCheckExt(v)),
    });
  },
);

watch(
  () => props.focusMode,
  (v) => {
    view?.dispatch({
      effects: focusCompartment.reconfigure(v ? focusModeExtension() : []),
    });
  },
);

watch(
  () => props.typewriterMode,
  (v) => {
    view?.dispatch({
      effects: typewriterCompartment.reconfigure(
        v ? typewriterModeExtension() : [],
      ),
    });
  },
);

// External content updates (e.g. after Save replacing savedContent only — content stays).
watch(
  () => props.tab.content,
  (next) => {
    if (!view) return;
    if (view.state.doc.toString() !== next) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
      });
    }
  }
);

watch(
  () => settings.theme,
  (t) => {
    view?.dispatch({ effects: themeCompartment.reconfigure(cmThemeFor(t)) });
  }
);

watch(
  () => settings.vimMode,
  (v) => {
    view?.dispatch({ effects: vimCompartment.reconfigure(v ? vim() : []) });
  }
);

watch(
  () => settings.wordWrap,
  (w) => {
    view?.dispatch({ effects: wrapCompartment.reconfigure(w ? EditorView.lineWrapping : []) });
  }
);

watch(
  () => settings.showLineNumbers,
  (s) => {
    view?.dispatch({ effects: lineNumCompartment.reconfigure(s ? lineNumbers() : []) });
  }
);

watch(
  [() => settings.fontSize, () => settings.fontFamily],
  ([n, f]) => {
    view?.dispatch({ effects: fontSizeCompartment.reconfigure(fontSizeTheme(n, f)) });
  }
);

watch(
  () => props.tab.language,
  (l) => {
    view?.dispatch({
      effects: [
        langCompartment.reconfigure(l === 'markdown' ? [markdownExt()] : []),
        richCompartment.reconfigure(richExtensionsFor(props.tab)),
      ],
    });
  }
);

watch(
  () => settings.livePreview,
  () => {
    view?.dispatch({ effects: richCompartment.reconfigure(richExtensionsFor(props.tab)) });
  }
);

function gotoLine(line: number) {
  if (!view) return;
  const safe = Math.max(1, Math.min(line, view.state.doc.lines));
  const lineObj = view.state.doc.line(safe);
  view.dispatch({
    selection: { anchor: lineObj.from },
    effects: EditorView.scrollIntoView(lineObj.from, { y: 'start', yMargin: 40 }),
  });
  view.focus();
}

async function insertImageFromPath(srcPath: string): Promise<void> {
  if (!view) return;
  await cmInsertImageFromPath(view, srcPath, {
    getFilePath: () => props.tab.filePath,
  });
}

/** Returns the 1-indexed line currently at the top of the visible viewport. */
function getViewLine(): number | null {
  if (!view) return null;
  const top = view.scrollDOM.scrollTop;
  const block = view.lineBlockAtHeight(top);
  return view.state.doc.lineAt(block.from).number;
}

/** Scroll the given 1-indexed line to the top of the viewport (without moving cursor). */
function scrollToLine(line: number): void {
  if (!view) return;
  const safe = Math.max(1, Math.min(line, view.state.doc.lines));
  const lineObj = view.state.doc.line(safe);
  view.dispatch({
    effects: EditorView.scrollIntoView(lineObj.from, { y: 'start', yMargin: 8 }),
  });
}

defineExpose({ gotoLine, insertImageFromPath, getViewLine, scrollToLine });

const cls = computed(() => ({
  'cm-host': true,
  'cm-host--dark': settings.theme === 'dark',
}));
</script>

<template>
  <div :class="cls" ref="host"></div>
</template>

<style scoped>
.cm-host {
  height: 100%;
  width: 100%;
  overflow: hidden;
  background: var(--bg);
}
:deep(.cm-editor) {
  height: 100%;
  outline: none;
}
:deep(.cm-editor.cm-focused) {
  outline: none;
}
</style>
