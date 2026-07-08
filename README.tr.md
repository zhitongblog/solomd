# SoloMD

> Ajanların yaşadığı editör.

[![Latest release](https://img.shields.io/github/v/release/zhitongblog/solomd)](https://github.com/zhitongblog/solomd/releases/latest)
[![License: MIT](https://img.shields.io/github/license/zhitongblog/solomd?color=orange)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/zhitongblog/solomd/total)](https://github.com/zhitongblog/solomd/releases)
[![Website](https://img.shields.io/badge/website-solomd.app-ff9f40.svg)](https://solomd.app)

🌐 **[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · [Português](README.pt.md) · [Italiano](README.it.md) · [Polski](README.pl.md) · [Nederlands](README.nl.md) · [Svenska](README.sv.md) · [Українська](README.uk.md)**

[**v4.0'u indir**](https://github.com/zhitongblog/solomd/releases/latest) · [**Lansman yazısı**](https://solomd.app/blog/v4-0-0-agent-native-author/) · [**Web sitesi**](https://solomd.app) · [**Güvenlik**](https://solomd.app/security)

![SoloMD Editor](web/public/demo/solomd-demo.svg)

Notlarınız bir klasörde yaşar. **SoloMD bunun üzerindeki editördür — editör içi birinci sınıf bir ajan yüzeyi ve Claude Code / Cursor'un dışarıdan sürebileceği MCP uç noktası ile birlikte.** Aynı `.md` dosyaları. Vault'unuzla sohbet edin. Klavyenin başında olmadığınızda çalışan tarifler planlayın. Aynı vault'u herhangi bir MCP istemcisine devredin.

Tauri 2 + Vue 3 + CodeMirror 6 üzerine kuruludur. Universal macOS dmg ~32 MB. Ücretsiz, MIT, abonelik yok, SoloMD tarafından barındırılan sunucu yok. Notlarınız, AI anahtarlarınız, embedding indeksiniz ve Git geçmişinizin tamamı makinenizde kalır.

## Bir ürünün üç yarısı

**Editör.** WYSIWYG canlı düzenleme (Typora tarzı), sekmeler + bölünmüş paneller, KaTeX + Mermaid, `_assets/` içine resim yapıştırma, slayt gösterisi modu (`⌘⌥P`), Vim modu, Hunspell + CJK yazım denetimi, semantik arama (`⌘⇧F`), wikilink'ler + geri bağlantılar, Pandoc dışa aktarımı. CJK kodlamaları (GBK / Big5 / Shift-JIS) otomatik algılanır.

**Uç nokta.** Paketlenmiş bir `solomd-mcp` ikilisi, aynı vault'u herhangi bir MCP istemcisine açar — varsayılan olarak 13 araç, bunların 5'i SoloMD'ye özel (`autogit_log`, `autogit_diff`, `autogit_rollback`, `sync_status`, `share_url`) ve başka hiçbir Markdown sunucusunda yoktur. v4.0, `--workspace path1 --workspace path2` federasyonunu ekler — tek bir MCP oturumu, birçok vault. Ayrıca önceden bağlanmış MCP ile Claude Code / Codex CLI'ya devreden bir `solomd agent <prompt>` CLI'ı.

**Ajan yüzeyi (v4.0).** Sağ taraf ajan paneli: akış halinde vault ile sohbet, `[[wikilink]]` atıfları, satır içi araç çağrı kartları, **Ekle** / **Kopyala** düğmeleri yanıtı aktif nota düşürür. Ayrıca `<workspace>/.solomd/agents/*.yml` içinde YAML olarak bildirimsel **tarifler** — `cron` / `on-save` / `on-commit` / `on-tag-add` / manuel tetikleyiciler. **Her ajan yazma eylemi, `main`'e dokunmadan önce kabul edebileceğiniz veya reddedebileceğiniz kendi AutoGit dalına iner**; varsayılan write-cap 5; çalışma ağacı kirliyse başlamayı reddeder; çalıştırma başına `read_agent_trace` MCP aracıyla yeniden oynatılabilir `trace.jsonl`.

| Özellik | |
|---|---|
| **Ajan paneli** *(v4.0)* | Outline / Backlinks / Tags / History ile aynı seviyede akış halinde vault sohbeti. Araç çağrı kartları satır içinde açılır; aktif editöre yanıt Ekle / Kopyala; çalıştırma günlüğü `.solomd/agent-runs/` altında saf Markdown olarak korunur. |
| **Zamanlanmış tarifler** *(v4.0)* | Vault'unuzdaki YAML işleri. Birleştirme öncesi AutoGit dal kum havuzu + kabul/red UI'ı. Çalıştırma başına write-cap (varsayılan 5, maksimum 50). Ağaçta 11 tariflik bir tarif kitabı. |
| **Yeniden oynatılabilir iz** *(v4.0)* | Adım başına `trace.jsonl` (`prompt` / `model_call` / `tool_call` / `tool_result` / `git_commit`). Adımdan tekrar oynatma geri sarar ve yeniden çalıştırır. |
| **Çalışma alanı federasyonu** *(v4.0)* | `solomd-mcp --workspace path1 --workspace path2`. Tek bir Claude Desktop oturumu, birçok vault. Ayarlar → Entegrasyonlar'da MCP profil UI'ı. |
| **Ollama birinci sınıf** *(v4.0)* | `localhost:11434` üzerinde otomatik algılama. Üç model ön ayarı (`qwen2.5:1.5b/7b/14b`). Bulutsuz özerk döngüler için `provider: local` tarif takma adı. |
| **AI yeniden yazma, BYOK** | 14 sağlayıcı — OpenAI · Claude · Gemini · DeepSeek · Qwen · GLM · Kimi · Doubao · SiliconFlow · OpenRouter · Mistral · Groq · xAI · Ollama. Doğrudan satıcı çağrıları. Anahtarlar OS keychain'de. |
| **GitHub destekli senkronizasyon** | Vault'unuzu her kayıtta özel bir GitHub deposuna gönderin. Opsiyonel E2EE (Argon2id + XChaCha20-Poly1305). GitLab / Gitea / herhangi bir HTTPS git URL'si de çalışır. |
| **Not başına AutoGit** | Her `⌘S`, çalışma alanındaki yerel bir `.git`'e yapılan bir commit'tir. libgit2 paketlenmiştir, sistem git'ine gerek yoktur. Asla otomatik push edilmez. |
| **MCP sunucusu paketlenmiş** | `solomd-mcp` kuruluma dahildir. 13 araç (8 jenerik + 5 SoloMD'ye özel). Yalnızca stdio, ağ portu yok. Varsayılan olarak salt okunur; `--allow-write` ile opt-in. |
| **REST API** *(v4.0)* | Yalnızca localhost, token kimlik doğrulama. Henüz MCP konuşmayan istemciler için MCP ile aynı yüzey — Alfred / Raycast / n8n / kendi betikleriniz. |
| **BYOK maliyet ölçer** *(v4.0)* | Sağlayıcı başına çalışan token kullanım sayacı, opt-in. Ayarlar → Entegrasyonlar. |
| **Bulut klasörü modu** | Vault'unuz `~/Library/Mobile Documents/...` veya `~/Dropbox/...` altındaysa SoloMD bunu algılar ve cihazlar arası oturum geri yüklemesi ekler — dosya senkronizasyonunu zaten OS yapıyor. |
| **Genel salt okunur paylaşım** | Komut paleti → bir `solomd.app/share/?repo=...&path=...` bağlantısı kopyalayın. Görüntülemek için SoloMD hesabına gerek olmadan, genel GitHub deponuzdaki herhangi bir dosyayı işler. |

## Kullanım

SoloMD'yi macOS / Linux'a kurduktan sonra:

**1. Vault'unuzla sohbet edin.** Sağ taraftaki ajan panelini açın (gizliyse ⌘⇧P → "View: Toggle Agent Panel"). Notlarınıza karşı akış halinde çok adımlı sohbet; araç çağrı kartları her okuma/yazmayı satır içinde gösterir. Yanıt çok mu uzun? **Ekle** onu aktif notta imleç konumuna düşürür (seçimi değiştirir); **Kopyala** panoya kopyalar.

**2. Bir tarif planlayın.** Ayarlar → Tarifler → tarif kitabına göz atın. 11 hazır başlangıç tarifi: haftalık özet, günlük özet, TODO çıkarma, çeviri geçişi, atıf temizleme, CJK yazım denetleyici ajanı, link çürümesi dedektörü, frontmatter normalleştirici, taslaktan bloga, refactor geçişi, haftalık etiket triyajı. Birini yükleyin, prompt'u düzenleyin, çalıştırın.

**3. Aynı vault'u başka bir LLM istemcisinden sürün.** Tek seferde:

```bash
# AI istemciniz için MCP yapılandırma parçacığını yazdırın.
solomd mcp-config
```

```json
{
  "mcpServers": {
    "solomd": {
      "command": "/Applications/SoloMD.app/Contents/Resources/solomd-mcp",
      "args": ["--workspace", "/Users/me/Documents/SoloMD"]
    }
  }
}
```

Claude Desktop / Cursor / vb.'ye yapıştırın. Çoklu vault federasyonu için `--workspace`'i tekrarlayın:

```json
"args": [
  "--workspace", "/Users/me/Documents/SoloMD",
  "--workspace", "/Users/me/Documents/work-notes"
]
```

**4. Veya bir prompt'u doğrudan claude / codex CLI'ya devredin:**

```bash
solomd agent "bu haftanın günlük notlarını haftalık bir özete yeniden yaz ve commit et"
```

Path traversal'a karşı korumalı. Ağ portu yok. LLM yalnızca çalışma alanını yönelttiğiniz yeri görür.

## Kurulum

En son sürüm: [**v4.0.0**](https://github.com/zhitongblog/solomd/releases/latest).

### macOS — Universal dmg (Apple Silicon + Intel, imzalı + noterlenmiş)

```bash
brew install --cask zhitongblog/solomd/solomd
```

Veya dmg'yi doğrudan indirin:

```
https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_universal.dmg
```

Veya tek satırlık shell kurulumu:

```bash
curl -fsSL https://solomd.app/install.sh | bash
```

### Windows — x64

- [`SoloMD_4.0.0_x64_en-US.msi`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_x64_en-US.msi)
- [`SoloMD_4.0.0_x64-setup.exe`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_x64-setup.exe) (NSIS)
- [`SoloMD_4.0.0_x64-portable.zip`](https://github.com/zhitongblog/solomd/releases/latest/download/SoloMD_4.0.0_x64-portable.zip) — kurulumcu yok

```powershell
irm https://solomd.app/install.ps1 | iex
```

```powershell
winget install solomd
```

### Linux — x86_64 + aarch64

- `.AppImage` (evrensel), `.deb` (Debian/Ubuntu), `.rpm` (Fedora/RHEL) — her iki mimari de [sürümler sayfasından](https://github.com/zhitongblog/solomd/releases/latest).
- Arch kullanıcıları: AUR'da [`solomd-bin`](https://aur.archlinux.org/packages/solomd-bin).

### iPad

[App Store](https://apps.apple.com/app/solomd/id6762498874) — aynı motor, yerel iPad UI.

## Gizlilik ve güvenlik

Saf istemci tarafı. `.md` dosyalarınız seçtiğiniz klasörde kalır. API anahtarları OS keychain'de yaşar (macOS Keychain / Windows Credential Manager / Linux libsecret), asla `localStorage`'da veya bir yapılandırma dosyasında değil. AI istekleri makinenizden seçilen sağlayıcıya doğrudan gider — SoloMD röleyi yok. RAG embedding'leri ve AutoGit deposu yalnızca yereldir. MCP sunucusu stdio konuşur, asla bir ağ portu açmaz. Tüm kod tabanı MIT'tir ve denetlenebilir.

**Ajan güvenlik bariyerleri (v4.0).** Her tarif çalıştırması kendi AutoGit dalında başlar — diff üzerinde Kabul Et'e tıklayana kadar `main`'iniz dokunulmadan kalır. Çalıştırma başına write-cap (varsayılan 5, sert maksimum 50) kontrolden çıkmış döngüleri önler. Tarif çalıştırıcı, çalışma ağacı kirliyse başlamayı reddeder (hiçbir ajan commit'i WIP'inizi süpürmeyecektir). Path traversal koruyucuları, kullanıcı tarafından sağlanan bir yolu kabul eden her Tauri / MCP / REST uç noktasında `..` segmentlerini ve mutlak yolları önceden reddeder.

E2EE senkronizasyonu Argon2id (RFC9106 varsayılan parametreleri) → deterministik nonce'lar ve AAD olarak yol ile XChaCha20-Poly1305 kullanır. Düz metin cihazlarınızda kalır; uzaktaki yalnızca şifreli metni görür. `sync.json` ayrıştırma başarısızlığı fail-closed'tır — düz metne düşmek yerine push'u reddeder (bir v3.0.x denetim düzeltmesi).

Tam yazı: <https://solomd.app/security>.

## Kaynaktan derleme

Önkoşullar: Rust (stable), Node 18+, pnpm.

```bash
git clone https://github.com/zhitongblog/solomd.git
cd solomd/app
pnpm install
pnpm tauri dev      # hot reload ile dev
pnpm tauri build    # release artefaktları → src-tauri/target/release/bundle/
```

Linux ek olarak keychain backend'i için `libdbus-1-dev`'e ihtiyaç duyar.

MCP sunucusu `mcp-server/` altında ayrı bir crate'tir; uçtan uca testler için dev-MCP harness'ı `dev-mcp/` altında yaşar. Uçtan uca test giriş noktası: `scripts/v4-self-test.sh` (tam kapsama için `--with-release --with-ollama --with-ui` ile çalıştırın).

## Katkıda bulunma

Issue ve PR'lar memnuniyetle karşılanır — [bir tane açın](https://github.com/zhitongblog/solomd/issues). Yön hissi için [`docs/roadmap.md`](docs/roadmap.md)'e bakın. v4.0 derleme günlüğü [solomd.app/blog/v4-0-0-how-we-built-it/](https://solomd.app/blog/v4-0-0-how-we-built-it/) adresindedir — bir PR göndermeden önce mühendislik ilkelerini anlamak istiyorsanız oradan başlayın.

## İletişim

Tek bir bakımcı, iki ön kapı. Asenkron olarak [GitHub Discussions](https://github.com/zhitongblog/solomd/discussions). Gerçek zamanlı sohbet:

- **Telegram (uluslararası):** [@SOLOMDAPP](https://t.me/SOLOMDAPP) — sürüm duyuruları + sohbet
- **WeChat (中文):** beni eklemek için tarayın — not "SoloMD"

## Lisans ve katkıda bulunanlar

[MIT](LICENSE) © 2026 xiangdong li. SoloMD; Tauri 2, Vue 3, CodeMirror 6, markdown-it, KaTeX, Mermaid, libgit2, Pandoc, Hunspell, `keyring-rs` ve `rmcp` üzerinde durur. [GitHub Sponsors](https://github.com/sponsors/zhitongblog) veya [solomd.app/#sponsor](https://solomd.app/#sponsor) üzerinden sponsor olun.
