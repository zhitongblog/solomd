import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './styles/cjk-font.css';
import './styles/main.css';
import './styles/hljs-theme.css';
import 'katex/dist/katex.min.css';

const app = createApp(App);
app.use(createPinia());
app.mount('#app');
