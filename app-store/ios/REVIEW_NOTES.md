# App Review Notes — iPad Only

Paste the section below into **App Review Information → Notes** in App Store Connect.

---

## Notes to Reviewer

Thank you for reviewing SoloMD.

**What it is**: SoloMD is a local, offline-first Markdown text editor. It is the iPad port of our open-source desktop editor (github.com/zhitongblog/solomd). The app edits plain `.md` and `.txt` files stored on the user's device.

**No sign-in required**: There is no account system, no login screen, no paywall. All features are immediately available after launch. No demo account is needed.

**What to try**:
1. Launch the app — a welcome document appears.
2. Tap anywhere in the text to start editing; the live preview is on the right.
3. Use the view-mode toggle (split icon in the titlebar area) to switch between editor-only, split, and preview-only views.
4. Tap the folder icon to open the file tree; tap the outline icon to navigate headings.
5. Tap the gear icon to explore settings (themes, fonts, export options).
6. Tap any image or Mermaid diagram in the preview to see the pinch-to-zoom overlay.

**Network usage**: SoloMD is fully offline. It uses no ads, no analytics, no tracking, no third-party SDKs. It does not make network requests in production. (The optional "check for updates" menu item that exists in the desktop version is disabled on iOS per App Store Review Guideline 2.4.5(iii).)

**File storage**: All user content lives inside the app's sandbox documents directory, managed by iOS. No iCloud, no external services.

**Privacy**: The app collects no data of any kind. See the App Privacy section — all categories are "Data Not Collected".

**Export compliance**: The app uses only standard HTTPS (via system APIs) for any optional future network features. No custom cryptography. Exempt per `ITSAppUsesNonExemptEncryption = NO`.

**Open source**: The entire source is at github.com/zhitongblog/solomd under MIT license.

**Contact during review**:
- Email: slushy@139.com
- If the reviewer has questions about a specific feature, happy to clarify via the Resolution Center.

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
