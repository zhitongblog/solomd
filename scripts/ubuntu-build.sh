#!/usr/bin/env bash
# SoloMD 构建/清理脚本（Linux/macOS）
#
# 用法:
#   bash scripts/ubuntu-build.sh                     # 完整构建
#   bash scripts/ubuntu-build.sh clean               # 清理中间产物，保留最终二进制
#   bash scripts/ubuntu-build.sh clean all           # 清理所有中间产物（含二进制）
#   bash scripts/ubuntu-build.sh help | -h | --help  # 查看用法
#
# 前置: 已安装 pnpm、Rust；Linux 需先装系统依赖（脚本会检测并给出命令）
#
# 环境变量:
#   JOBS=N     cargo 并行度（默认 = 逻辑核数）
#   FAST=1     用 thin LTO + 16 codegen-units 加速首次构建（产物略大，不改源码）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/app"
MCP="$ROOT/mcp-server"
BUNDLE="$APP/src-tauri/target/release/bundle"
BINARIES="$APP/src-tauri/binaries"
DIST="$APP/dist"

show_help() {
  local cores
  cores="$(nproc 2>/dev/null || echo N)"
  cat <<EOF
SoloMD 构建/清理脚本

用法:
  bash scripts/ubuntu-build.sh                    完整构建（vue-tsc → vite → MCP sidecar → tauri）
  bash scripts/ubuntu-build.sh clean              清理中间产物，保留最终二进制
                                          （bundle/ 安装包、release/SoloMD、sidecar）
  bash scripts/ubuntu-build.sh clean all          清理所有中间产物，含二进制与 node_modules
  bash scripts/ubuntu-build.sh help | -h | --help 显示本帮助

环境变量:
  JOBS=N       cargo 并行度，默认 = 逻辑核数（本机 $cores）
  FAST=1       加速首次构建：thin LTO + codegen-units=16（产物略大，不改源码）
               （正式发布请勿使用，上游默认 lto=fat 体积最小）

产物位置:
  app/src-tauri/target/release/bundle/   安装包（.AppImage / .deb 等）
  app/src-tauri/target/release/SoloMD    未打包可执行文件
  app/src-tauri/binaries/solomd-mcp-*    MCP sidecar 二进制

前置依赖（Linux）:
  sudo apt update && sudo apt install -y \\
    libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev \\
    libgtk-3-dev libpango1.0-dev librsvg2-dev \\
    libxdo-dev libssl-dev libayatana-appindicator3-dev build-essential
EOF
}

# ---------------------------------------------------------------------------
# clean：清理中间编译产物，保留最终二进制
#   clean all：额外删除二进制、安装包与 node_modules
# ---------------------------------------------------------------------------
do_clean() {
  local all="${1:-}"
  echo "=== SoloMD clean ${all:+($all)} ==="

  # Rust 编译中间产物（fingerprint/deps/incremental 等），保留 release 最终产物
  for tgt in "$APP/src-tauri/target" "$MCP/target"; do
    if [[ -d "$tgt" ]]; then
      rm -rf "$tgt/release/build" "$tgt/release/deps" "$tgt/release/examples" \
             "$tgt/release/incremental" "$tgt/release/.fingerprint" \
             "$tgt/debug" "$tgt/.rustc_info.json" 2>/dev/null || true
      echo "  已清理: $tgt 的中间产物"
    fi
  done

  if [[ "$all" == "all" ]]; then
    # 彻底清理：target 全目录 + 前端产物 + sidecar 二进制 + 依赖。
    # 注意：binaries/ 目录本身被 git 跟踪（.gitignore + README.md），只删产物文件。
    rm -rf "$APP/src-tauri/target" "$MCP/target" "$DIST" "$APP/node_modules" 2>/dev/null || true
    rm -f "$BINARIES"/solomd-mcp-* 2>/dev/null || true
    echo "  已清理: 全部 target / dist / node_modules / sidecar 二进制"
  else
    rm -rf "$DIST" 2>/dev/null || true
    echo "  已清理: $DIST（前端产物）"
    echo "  保留:   $BUNDLE、release/SoloMD、$BINARIES"
  fi
  echo "=== clean 完成 ==="
}

