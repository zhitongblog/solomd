import { defineStore } from 'pinia';

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  timeout: number;
}

let nextId = 1;

export const useToastsStore = defineStore('toasts', {
  state: () => ({
    items: [] as Toast[],
  }),
  actions: {
    push(message: string, kind: ToastKind = 'info', timeout = 2800) {
      const id = nextId++;
      this.items.push({ id, message, kind, timeout });
      if (timeout > 0) {
        setTimeout(() => this.dismiss(id), timeout);
      }
      return id;
    },
    success(message: string, timeout = 2200) {
      return this.push(message, 'success', timeout);
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
      this.items = this.items.filter((t) => t.id !== id);
    },
  },
});
