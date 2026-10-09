# Typing then Ctrl+Q within 0.3 s (and 0.1 s): the relaunch restores the text.
start_on plain.md || fail "app did not start"
round() { # TOKEN DELAY
  key ctrl+End Return; typ "$1"; sleep "$2"; tap ctrl+q
  local i; for ((i = 0; i < 40; i++)); do [ -z "$(our_app_pids)" ] && break; sleep 0.25; done
  if [ -n "$(our_app_pids)" ]; then note "$1: app still running 10 s after Ctrl+Q"; app_kill; fi
  app_launch || { note "$1: relaunch failed"; return 1; }
  wait_title '^plain\.md — SoloMD$' 10
  shot "restored-$1" >/dev/null
  contains "$(editor_text)" "$1"
}
expect "QUICKQUIT-A (Ctrl+Q 0.3 s after typing) restored" round QUICKQUIT-A 0.3
expect "QUICKQUIT-B (Ctrl+Q 0.1 s after typing) restored" round QUICKQUIT-B 0.1
finish "last keystrokes survive a quick quit"
