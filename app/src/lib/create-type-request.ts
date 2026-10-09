import { ref } from 'vue';

/**
 * "New Type…" was asked for. The dialog lives in TypesPanel, which is not
 * mounted while the right sidebar is hidden (the 5.0 default) — an event
 * fired at it was simply lost. The command sets this; the panel opens the
 * dialog when it mounts, or right away if it is already up.
 */
export const createTypeRequested = ref(false);
