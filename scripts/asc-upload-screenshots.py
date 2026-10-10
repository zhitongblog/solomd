#!/usr/bin/env python3
"""
Replace the App Store screenshots of a version, per locale, from a folder.

    scripts/asc-upload-screenshots.py --platform ios   --version 5.0.0 \\
        --dir app-store/v5/screenshots/ios-iphone \\
        --dir app-store/v5/screenshots/ios-ipad --dry-run
    scripts/asc-upload-screenshots.py --platform macos --version 5.0.0 \\
        --dir app-store/v5/screenshots/macos

Each --dir holds one folder per App Store locale (`en-US/`, `zh-Hans/`, ...)
with `NN-name.png` files; they are uploaded in file-name order. The display
type (the screenshot "slot") is worked out from the pixel size, so one folder
must hold one size only:

    1320x2868 / 1290x2796 / 1260x2736  -> APP_IPHONE_67  (the 6.9" slot; the
                                          API has no separate _69 type)
    2064x2752 / 2048x2732 (+landscape) -> APP_IPAD_PRO_3GEN_129  (13")
    2880x1800 / 2560x1600 / 1440x900 / 1280x800 -> APP_DESKTOP

For every locale folder whose locale the version has, the existing screenshot
set of that display type is emptied (every screenshot in it deleted) and the
new files go up through Apple's asset flow: create an appScreenshot
(reservation, which returns upload operations) -> PUT each chunk to the URL it
names -> PATCH uploaded=true with the file's MD5 as sourceFileChecksum. The
script then waits for Apple to finish processing and puts the set in file
order. A locale folder the version does not have is skipped with a warning —
add the locale first (scripts/asc-apply-metadata.py creates missing ones).

Older smaller-device sets are not touched by default. A device size that has
its own set shows that set, so a leftover APP_IPHONE_65 set (4.x shots, which
the live listing has) keeps showing old screenshots on 6.5" iPhones even after
the 6.9" set is replaced. Pass --also-clear APP_IPHONE_65 (repeatable) to empty
those sets too; Apple then scales the new 6.9" set down for them.

--dry-run reads everything (app, version, localizations, existing sets and
their screenshots) and prints what it would delete and upload, writing
nothing. It also runs against a version that can no longer be edited, so it
can be tried on the live one.

Auth as in asc-apply-metadata.py: ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_PATH,
or the key in ~/.appstoreconnect.
"""

import argparse
import glob
import hashlib
import os
import struct
import sys
import time
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from asc_api import Client, make_token, _opener  # noqa: E402

BUNDLE_ID = "app.solomd"
PLATFORMS = {"ios": "IOS", "macos": "MAC_OS", "mac": "MAC_OS"}
#: Versions in these states can still take screenshot edits.
EDITABLE = {"PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED",
            "METADATA_REJECTED", "INVALID_BINARY"}

_IPHONE_69 = {(1320, 2868), (1290, 2796), (1260, 2736)}
_IPAD_13 = {(2064, 2752), (2048, 2732)}
_DESKTOP = {(2880, 1800), (2560, 1600), (1440, 900), (1280, 800)}


def display_type(w, h):
    size = (min(w, h), max(w, h))
    if size in _IPHONE_69:
        return "APP_IPHONE_67", "IOS"
    if size in _IPAD_13:
        return "APP_IPAD_PRO_3GEN_129", "IOS"
    if (w, h) in _DESKTOP:
        return "APP_DESKTOP", "MAC_OS"
    return None, None


def png_size(path):
    with open(path, "rb") as f:
        head = f.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path}: not a PNG")
    return struct.unpack(">II", head[16:24])


def credentials():
    key_id = os.environ.get("ASC_KEY_ID")
    issuer = os.environ.get("ASC_ISSUER_ID")
    path = os.environ.get("ASC_KEY_PATH")
    home = os.path.expanduser("~/.appstoreconnect")
    if not path:
        keys = sorted(glob.glob(os.path.join(home, "private_keys", "AuthKey_*.p8")))
        if keys:
            path = keys[0]
    if path and not key_id:
        key_id = os.path.basename(path)[len("AuthKey_"):-len(".p8")]
    if not issuer and os.path.exists(os.path.join(home, "issuer_id")):
        issuer = open(os.path.join(home, "issuer_id")).read().strip()
    if not (key_id and issuer and path):
        sys.exit("ERROR: no App Store Connect key (ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_PATH)")
    return path, key_id, issuer