if [[ "${1:-}" == "clean" ]]; then
  do_clean "${2:-}"
  exit 0
fi
if [[ "${1:-}" == "help" || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  show_help
  exit 0
fi

# ---------------------------------------------------------------------------
# 并行编译：默认用满所有逻辑核。
# cargo 本身默认已全核；显式设置以防御 ~/.cargo/config.toml 里的限制。
# ---------------------------------------------------------------------------
JOBS="${JOBS:-$(nproc)}"
export CARGO_BUILD_JOBS="$JOBS"
# FAST=1 时用环境变量临时覆盖上游的体积优先 profile（不动源码）：
#   lto=fat + codegen-units=1 的链接阶段是单线程瓶颈，
#   换成 thin LTO + 16 units 可显著缩短首次构建，代价是产物略大。
if [[ "${FAST:-0}" == "1" ]]; then
  echo "FAST 模式：CARGO_PROFILE_RELEASE_LTO=thin, CODEGEN_UNITS=16"
  export CARGO_PROFILE_RELEASE_LTO="thin"
  export CARGO_PROFILE_RELEASE_CODEGEN_UNITS="16"
fi

echo "=== SoloMD build（并行度: $JOBS）==="

# ---------- 1. 平台依赖检查 ----------
if [[ "$(uname)" == "Linux" ]]; then
  echo "[1/5] 检查 Linux 系统库..."
  DEPS_OK=1
  for pkg in pango webkit2gtk-4.1 javascriptcoregtk-4.1 libsoup-3.0 gtk+-3.0 librsvg-2.0; do
    if ! pkg-config --exists "$pkg" 2>/dev/null; then
      echo "  [缺失] $pkg"
      DEPS_OK=0
    fi
  done
  if [[ "$DEPS_OK" == "0" ]]; then
    cat <<'EOF'

缺少 Tauri 2 构建所需系统库，请先执行（Ubuntu/Debian）：

  sudo apt update && sudo apt install -y \
    libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev \
    libgtk-3-dev libpango1.0-dev librsvg2-dev \
    libxdo-dev libssl-dev libayatana-appindicator3-dev build-essential

装完重新运行本脚本即可。
EOF
    exit 1
  fi
  echo "  系统库 OK"
else
  echo "[1/5] 平台: $(uname)（跳过系统库检查）"
fi

# ---------- 2. 前端依赖 ----------
echo "[2/5] pnpm install..."
command -v pnpm >/dev/null 2>&1 || { echo "错误：未找到 pnpm，请先安装（npm i -g pnpm）"; exit 1; }
(cd "$APP" && pnpm install)

# ---------- 3. 前端类型检查 + 构建（vue-tsc + vite）----------
echo "[3/5] 前端 build（vue-tsc --noEmit && vite build）..."
(cd "$APP" && pnpm build)

# ---------- 4. MCP sidecar（solomd-mcp，编译期被 build.rs 校验，必须先于 tauri build）----------
echo "[4/5] 构建 MCP sidecar（solomd-mcp）..."
bash "$ROOT/scripts/build-mcp-sidecar.sh"

# ---------- 5. Tauri release 构建 ----------
echo "[5/5] tauri build（cargo $JOBS 并行，首次约 5-15 分钟）..."
(cd "$APP" && pnpm tauri build)

# ---------- 产物 ----------
echo
echo "=== 构建完成 ==="
ls -lh "$BUNDLE" 2>/dev/null || ls -lh "$APP/src-tauri/target/release/" | grep -iE "SoloMD|solomd" || true
echo
echo "提示: 清理产物请执行 bash scripts/ubuntu-build.sh clean（全部清理加 all）"
