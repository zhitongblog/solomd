import { defineStore } from 'pinia';

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  timeout: number;
  /** When set, clicking the toast runs this instead of the default
   *  copy-message behavior (e.g. the update toast opens the download page). */
  onClick?: () => void;
  /** Renders `onClick` as an explicit button with this label. A toast whose
   *  action the user is meant to notice — "Undo" — cannot rely on the whole
   *  surface being secretly clickable. */
  actionLabel?: string;
  /** Runs when the toast goes away without the action being taken (timeout or
   *  a manual dismiss). "Undo" needs this: the delete it is holding back has
   *  to happen once the offer expires. */
  onExpire?: () => void;
}

let nextId = 1;

export const useToastsStore = defineStore('toasts', {
  state: () => ({
    items: [] as Toast[],
  }),
  actions: {
    push(
      message: string,
      kind: ToastKind = 'info',
      timeout = 2800,
      onClick?: () => void,
      extra?: { actionLabel?: string; onExpire?: () => void },
    ) {
      const id = nextId++;
      this.items.push({
        id,
        message,
        kind,
        timeout,
        onClick,
        actionLabel: extra?.actionLabel,
        onExpire: extra?.onExpire,
      });
      if (timeout > 0) {
        setTimeout(() => this.dismiss(id), timeout);
      }
      return id;
    },
    success(message: string, timeout = 2200, onClick?: () => void) {
      return this.push(message, 'success', timeout, onClick);
    },
    error(message: string, timeout = 5000) {
      return this.push(message, 'error', timeout);
    },
    info(message: string, timeout = 2800) {
      return this.push(message, 'info', timeout);
    },
    warning(message: string, timeout = 3500) {
      return this.push(message, 'warning', timeout);
    },
    dismiss(id: number) {
      const gone = this.items.find((t) => t.id === id);
      this.items = this.items.filter((t) => t.id !== id);
      gone?.onExpire?.();
    },
    /** Dismiss without running `onExpire` — the action was taken instead. */
    resolve(id: number) {
      this.items = this.items.filter((t) => t.id !== id);
    },
  },
});