def scan(folders, platform):
    """{locale: {display_type: [paths in order]}}, validated before anything
    is sent: every file a PNG of a known size for this platform."""
    plan, problems = {}, []
    for folder in folders:
        locales = sorted(d for d in os.listdir(folder)
                         if os.path.isdir(os.path.join(folder, d)) and not d.startswith("."))
        if not locales:
            problems.append(f"{folder}: no locale folders")
        for locale in locales:
            files = sorted(glob.glob(os.path.join(folder, locale, "*.png")))
            if not files:
                problems.append(f"{folder}/{locale}: no PNG files")
            for path in files:
                w, h = png_size(path)
                dtype, plat = display_type(w, h)
                if dtype is None:
                    problems.append(f"{path}: {w}x{h} is not an accepted screenshot size")
                elif plat != platform:
                    problems.append(f"{path}: {w}x{h} ({dtype}) is not a {platform} size")
                else:
                    plan.setdefault(locale, {}).setdefault(dtype, []).append(path)
    for locale, sets in plan.items():
        for dtype, files in sets.items():
            if len(files) > 10:
                problems.append(f"{locale} {dtype}: {len(files)} screenshots (max 10)")
    if problems:
        sys.exit("ERROR:\n  " + "\n  ".join(problems))
    return plan


def upload_one(client, set_id, path):
    data = open(path, "rb").read()
    name = os.path.basename(path)
    shot = client.post("/v1/appScreenshots", {
        "data": {"type": "appScreenshots",
                 "attributes": {"fileName": name, "fileSize": len(data)},
                 "relationships": {"appScreenshotSet": {
                     "data": {"type": "appScreenshotSets", "id": set_id}}}}})["data"]
    if client.dry_run:
        print(f"    [dry-run] PUT {len(data)} bytes in Apple's upload operations, "
              f"then PATCH uploaded=true sourceFileChecksum={hashlib.md5(data).hexdigest()}")
        return shot["id"]
    for op in shot["attributes"]["uploadOperations"]:
        chunk = data[op["offset"]: op["offset"] + op["length"]]
        req = urllib.request.Request(op["url"], data=chunk, method=op["method"])
        for header in op.get("requestHeaders") or []:
            req.add_header(header["name"], header["value"])
        for attempt in range(1, 5):
            try:
                with _opener.open(req, timeout=120) as resp:
                    resp.read()
                break
            except Exception as e:  # noqa: BLE001 — chunk PUTs are idempotent
                if attempt == 4:
                    raise RuntimeError(f"{name}: chunk at {op['offset']} failed: {e}") from None
                print(f"      chunk {op['offset']}: {e} — retrying")
                time.sleep(3 * attempt)
    client.patch(f"/v1/appScreenshots/{shot['id']}", {
        "data": {"type": "appScreenshots", "id": shot["id"],
                 "attributes": {"uploaded": True,
                                "sourceFileChecksum": hashlib.md5(data).hexdigest()}}})
    return shot["id"]


