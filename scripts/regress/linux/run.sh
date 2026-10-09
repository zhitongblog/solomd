#!/usr/bin/env bash
# SoloMD Linux regression suite — Mac-side driver.
#
#   scripts/regress/linux/run.sh <path-to-.deb> [--appimage <path>] [CHECK…]
#
# Copies the package(s) and the suite into the Lima VM (default
# `solomd-linux`), runs vm-suite.sh there (own Xvfb display, openbox, private
# dbus, private HOME/profile), then copies results back and prints the table.
#
# Environment:
#   LIMA_VM=solomd-linux      VM name
#   RG_DISPLAY=:94            X display inside the VM (must be free)
#   RG_ROOT=/tmp/rg2          work dir inside the VM
#   OUT_DIR=<dir>             where results land on the Mac
#                             (default: /tmp/solomd-regress-linux/<timestamp>)
#   CHECK_TIMEOUT=240         per-check timeout in seconds
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VM="${LIMA_VM:-solomd-linux}"
RG_ROOT="${RG_ROOT:-/tmp/rg2}"
RG_DISPLAY="${RG_DISPLAY:-:94}"
TS="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="${OUT_DIR:-/tmp/solomd-regress-linux/$TS}"

usage() { sed -n 2,18p "$0"; exit 2; }
[ $# -ge 1 ] || usage
DEB="$1"; shift
[ -f "$DEB" ] || { echo "no such .deb: $DEB" >&2; exit 2; }
APPIMAGE=""
CHECKS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --appimage) APPIMAGE="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) CHECKS+=("$1"); shift ;;
  esac
done
# An AppImage sitting next to the .deb is picked up automatically.
if [ -z "$APPIMAGE" ]; then
  APPIMAGE="$(ls "$(dirname "$DEB")"/*.AppImage 2>/dev/null | head -1 || true)"
fi

vm() { limactl shell "$VM" -- bash -c "$1"; }

if ! limactl list --format '{{.Name}} {{.Status}}' 2>/dev/null | grep -q "^$VM Running"; then
  echo "Lima VM '$VM' is not running (limactl start $VM)" >&2; exit 2
fi

echo ">> preparing $VM:$RG_ROOT"
vm "mkdir -p $RG_ROOT/pkg && rm -rf $RG_ROOT/suite && mkdir -p $RG_ROOT/suite"
COPYFILE_DISABLE=1 tar --no-xattrs -C "$HERE" --exclude './out*' -cf - . 2>/dev/null \
  | limactl shell "$VM" -- bash -c "tar -C $RG_ROOT/suite -xf - 2>/dev/null"
limactl copy "$DEB" "$VM:$RG_ROOT/pkg/"
VM_DEB="$RG_ROOT/pkg/$(basename "$DEB")"
VM_APPIMAGE=""
if [ -n "$APPIMAGE" ]; then
  limactl copy "$APPIMAGE" "$VM:$RG_ROOT/pkg/"
  VM_APPIMAGE="$RG_ROOT/pkg/$(basename "$APPIMAGE")"
fi

echo ">> checking tools in the VM"
vm "cd $RG_ROOT/suite && ./vm-suite.sh deps"

echo ">> running (display $RG_DISPLAY)"
set +e
vm "cd $RG_ROOT/suite && RG_ROOT=$RG_ROOT RG_DISPLAY=$RG_DISPLAY CHECK_TIMEOUT=${CHECK_TIMEOUT:-240} \
    SOLOMD_DEB='$VM_DEB' SOLOMD_APPIMAGE='$VM_APPIMAGE' ./vm-suite.sh all ${CHECKS[*]:-}"
rc=$?
set -e

mkdir -p "$OUT_DIR"
limactl copy -r "$VM:$RG_ROOT/out/." "$OUT_DIR/" >/dev/null 2>&1 \
  || vm "tar -C $RG_ROOT/out -cf - ." | tar -C "$OUT_DIR" -xf -
echo
echo ">> results: $OUT_DIR/results.json  screenshots: $OUT_DIR/shots/  logs: $OUT_DIR/logs/"
exit $rc
