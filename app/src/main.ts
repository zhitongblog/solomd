import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import Slideshow from './components/Slideshow.vue';
import QuickCapture from './components/QuickCapture.vue';
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

const rootComponent = isSlideshow ? Slideshow : isQuickCapture ? QuickCapture : App;
const app = createApp(rootComponent);
app.use(createPinia());
app.mount('#app');
