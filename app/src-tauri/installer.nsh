; Custom NSIS hook: make the .md / .markdown / .mdown / .mkd / .txt file
; association show a dedicated document icon.
;
; Two ProgIDs get the correct DefaultIcon:
;   - "Markdown Document" (Tauri's default FILECLASS from tauri.conf.json
;     fileAssociations[0].name)
;   - "SoloMD.md" (leftover from earlier 1.1.6 rebuilds; UserChoice on some
;     machines still points at it and Windows protects UserChoice so we
;     can't delete it without taking ownership — patch the ProgID instead)

!macro NSIS_HOOK_POSTINSTALL
  ; Primary: override Tauri-registered DefaultIcon for "Markdown Document"
  WriteRegStr SHCTX "Software\Classes\Markdown Document\DefaultIcon" "" "$INSTDIR\icons\file_icon.ico,0"
  WriteRegStr SHCTX "Software\Classes\Plain Text\DefaultIcon" "" "$INSTDIR\icons\file_icon.ico,0"

  ; Fallback: ensure the SoloMD.md / SoloMD.txt ProgIDs (if UserChoice or
  ; older installs point to them) also have the right icon + open command.
  WriteRegStr SHCTX "Software\Classes\SoloMD.md" "" "Markdown Document"
  WriteRegStr SHCTX "Software\Classes\SoloMD.md\DefaultIcon" "" "$INSTDIR\icons\file_icon.ico,0"
  WriteRegStr SHCTX "Software\Classes\SoloMD.md\shell\open\command" "" '"$INSTDIR\SoloMD.exe" "%1"'
  WriteRegStr SHCTX "Software\Classes\SoloMD.txt" "" "Plain Text"
  WriteRegStr SHCTX "Software\Classes\SoloMD.txt\DefaultIcon" "" "$INSTDIR\icons\file_icon.ico,0"
  WriteRegStr SHCTX "Software\Classes\SoloMD.txt\shell\open\command" "" '"$INSTDIR\SoloMD.exe" "%1"'

  ; Force Explorer to refresh icon cache (SHCNE_ASSOCCHANGED).
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey SHCTX "Software\Classes\SoloMD.md"
  DeleteRegKey SHCTX "Software\Classes\SoloMD.txt"
!macroend
