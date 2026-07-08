# App Review Notes — macOS

Paste the section below into **App Review Information → Notes** in App Store Connect.

---

## Notes to Reviewer

Thank you for reviewing SoloMD.

**What it is**: SoloMD is a local, offline-first Markdown text editor. It edits plain `.md` and `.txt` files stored on the user's Mac. It is open source (github.com/zhitongblog/solomd, MIT) and has been distributed outside the Mac App Store since v0.1.0 — this is our first App Store submission.

**No sign-in required**: There is no account system, no login screen, no paywall. All features are immediately available after launch. No demo account is needed.

**What to try**:
1. Launch the app — a welcome document appears.
2. Type in the left pane; the live Markdown preview updates on the right.
3. Press ⌘O to open any `.md` or `.txt` file.
4. Press ⌘⇧K to open the Command Palette.
5. Press ⌘⇧F for global folder search.
6. Press ⌘, to explore settings (themes, fonts, export options, custom CSS).
7. Try exporting via File → Export as PDF / HTML / DOCX.

**Sandboxed**: SoloMD is a fully sandboxed app. It uses `com.apple.security.files.user-selected.read-write` to access files the user explicitly opens or creates, and nothing else. No broad disk access.

**Network usage**: SoloMD is fully offline. It uses no ads, no analytics, no tracking, no third-party SDKs. The optional "check for updates" menu item is disabled in the App Store build per guideline 2.4.5(iii) — the Mac App Store handles updates itself.

**File handling**: SoloMD registers as an editor for `.md`, `.markdown`, `.mdown`, `.mkd`, and `.txt` files (declared in the Info.plist `CFBundleDocumentTypes`). Double-clicking one of these files in Finder will launch SoloMD to edit it.

**Privacy**: The app collects no data of any kind. See the App Privacy section — all categories are "Data Not Collected".

**Export compliance**: The app uses only standard HTTPS (via system APIs). No custom cryptography. Exempt per `ITSAppUsesNonExemptEncryption = NO`.

**Open source**: The entire source is at github.com/zhitongblog/solomd under MIT license. The App Store build is identical to the GitHub release tagged `v0.1.12`, with only the sandbox and App Store receipt validation enabled.

**Contact during review**:
- Email: slushy@139.com
- Happy to clarify via the Resolution Center.

Thank you!

---

## Contact info to fill in App Store Connect

- First name: [your first name]
- Last name: [your last name]
- Phone number: [your phone]
- Email: slushy@139.com
- Demo account: (leave blank — no login)
- Notes: (paste the section above)
- Attachments: (none needed)
