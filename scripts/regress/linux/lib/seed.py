#!/usr/bin/env python3
"""Emit the localStorage seed for a fresh test profile (JSON on stdout).

  seed.py VAULT [SETTINGS_OVERRIDES_JSON] [EXTRA_KEYS_JSON]

Only flags that keep first-run UI out of the way are set; everything else
falls back to the app's own defaults (settings are merged over defaults()).
"""
import json
import sys
import time

vault = sys.argv[1]
over = json.loads(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else {}
extra = json.loads(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else {}

settings = {
    "language": "en",
    "theme": "light",
    "welcomeShown": True,          # no Welcome tour tabs
    "agentWizardSeen": True,       # no "Set up your AI assistant" modal (trap 2)
    "telemetryNoticeAck": True,    # no telemetry banner
    "telemetryEnabled": False,     # a test box should not phone home
    "autoCheckUpdate": False,
    "restoreSession": True,
    "showFileTree": True,
    "fileTreeDefaultDesktopMigrated": True,
    "v4810PreviewFontSynced": True,
    "v491MobileLayoutMigrated": True,
    "v4AgentPanelMigrated": True,
    "smartQuotesOptInMigrated": True,
    "pdfPageSizeAutoMigrated": True,
    "showAgentPanel": False,
}
settings.update(over)

today = time.strftime("%Y-%m-%d")
seed = {
    "solomd.settings.v1": settings,
    "solomd.workspace.v1": {
        "recentFiles": [],
        "recentFolders": [vault] if vault else [],
        "currentFolder": vault or None,
        "safTreeUri": None,
        "safName": None,
    },
    "solomd.starPrompt": {"first": "2020-01-01", "days": [today], "shown": True},
    "solomd.update.last-check": str(int(time.time() * 1000)),
}
for k, v in extra.items():
    if v is None:
        seed.pop(k, None)
    else:
        seed[k] = v
print(json.dumps(seed, ensure_ascii=False))
