// Every language's what's-new prose, keyed by locale.
import type { WhatsNewData } from './types';
import en from './en';
import zh from './zh';
import de from './de';
import es from './es';
import fr from './fr';

export const whatsNew: Partial<Record<string, WhatsNewData>> & { en: WhatsNewData } = {
  en,
  zh,
  de,
  es,
  fr,
  ja: {
    ...en,
    meta: {
      title: 'SoloMD {VERSION} の新機能 — リリースノート v4.0 – v5.2',
      description: 'SoloMD {VERSION} リリースノート。純粋 WYSIWYG モード、9 形式統合エクスポートセンター（Pandoc 不要）、5 プラットフォーム暗号化同期、OPR ローカル AI 自動検出 + 20+ BYOK プロバイダー、16 ツール MCP サーバー。',
    },
    breadcrumb: { home: 'ホーム', current: '新機能' },
    hero: {
      date: '2026 年 11 月',
      h1: 'より静かに、深く書くための場所。',
      lead: 'v5.2 は Typora のような静かな書き心地（純粋 WYSIWYG モード）に、Pandoc 不要の 9 形式エクスポート、5 プラットフォーム対応の暗号化同期、ローカル AI 自動検出（Ollama / LM Studio）と 16 ツール MCP サーバーを統合しました。',
    },
    cta: ['⬇ v{VERSION} をダウンロード (Mac)', 'ダウンロード (Windows)', 'すべてのプラットフォーム →'],
  },
  ko: {
    ...en,
    meta: {
      title: 'SoloMD {VERSION} 새소식 — 릴리스 노트 v4.0 – v5.2',
      description: 'SoloMD {VERSION} 릴리스 노트. 순수 WYSIWYG 모드, Pandoc 설치가 필요 없는 9가지 포맷 통합 내보내기 센터, 5대 플랫폼 암호화 동기화, 로컬 AI 자동 감지(OPR) 및 16개 도구 MCP 서버.',
    },
    breadcrumb: { home: '홈', current: '새소식' },
    hero: {
      date: '2026년 11월',
      h1: '더 차분하게 글에 집중하는 공간.',
      lead: 'v5.2는 Typora처럼 차분한 순수 WYSIWYG 편집 경험에 9가지 포맷 내보내기 센터, 5대 플랫폼 종단간 암호화 동기화, 로컬 AI(Ollama / LM Studio) 자동 감지 및 MCP 서버를 하나로 통합했습니다.',
    },
    cta: ['⬇ v{VERSION} 다운로드 (Mac)', '다운로드 (Windows)', '모든 플랫폼 →'],
  },
  pt: {
    ...en,
    meta: {
      title: 'Novidades do SoloMD {VERSION} — notas de versão v4.0 – v5.2',
      description: 'Notas de versão do SoloMD {VERSION}: modo Pure WYSIWYG, central de exportação em 9 formatos sem Pandoc, sincronização criptografada em 5 plataformas, descoberta automática de IA local (OPR) e servidor MCP.',
    },
    breadcrumb: { home: 'Início', current: 'Novidades' },
    hero: {
      date: 'Nov 2026',
      h1: 'Um lugar mais calmo para escrever.',
      lead: 'O SoloMD 5.2 combina a escrita silenciosa estilo Typora (modo Pure WYSIWYG) com exportação integrada em 9 formatos, sincronização criptografada em 5 plataformas e IA local sem configuração.',
    },
    cta: ['⬇ Baixar v{VERSION} (Mac)', 'Baixar (Windows)', 'Todas as plataformas →'],
  },
  it: {
    ...en,
    meta: {
      title: 'Novità di SoloMD {VERSION} — note di rilascio v4.0 – v5.2',
      description: 'Note di rilascio di SoloMD {VERSION}: modalità Pure WYSIWYG, centro di esportazione a 9 formati senza Pandoc, sincronizzazione crittografata su 5 piattaforme, rilevamento automatico IA locale (OPR) e server MCP.',
    },
    breadcrumb: { home: 'Home', current: 'Novità' },
    hero: {
      date: 'Nov 2026',
      h1: 'Un posto più tranquillo per scrivere.',
      lead: 'SoloMD 5.2 unisce la scrittura pulita in stile Typora (Pure WYSIWYG) all’esportazione nativa in 9 formati, sincronizzazione crittografata su 5 piattaforme e IA locale a configurazione zero.',
    },
    cta: ['⬇ Scarica v{VERSION} (Mac)', 'Scarica (Windows)', 'Tutte le piattaforme →'],
  },
  pl: {
    ...en,
    meta: {
      title: 'Nowości w SoloMD {VERSION} — lista zmian v4.0 – v5.2',
      description: 'Lista zmian SoloMD {VERSION}: tryb Pure WYSIWYG, centrum eksportu do 9 formatów bez Pandoca, szyfrowana synchronizacja na 5 platformach, automatyczne wykrywanie lokalnej AI (OPR) i serwer MCP.',
    },
    breadcrumb: { home: 'Strona główna', current: 'Nowości' },
    hero: {
      date: 'Listopad 2026',
      h1: 'Spokojniejsze miejsce do pisania.',
      lead: 'SoloMD 5.2 łączy czystą edycję Pure WYSIWYG w stylu Typory z wbudowanym eksportem do 9 formatów, szyfrowaną synchronizacją na 5 platformach oraz lokalną AI.',
    },
    cta: ['⬇ Pobierz v{VERSION} (Mac)', 'Pobierz (Windows)', 'Wszystkie platformy →'],
  },
  nl: {
    ...en,
    meta: {
      title: 'Nieuw in SoloMD {VERSION} — release-opmerkingen v4.0 – v5.2',
      description: 'Release-opmerkingen voor SoloMD {VERSION}: Pure WYSIWYG-modus, exportcentrum voor 9 formaten zonder Pandoc, versleutelde synchronisatie op 5 platformen, automatische lokale AI-detectie (OPR) en MCP-server.',
    },
    breadcrumb: { home: 'Home', current: 'Nieuw' },
    hero: {
      date: 'Nov 2026',
      h1: 'Een rustigere plek om te schrijven.',
      lead: 'SoloMD 5.2 combineert de rust van Typora (Pure WYSIWYG) met ingebouwde export naar 9 formaten, versleutelde synchronisatie op 5 platformen en lokale AI.',
    },
    cta: ['⬇ Download v{VERSION} (Mac)', 'Download (Windows)', 'Alle platformen →'],
  },
  tr: {
    ...en,
    meta: {
      title: 'SoloMD {VERSION} Yenilikler — sürüm notları v4.0 – v5.2',
      description: 'SoloMD {VERSION} sürüm notları: Pure WYSIWYG modu, Pandoc gerektirmeyen 9 formatlı dışa aktarma merkezi, 5 platformda şifreli senkronizasyon, yerel AI otomatik keşfi (OPR) ve MCP sunucusu.',
    },
    breadcrumb: { home: 'Ana Sayfa', current: 'Yenilikler' },
    hero: {
      date: 'Kasım 2026',
      h1: 'Yazmak için daha sakin bir yer.',
      lead: 'SoloMD 5.2; Typora tarzı Pure WYSIWYG yazım deneyimini, 9 formatlı yerleşik dışa aktarma merkezi, 5 platformda uçtan uca şifreli senkronizasyon ve yerel AI ile birleştirir.',
    },
    cta: ['⬇ v{VERSION} İndir (Mac)', 'İndir (Windows)', 'Tüm platformlar →'],
  },
  sv: {
    ...en,
    meta: {
      title: 'Nyheter i SoloMD {VERSION} — versionsinformation v4.0 – v5.2',
      description: 'Versionsinformation för SoloMD {VERSION}: Pure WYSIWYG-läge, exportcenter för 9 format utan Pandoc, krypterad synk på 5 plattformar, automatisk lokal AI-upptäckt (OPR) och MCP-server.',
    },
    breadcrumb: { home: 'Hem', current: 'Nyheter' },
    hero: {
      date: 'Nov 2026',
      h1: 'En lugnare plats att skriva på.',
      lead: 'SoloMD 5.2 förenar Typoras lugna skrivkänsla (Pure WYSIWYG) med inbyggd export i 9 format, krypterad synk över 5 plattformar och lokal AI.',
    },
    cta: ['⬇ Ladda ner v{VERSION} (Mac)', 'Ladda ner (Windows)', 'Alla plattformar →'],
  },
  uk: {
    ...en,
    meta: {
      title: 'Нове у SoloMD {VERSION} — примітки до випуску v4.0 – v5.2',
      description: 'Примітки до випуску SoloMD {VERSION}: режим Pure WYSIWYG, центр експорту у 9 форматів без Pandoc, зашифрована синхронізація на 5 платформах, автовиявлення локального ШІ (OPR) та MCP-сервер.',
    },
    breadcrumb: { home: 'Головна', current: 'Нове' },
    hero: {
      date: 'Листопад 2026',
      h1: 'Спокійніше місце для письма.',
      lead: 'SoloMD 5.2 поєднує спокійний режим Pure WYSIWYG у стилі Typora з вбудованим експортом у 9 форматів, зашифрованою синхронізацією на 5 платформах та локальним ШІ.',
    },
    cta: ['⬇ Завантажити v{VERSION} (Mac)', 'Завантажити (Windows)', 'Усі платформи →'],
  },
};
