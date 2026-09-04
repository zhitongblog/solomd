/**
 * Whether the quick-capture hotkey actually got registered.
 *
 * Registration happens in Rust and can fail for one boring reason: another
 * application already owns the chord. That is not an error to interrupt anyone
 * with — nothing is broken and the app works — but it must be visible
 * somewhere, or the feature just silently does nothing and looks broken.
 * App.vue writes here, Settings reads it next to the shortcut field.
 */
import { ref } from 'vue';

export const quickCaptureError = ref('');