def wait_processed(client, ids, timeout=600):
    """Apple processes uploads asynchronously; a FAILED one says why."""
    pending, deadline = set(ids), time.time() + timeout
    while pending and time.time() < deadline:
        for sid in sorted(pending):
            attrs = client.get(f"/v1/appScreenshots/{sid}")["data"]["attributes"]
            state = (attrs.get("assetDeliveryState") or {}).get("state")
            if state == "COMPLETE":
                pending.discard(sid)
            elif state == "FAILED":
                errs = (attrs.get("assetDeliveryState") or {}).get("errors")
                raise RuntimeError(f"{attrs.get('fileName')}: processing FAILED {errs}")
        if pending:
            time.sleep(5)
    if pending:
        raise RuntimeError(f"{len(pending)} screenshot(s) still processing after {timeout}s")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--platform", required=True, choices=sorted(PLATFORMS))
    ap.add_argument("--version", required=True)
    ap.add_argument("--dir", required=True, action="append",
                    help="app-store/v5/screenshots/<store>; repeat for iPhone + iPad")
    ap.add_argument("--also-clear", action="append", default=[], metavar="DISPLAY_TYPE",
                    help="also empty this display type's set in each locale (e.g. APP_IPHONE_65)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    platform = PLATFORMS[args.platform]
    plan = scan(args.dir, platform)
    total = sum(len(f) for s in plan.values() for f in s.values())
    print(f"==> {total} screenshots, {len(plan)} locales: {', '.join(sorted(plan))}")

    client = Client(make_token(*credentials()), dry_run=args.dry_run)
    app = client.app_id(BUNDLE_ID)
    version = client.find_version(app, platform, args.version)
    if version is None:
        sys.exit(f"ERROR: no {platform} version {args.version} — create it first "
                 "(scripts/asc-apply-metadata.py)")
    state = version["attributes"].get("appStoreState")
    print(f"==> {platform} {args.version} ({state})")
    if state not in EDITABLE:
        if not args.dry_run:
            sys.exit(f"ERROR: {args.version} is {state}; its screenshots can no longer be changed")
        print(f"    (not editable — a real run would stop here; dry run continues read-only)")

    have = {l["attributes"]["locale"]: l for l in client.localizations(version["id"])}
    skipped = sorted(set(plan) - set(have))
    for locale in sorted(plan):
        if locale not in have:
            continue
        loc_id = have[locale]["id"]
        sets = {s["attributes"]["screenshotDisplayType"]: s for s in client.get(
            f"/v1/appStoreVersionLocalizations/{loc_id}/appScreenshotSets", limit=50)["data"]}
        for dtype in args.also_clear:
            if dtype in plan[locale] or dtype not in sets:
                continue
            old = client.get(f"/v1/appScreenshotSets/{sets[dtype]['id']}/appScreenshots",
                             limit=50)["data"]
            print(f"  {locale} {dtype}: emptying ({len(old)} screenshot(s), --also-clear)")
            for shot in old:
                print(f"    - {shot['attributes'].get('fileName')}")
                client._call("DELETE", f"/v1/appScreenshots/{shot['id']}")
        for dtype, files in plan[locale].items():
            print(f"  {locale} {dtype}: {len(files)} new")
            if dtype in sets:
                set_id = sets[dtype]["id"]
                old = client.get(f"/v1/appScreenshotSets/{set_id}/appScreenshots",
                                 limit=50)["data"]
                print(f"    existing set {set_id}: {len(old)} screenshot(s) to delete")
                for shot in old:
                    a = shot["attributes"]
                    dims = (a.get("imageAsset") or {})
                    print(f"    - {a.get('fileName')} "
                          f"({dims.get('width')}x{dims.get('height')})")
                    client._call("DELETE", f"/v1/appScreenshots/{shot['id']}")
            else:
                print("    no set of this type yet — creating one")
                set_id = client.post("/v1/appScreenshotSets", {
                    "data": {"type": "appScreenshotSets",
                             "attributes": {"screenshotDisplayType": dtype},
                             "relationships": {"appStoreVersionLocalization": {
                                 "data": {"type": "appStoreVersionLocalizations",
                                          "id": loc_id}}}}})["data"]["id"]
            ids = []
            for path in files:
                w, h = png_size(path)
                print(f"    + {os.path.basename(path)} ({w}x{h}, {os.path.getsize(path)} B)")
                ids.append(upload_one(client, set_id, path))
            if not args.dry_run:
                wait_processed(client, ids)
                client.patch(f"/v1/appScreenshotSets/{set_id}/relationships/appScreenshots", {
                    "data": [{"type": "appScreenshots", "id": i} for i in ids]})
                print(f"    processed and ordered")
    if skipped:
        print(f"==> skipped (version has no such locale): {', '.join(skipped)}")
    extra = sorted(set(have) - set(plan))
    if extra:
        print(f"==> left as they are (no folder): {', '.join(extra)}")
    print("==> done" + (" (dry run, nothing written)" if args.dry_run else ""))


if __name__ == "__main__":
    main()
