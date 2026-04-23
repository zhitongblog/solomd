; Custom NSIS hook: register .md / .markdown / .mdown / .mkd / .txt file
; associations to use a dedicated document icon (not the main app icon).
;
; Triggered by tauri's bundler via bundle.windows.nsis.installerHooks.

!macro NSIS_HOOK_POSTINSTALL
  ; SoloMD ProgID for markdown files
  WriteRegStr SHCTX "Software\Classes\SoloMD.md" "" "Markdown Document"
  WriteRegStr SHCTX "Software\Classes\SoloMD.md\DefaultIcon" "" "$INSTDIR\resources\icons\file_icon.ico,0"
  WriteRegStr SHCTX "Software\Classes\SoloMD.md\shell\open\command" "" '"$INSTDIR\SoloMD.exe" "%1"'
  WriteRegStr SHCTX "Software\Classes\.md\OpenWithProgids" "SoloMD.md" ""
  WriteRegStr SHCTX "Software\Classes\.markdown\OpenWithProgids" "SoloMD.md" ""
  WriteRegStr SHCTX "Software\Classes\.mdown\OpenWithProgids" "SoloMD.md" ""
  WriteRegStr SHCTX "Software\Classes\.mkd\OpenWithProgids" "SoloMD.md" ""

  ; SoloMD ProgID for plain text files
  WriteRegStr SHCTX "Software\Classes\SoloMD.txt" "" "Plain Text"
  WriteRegStr SHCTX "Software\Classes\SoloMD.txt\DefaultIcon" "" "$INSTDIR\resources\icons\file_icon.ico,0"
  WriteRegStr SHCTX "Software\Classes\SoloMD.txt\shell\open\command" "" '"$INSTDIR\SoloMD.exe" "%1"'
  WriteRegStr SHCTX "Software\Classes\.txt\OpenWithProgids" "SoloMD.txt" ""

  ; Force Explorer to refresh icon cache so new icons show without reboot
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey SHCTX "Software\Classes\SoloMD.md"
  DeleteRegKey SHCTX "Software\Classes\SoloMD.txt"
  DeleteRegValue SHCTX "Software\Classes\.md\OpenWithProgids" "SoloMD.md"
  DeleteRegValue SHCTX "Software\Classes\.markdown\OpenWithProgids" "SoloMD.md"
  DeleteRegValue SHCTX "Software\Classes\.mdown\OpenWithProgids" "SoloMD.md"
  DeleteRegValue SHCTX "Software\Classes\.mkd\OpenWithProgids" "SoloMD.md"
  DeleteRegValue SHCTX "Software\Classes\.txt\OpenWithProgids" "SoloMD.txt"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
