import { defineStore } from 'pinia';

/**
 * 5.0 phone shell (docs/v5-ui-spec.md §8). On a phone-width viewport the app
 * is a stack of full-screen views instead of side-by-side columns:
 *
 *   home    — 笔记: search, 今天 / 收件箱 / 最近, the folder tree, new note
 *   search  — full-text search across the folder
 *   editor  — the open note (also hosts the inbox / views pages)
 *
 * The bottom bar switches between home, search, inbox and settings; opening
 * a note moves to `editor`, and the header's back button returns home.
 * Desktop and tablet ignore this store entirely.
 */
export type PhoneView = 'home' | 'search' | 'editor';

export const usePhoneStore = defineStore('phone', {
  state: () => ({ view: 'home' as PhoneView }),
  actions: {
    show(view: PhoneView) {
      this.view = view;
    },
  },
});
