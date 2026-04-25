import { useSettingsStore } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import welcomeEn from '../assets/welcome/welcome.en.md?raw';
import syntaxEn from '../assets/welcome/syntax.en.md?raw';
import slideshowEn from '../assets/welcome/slideshow.en.md?raw';
import shortcutsEn from '../assets/welcome/shortcuts.en.md?raw';
import liveEditDemoEn from '../assets/welcome/live-edit-demo.en.md?raw';
import welcomeZh from '../assets/welcome/welcome.zh.md?raw';
import syntaxZh from '../assets/welcome/syntax.zh.md?raw';
import slideshowZh from '../assets/welcome/slideshow.zh.md?raw';
import shortcutsZh from '../assets/welcome/shortcuts.zh.md?raw';
import liveEditDemoZh from '../assets/welcome/live-edit-demo.zh.md?raw';

export function openWelcomeTour(): void {
  const settings = useSettingsStore();
  const tabs = useTabsStore();
  const zh = settings.language === 'zh';
  const docs = zh
    ? [
        { name: '欢迎.md', content: welcomeZh },
        { name: 'Markdown 语法.md', content: syntaxZh },
        { name: '实时编辑.md', content: liveEditDemoZh },
        { name: '演讲模式.md', content: slideshowZh },
        { name: '快捷键.md', content: shortcutsZh },
      ]
    : [
        { name: 'Welcome.md', content: welcomeEn },
        { name: 'Markdown syntax.md', content: syntaxEn },
        { name: 'Live edit demo.md', content: liveEditDemoEn },
        { name: 'Slideshow.md', content: slideshowEn },
        { name: 'Shortcuts.md', content: shortcutsEn },
      ];
  let firstId: string | undefined;
  for (const d of docs) {
    const tab = tabs.newTab({ fileName: d.name, language: 'markdown' });
    tab.content = d.content;
    tab.savedContent = d.content;
    if (!firstId) firstId = tab.id;
  }
  if (firstId) tabs.activate(firstId);
}
