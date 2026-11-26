import { useSettingsStore } from '../stores/settings';
import { useTabsStore } from '../stores/tabs';
import welcomeEn from '../assets/welcome/welcome.en.md?raw';
import syntaxEn from '../assets/welcome/syntax.en.md?raw';
import slideshowEn from '../assets/welcome/slideshow.en.md?raw';
import liveEditDemoEn from '../assets/welcome/live-edit-demo.en.md?raw';
import welcomeZh from '../assets/welcome/welcome.zh.md?raw';
import syntaxZh from '../assets/welcome/syntax.zh.md?raw';
import slideshowZh from '../assets/welcome/slideshow.zh.md?raw';
import liveEditDemoZh from '../assets/welcome/live-edit-demo.zh.md?raw';

export type WelcomeTourDocKey = 'welcome' | 'syntax' | 'liveEdit' | 'slideshow';

function getTourDocs(zh: boolean): Array<{ key: WelcomeTourDocKey; name: string; content: string }> {
  return zh
    ? [
        { key: 'welcome', name: '欢迎.md', content: welcomeZh },
        { key: 'syntax', name: 'Markdown 语法.md', content: syntaxZh },
        { key: 'liveEdit', name: '实时编辑.md', content: liveEditDemoZh },
        { key: 'slideshow', name: '演讲模式.md', content: slideshowZh },
      ]
    : [
        { key: 'welcome', name: 'Welcome.md', content: welcomeEn },
        { key: 'syntax', name: 'Markdown syntax.md', content: syntaxEn },
        { key: 'liveEdit', name: 'Live edit demo.md', content: liveEditDemoEn },
        { key: 'slideshow', name: 'Slideshow.md', content: slideshowEn },
      ];
}

function openSingleDoc(d: { name: string; content: string }): string {
  const tabs = useTabsStore();
  const normalized = d.content.replace(/\r\n/g, '\n');
  const existing = tabs.tabs.find((t) => !t.filePath && t.fileName === d.name);
  if (existing) {
    existing.content = normalized;
    existing.savedContent = normalized;
    existing.ephemeral = true;
    return existing.id;
  }
  const tab = tabs.newTab({ fileName: d.name, language: 'markdown' });
  tab.content = normalized;
  tab.savedContent = normalized;
  tab.ephemeral = true;
  return tab.id;
}

/** #723 — Open a single Welcome Tour document from the Help › Welcome Tour submenu. */
export function openWelcomeTourDoc(key: WelcomeTourDocKey): void {
  const settings = useSettingsStore();
  const tabs = useTabsStore();
  const docs = getTourDocs(settings.language === 'zh');
  const doc = docs.find((d) => d.key === key) ?? docs[0];
  const id = openSingleDoc(doc);
  tabs.activate(id);
}

export function openWelcomeTour(): void {
  const settings = useSettingsStore();
  const tabs = useTabsStore();
  const docs = getTourDocs(settings.language === 'zh');
  let firstId: string | undefined;
  for (const d of docs) {
    const id = openSingleDoc(d);
    if (!firstId) firstId = id;
  }
  if (firstId) tabs.activate(firstId);
}
