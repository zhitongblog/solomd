import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import Slideshow from './components/Slideshow.vue';
import './styles/cjk-font.css';
import './styles/main.css';
import './styles/hljs-theme.css';
import 'katex/dist/katex.min.css';

const params = new URLSearchParams(window.location.search);
const isSlideshow = params.get('slideshow') === '1';

const app = createApp(isSlideshow ? Slideshow : App);
app.use(createPinia());
app.mount('#app');
