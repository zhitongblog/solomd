# title: install release APK; installed md5, versionName, frontend time chain
# row: build
#
# Two traps make an Android self-test silently run stale code (memory:
# reference_android_build_selftest_gotchas): gradle not re-embedding app/dist
# into libapp_lib.so, and `adb install -r` failing quietly on a signature
# mismatch. So: uninstall first, install, then PROVE the installed package is
# the APK we built and that the APK carries the current frontend.
run_check() {
  if [ "$INSTALL" -eq 0 ]; then
    local vn; vn=$(sh_ dumpsys package "$PKG" | grep -m1 versionName | cut -d= -f2)
    force_stop; sh_ pm clear "$PKG" >/dev/null
    pass "--no-install: testing installed versionName=$vn (not verified against a build)"
    return
  fi
  local errs=() gen="$REPO/app/src-tauri/gen/android/app"
  note "apk: $APK"

  # 1. which libapp_lib.so went into the APK: gradle copies cargo's output into
  # merged_jni_libs and packages it byte-for-byte (the stripped copy has the
  # same md5). target/…/libapp_lib.so is NOT usable here: the .aab step re-links
  # it after the APKs are packaged and the link is not bit-reproducible.
  local tmp apk_so jni_so dist_m so_m apk_m
  tmp=$(mktemp -d)
  unzip -o -q "$APK" 'lib/arm64-v8a/libapp_lib.so' -d "$tmp" 2>/dev/null
  apk_so="$tmp/lib/arm64-v8a/libapp_lib.so"
  jni_so=$(ls -t "$gen"/build/intermediates/merged_jni_libs/*/*/out/arm64-v8a/libapp_lib.so 2>/dev/null | head -1)
  if [ ! -f "$apk_so" ]; then
    errs+=("no arm64 libapp_lib.so in the APK")
  elif [ -z "$jni_so" ]; then
    errs+=("no merged_jni_libs arm64 libapp_lib.so (APK not built in this checkout?)")
  else
    if [ "$(md5 -q "$apk_so")" = "$(md5 -q "$jni_so")" ]; then note "APK .so == merged_jni_libs .so ($(md5 -q "$apk_so"))"
    else errs+=("APK libapp_lib.so differs from merged_jni_libs (stale packaging)"); fi
    # 2. time chain: app/dist < the cargo link that embedded it < the APK
    dist_m=$(stat -f %m "$REPO/app/dist/index.html" 2>/dev/null || echo 0)
    so_m=$(stat -f %m "$jni_so"); apk_m=$(stat -f %m "$APK")
    note "mtimes: dist=$(date -r "$dist_m" +%T) so=$(date -r "$so_m" +%T) apk=$(date -r "$apk_m" +%T)"
    [ "$dist_m" -gt 0 ] && [ "$so_m" -gt "$dist_m" ] || errs+=("libapp_lib.so not newer than app/dist (frontend not re-embedded)")
    [ "$apk_m" -ge "$so_m" ] || errs+=("APK older than its libapp_lib.so")
    # 16 KB page alignment (Play hard requirement since 4.13.0)
    local rdelf; rdelf=$(ls "${ANDROID_NDK_HOME:-/nonexistent}"/toolchains/llvm/prebuilt/*/bin/llvm-readelf 2>/dev/null | head -1)
    [ -z "$rdelf" ] && rdelf=$(ls -d "${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"/ndk/*/toolchains/llvm/prebuilt/*/bin/llvm-readelf 2>/dev/null | tail -1)
    [ -z "$rdelf" ] && rdelf=$(command -v llvm-readelf || true)
    if [ -n "$rdelf" ]; then
      local al; al=$("$rdelf" -lW "$apk_so" | awk '$1=="LOAD"{print $NF}' | sort -u | tr '\n' ' ')
      note "LOAD align: $al"
      [ "$al" = "0x4000 " ] || errs+=("libapp_lib.so LOAD alignment '$al' (need 0x4000)")
    fi
  fi
  rm -rf "$tmp"

  # 3. the dist is the 5.0 frontend (PhoneTabBar exists only from 5.0)
  if grep -rqs 'ptab__btn' "$REPO/app/dist/assets/" ; then note "dist has 5.0 phone shell (ptab__btn)"
  else errs+=("app/dist has no 5.0 phone shell string 'ptab__btn'"); fi

  # 4. install clean (signature-safe) and md5-verify what the device has
  force_stop
  sh_ pm uninstall "$PKG" >/dev/null 2>&1
  local inst; inst=$($ADB install "$APK" 2>&1 | tail -1)
  note "install: $inst"
  [[ "$inst" == *Success* ]] || errs+=("adb install: $inst")
  local dev_path dev_md5 loc_md5
  dev_path=$(sh_ pm path "$PKG" | head -1 | sed 's/^package://')
  dev_md5=$(sh_ md5sum "$dev_path" | awk '{print $1}')
  loc_md5=$(md5 -q "$APK")
  note "md5 device=$dev_md5 local=$loc_md5"
  [ -n "$dev_md5" ] && [ "$dev_md5" = "$loc_md5" ] || errs+=("installed APK md5 differs from $APK")

  local vn vc want
  vn=$(sh_ dumpsys package "$PKG" | grep -m1 versionName | cut -d= -f2)
  vc=$(sh_ dumpsys package "$PKG" | grep -m1 -oE 'versionCode=[0-9]+' | cut -d= -f2)
  want=$(python3 -c "import json;print(json.load(open('$REPO/app/src-tauri/tauri.conf.json'))['version'])")
  note "installed versionName=$vn versionCode=$vc (tauri.conf.json $want)"
  [ "$vn" = "$want" ] || errs+=("versionName $vn != tauri.conf.json $want")

  if [ ${#errs[@]} -eq 0 ]; then pass "versionName $vn ($vc), md5 match, .so newer than dist, 5.0 frontend, 16KB aligned"
  else fail "$(IFS=';'; echo "${errs[*]}")"; fi
}
