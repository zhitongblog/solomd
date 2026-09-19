import { installRAFFallback } from './lib/rafFallback';
installRAFFallback();

import { createApp, defineAsyncComponent } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './styles/cjk-font.css';
import './styles/main.css';
import './styles/hljs-theme.css';
import 'katex/dist/katex.min.css';

const params = new URLSearchParams(window.location.search);
const isSlideshow = params.get('slideshow') === '1';
// The quick-capture box is a second webview on the same bundle rather than a
// separate entry point: it needs the settings and workspace stores (theme,
// language, current folder) and gets them from the shared localStorage for
// free this way.
const isQuickCapture = params.get('quickCapture') === '1';

// Both alternate roots are chosen by a URL param that the main window never
// carries, so they are loaded on demand — keeping reveal.js and the capture
// box out of the entry chunk every normal launch has to compile.
const rootComponent = isSlideshow
  ? defineAsyncComponent(() => import('./components/Slideshow.vue'))
  : isQuickCapture
    ? defineAsyncComponent(() => import('./components/QuickCapture.vue'))
    : App;
const app = createApp(rootComponent);
app.use(createPinia());
app.mount('#app');
