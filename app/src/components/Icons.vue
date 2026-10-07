<script setup lang="ts">
defineProps<{ name: string; size?: number }>();
</script>

<template>
  <svg
    :width="size ?? 16"
    :height="size ?? 16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <template v-if="name === 'new'">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <line x1="9" y1="14" x2="15" y2="14" />
    </template>
    <template v-else-if="name === 'new-text'">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="13" y2="17" />
    </template>
    <template v-else-if="name === 'open'">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </template>
    <template v-else-if="name === 'save'">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </template>
    <template v-else-if="name === 'save-as'">
      <rect x="3" y="3" width="13" height="13" rx="1" />
      <polyline points="13 3 13 8 5 8" />
      <rect x="8" y="12" width="13" height="9" rx="1" fill="var(--bg)" stroke="currentColor" />
      <polyline points="18 12 18 16 11 16" />
      <line x1="11" y1="19" x2="18" y2="19" />
    </template>
    <template v-else-if="name === 'folder'">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </template>
    <template v-else-if="name === 'recent'">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </template>
    <template v-else-if="name === 'export'">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </template>
    <template v-else-if="name === 'sidebar'">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </template>
    <template v-else-if="name === 'sidebar-right'">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="15" y1="3" x2="15" y2="21" />
    </template>
    <template v-else-if="name === 'outline'">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </template>
    <template v-else-if="name === 'palette'">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </template>
    <template v-else-if="name === 'help'">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </template>
    <template v-else-if="name === 'settings'">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </template>
    <template v-else-if="name === 'theme-light'">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </template>
    <template v-else-if="name === 'theme-dark'">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </template>
    <template v-else-if="name === 'live'">
      <!-- Magic wand: indicates live / transforming render -->
      <path d="M15 4V2" />
      <path d="M15 16v-2" />
      <path d="M8 9h2" />
      <path d="M20 9h2" />
      <path d="M17.8 11.8 19 13" />
      <path d="M15 9h.01" />
      <path d="M17.8 6.2 19 5" />
      <path d="m3 21 9-9" />
      <path d="M12.2 6.2 11 5" />
    </template>
    <template v-else-if="name === 'source'">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </template>
    <template v-else-if="name === 'chevron-down'">
      <polyline points="6 9 12 15 18 9" />
    </template>
    <template v-else-if="name === 'close'">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </template>
    <template v-else-if="name === 'fit-width'">
      <line x1="2" y1="12" x2="22" y2="12" />
      <polyline points="6 8 2 12 6 16" />
      <polyline points="18 8 22 12 18 16" />
    </template>
    <template v-else-if="name === 'view-edit'">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </template>
    <template v-else-if="name === 'view-split'">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="12" y1="3" x2="12" y2="21" />
    </template>
    <template v-else-if="name === 'view-preview'">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </template>
    <template v-else-if="name === 'view-live'">
      <!-- pen-on-paper: distinct from "view-edit" (which is also a pen
           but on a notebook). Communicates "live / inline rendering".
           A document with a pen tip writing on it. -->
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
      <line x1="8" y1="9" x2="13" y2="9" />
      <line x1="8" y1="13" x2="11" y2="13" />
      <path d="M19 2.5a1.8 1.8 0 0 1 2.5 2.5L16 11l-3 1 1-3 5-6.5z" />
    </template>
    <template v-else-if="name === 'focus'">
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="2" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="2" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="22" y2="12" />
    </template>
    <template v-else-if="name === 'typewriter'">
      <rect x="2" y="4" width="20" height="12" rx="2" />
      <line x1="6" y1="20" x2="18" y2="20" />
      <line x1="12" y1="16" x2="12" y2="20" />
    </template>
    <template v-else-if="name === 'spellcheck'">
      <path d="M7 20l4-16h2l4 16" />
      <line x1="9" y1="14" x2="15" y2="14" />
      <polyline points="16 18 19 21 23 15" />
    </template>
    <template v-else-if="name === 'search'">
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </template>
    <template v-else-if="name === 'insert'">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </template>
    <template v-else-if="name === 'view-reading'">
      <!-- An open book — denotes "reading mode": full-bleed prose preview.
           Distinct from view-preview (an eye, which we use for the rendered-
           preview pane). Two facing pages with a center spine. -->
      <path d="M2 5h7a3 3 0 0 1 3 3v12a2 2 0 0 0-2-2H2z" />
      <path d="M22 5h-7a3 3 0 0 0-3 3v12a2 2 0 0 1 2-2h8z" />
    </template>
    <template v-else-if="name === 'external'">
      <!-- Open in external app: a square with an arrow pointing out -->
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </template>
    <!-- v4.6 F2 — curated type-section icons (types-as-lenses). -->
    <template v-else-if="name === 'type-project'">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="3" y1="9" x2="21" y2="9" />
      <line x1="8" y1="4" x2="8" y2="9" />
    </template>
    <template v-else-if="name === 'type-person'">
      <circle cx="12" cy="8" r="4" />
      <path d="M5 21a7 7 0 0 1 14 0" />
    </template>
    <template v-else-if="name === 'type-meeting'">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <line x1="16" y1="3" x2="16" y2="7" />
      <line x1="8" y1="3" x2="8" y2="7" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </template>
    <template v-else-if="name === 'type-idea'">
      <path d="M9 18h6" />
      <path d="M10 21h4" />
      <path d="M12 3a6 6 0 0 1 4 10.5c-.7.6-1 1.2-1 2V16H9v-.5c0-.8-.3-1.4-1-2A6 6 0 0 1 12 3z" />
    </template>
    <template v-else-if="name === 'type-book'">
      <path d="M4 4a2 2 0 0 1 2-2h13v18H6a2 2 0 0 0-2 2z" />
      <line x1="9" y1="6" x2="15" y2="6" />
    </template>
    <template v-else-if="name === 'type-generic'">
      <path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" />
      <line x1="12" y1="4" x2="12" y2="20" />
      <line x1="9" y1="20" x2="15" y2="20" />
    </template>
    <!-- Fallback: any `type-*` name we don't have a bespoke glyph for renders
         the generic "type" tag glyph so an unknown frontmatter `icon:` value
         never produces an empty box. Non-type names keep their prior
         (empty-svg) behaviour to avoid changing existing call sites. -->
    <template v-else-if="name && name.startsWith('type-')">
      <path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" />
      <line x1="12" y1="4" x2="12" y2="20" />
      <line x1="9" y1="20" x2="15" y2="20" />
    </template>
    <template v-else-if="name === 'today'">
      <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5" />
    </template>
    <template v-else-if="name === 'inbox'">
      <path d="M4 13l2-8h12l2 8" /><path d="M4 13v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5h-5a3 3 0 0 1-6 0H4z" />
    </template>
    <template v-else-if="name === 'chevron-right'">
      <path d="M9 6l6 6-6 6" />
    </template>
    <template v-else-if="name === 'chevron-left'">
      <path d="M15 6l-6 6 6 6" />
    </template>
    <template v-else-if="name === 'more'">
      <circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" />
    </template>
    <template v-else-if="name === 'bold'">
      <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7z" /><path d="M7 12h7a3.5 3.5 0 0 1 0 7H7z" />
    </template>
    <template v-else-if="name === 'italic'">
      <path d="M14 5h-4M14 19h-4M14 5l-4 14" />
    </template>
    <template v-else-if="name === 'code'">
      <path d="M8 8l-4 4 4 4M16 8l4 4-4 4" />
    </template>
    <template v-else-if="name === 'link'">
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </template>
    <template v-else-if="name === 'heading'">
      <path d="M6 5v14M18 5v14M6 12h12" />
    </template>
    <template v-else-if="name === 'list'">
      <path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1" /><circle cx="4.5" cy="12" r="1" /><circle cx="4.5" cy="18" r="1" />
    </template>
    <template v-else-if="name === 'task'">
      <rect x="4" y="4" width="16" height="16" rx="4" /><path d="M8 12l3 3 5-6" />
    </template>
    <template v-else-if="name === 'image'">
      <rect x="3" y="5" width="18" height="14" rx="3" /><circle cx="9" cy="10" r="1.6" /><path d="M21 16l-5-5-8 8" />
    </template>
    <template v-else-if="name === 'undo'">
      <path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" />
    </template>
    <template v-else-if="name === 'redo'">
      <path d="M15 14l5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h3" />
    </template>
    <template v-else-if="name === 'keyboard-hide'">
      <rect x="2" y="5" width="20" height="11" rx="2" /><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M7 12.5h10M9 19.5l3 2 3-2" />
    </template>
    <template v-else-if="name === 'sparkle'">
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
    </template>
    <template v-else-if="name === 'sync'">
      <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" /><path d="M20 20v-4h-4" />
    </template>
    <template v-else-if="name === 'check'">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </template>
    <template v-else-if="name === 'check-circle'">
      <circle cx="12" cy="12" r="9" /><path d="M8.5 12.5l2.5 2.5 4.5-5" />
    </template>
    <template v-else-if="name === 'tag'">
      <path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9-9-9z" /><circle cx="8" cy="8" r="1.4" />
    </template>
    <template v-else-if="name === 'plus'">
      <path d="M12 5v14M5 12h14" />
    </template>
    <template v-else-if="name === 'sort'">
      <path d="M7 4v16M4 7l3-3 3 3M17 20V4M14 17l3 3 3-3" />
    </template>
    <template v-else-if="name === 'filter'">
      <path d="M4 5h16l-6 8v5l-4 2v-7z" />
    </template>
    <template v-else-if="name === 'refresh'">
      <path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" />
    </template>
    <template v-else-if="name === 'home'">
      <path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1v-8z" />
    </template>
    <template v-else-if="name === 'share'">
      <path d="M12 3v12M8 7l4-4 4 4" /><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </template>
    <template v-else-if="name === 'file'">
      <path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M14 3v5h5" />
    </template>
    <template v-else-if="name === 'folder-sm'">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </template>
    <template v-else-if="name === 'eye'">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />
    </template>
    <template v-else-if="name === 'pencil'">
      <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </template>
    <template v-else-if="name === 'trash'">
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    </template>
    <template v-else-if="name === 'quote'">
      <path d="M7 7h4v4c0 3-2 5-4 6M15 7h4v4c0 3-2 5-4 6" />
    </template>
    <template v-else-if="name === 'command'">
      <path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z" />
    </template>
    <template v-else-if="name === 'globe'">
      <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </template>
    <template v-else-if="name === 'cloud'">
      <path d="M7 18a4.5 4.5 0 0 1-.5-9A6 6 0 0 1 18 8.5 4.75 4.75 0 0 1 17.5 18z" />
    </template>
    <template v-else-if="name === 'plug'">
      <path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0zM12 16v5" />
    </template>
    <template v-else-if="name === 'keyboard'">
      <rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </template>
    <template v-else-if="name === 'wrench'">
      <path d="M14.7 6.3a4 4 0 0 0 5 5L21 13l-8 8-2-2 1.3-1.3a4 4 0 0 0-5-5L3 11l2-2 1.3 1.3" />
    </template>
    <template v-else-if="name === 'type'">
      <path d="M5 6V5h14v1M12 5v14M9 19h6" />
    </template>
    <template v-else-if="name === 'cpu'">
      <rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
    </template>
    <template v-else-if="name === 'info'">
      <circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" />
    </template>
    <template v-else-if="name === 'download'">
      <path d="M12 3v12M8 11l4 4 4-4" /><path d="M5 19h14" />
    </template>
    <template v-else-if="name === 'star'">
      <path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" />
    </template>
    <template v-else-if="name === 'heart'">
      <path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z" />
    </template>
    <template v-else-if="name === 'alert'">
      <path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17h.01" />
    </template>
    <template v-else-if="name === 'file-changed'">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <polyline points="14 3 14 8 19 8" />
      <path d="M9.5 15.5a3 3 0 0 0 5-1.5M14.5 12.5a3 3 0 0 0-5 1.5" />
    </template>
  </svg>
</template>
