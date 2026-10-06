import { LogicalPosition } from '@tauri-apps/api/dpi';
import { isMacOS, isWindowsDesktop } from './platform';

/**
 * Chrome options for windows created at runtime, so every SoloMD window looks
 * like the main one (tauri.conf.json): on macOS the traffic lights float over
 * our 52px header line; Windows is frameless with our own title bar.
 */
export function windowChromeOptions() {
  if (isMacOS()) {
    return {
      titleBarStyle: 'overlay' as const,
      hiddenTitle: true,
      trafficLightPosition: new LogicalPosition(20, 20),
    };
  }
  return { decorations: !isWindowsDesktop() };
}
