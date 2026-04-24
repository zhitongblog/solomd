; Custom NSIS hook: override Tauri's default-icon for the .md/.txt file
; associations so Explorer shows the dedicated document icon (not the
; app's main icon).
;
; Tauri's APP_ASSOCIATE macro writes:
;   Classes\<name>\DefaultIcon = $INSTDIR\<app>.exe,0
; where <name> is the association `name` field from tauri.conf.json
; (here: "Markdown Document" and "Plain Text").
;
; Our POSTINSTALL hook runs AFTER those writes, so we overwrite the
; DefaultIcon value to point at our bundled file_icon.ico resource.

!macro NSIS_HOOK_POSTINSTALL
  ; Overwrite Tauri-registered DefaultIcon with our document-specific icon.
  WriteRegStr SHCTX "Software\Classes\Markdown Document\DefaultIcon" "" "$INSTDIR\resources\icons\file_icon.ico,0"
  WriteRegStr SHCTX "Software\Classes\Plain Text\DefaultIcon" "" "$INSTDIR\resources\icons\file_icon.ico,0"

  ; Clean up any stale SoloMD.md / SoloMD.txt ProgIDs left by earlier
  ; 1.1.6-rebuild installers so the registry state is consistent.
  DeleteRegKey SHCTX "Software\Classes\SoloMD.md"
  DeleteRegKey SHCTX "Software\Classes\SoloMD.txt"
  ; Tauri writes `.md → "Markdown Document"` via APP_ASSOCIATE already;
  ; earlier versions of this hook overrode that to `.md → SoloMD.md`,
  ; so restore it to Tauri's value.
  WriteRegStr SHCTX "Software\Classes\.md" "" "Markdown Document"
  WriteRegStr SHCTX "Software\Classes\.markdown" "" "Markdown Document"
  WriteRegStr SHCTX "Software\Classes\.mdown" "" "Markdown Document"
  WriteRegStr SHCTX "Software\Classes\.mkd" "" "Markdown Document"

  ; Force Explorer to refresh icon cache.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Tauri's uninstaller already removes its own associations; nothing to do.
!macroend
