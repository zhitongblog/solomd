#!/usr/bin/env python3
"""
Write an App Store listing — description, keywords, promotional text,
subtitle — for every locale in a folder, onto an editable version.

    scripts/asc-apply-metadata.py --platform ios   --version 5.0.0 --dir app-store/v5 --dry-run
    scripts/asc-apply-metadata.py --platform macos --version 5.0.0 --dir app-store/v5

The folder holds `<platform>.<locale>.md` (the description; platform is `ios`
or `macos`) and `shared.json` ({locale: {subtitle, keywords,
promotionalText}}). A locale the version does not have yet is created, which
is how a new store language is added. Run it before submit-for-review.sh:
it creates the version if there is none (no build attached), and the submit
script then finds it, attaches the build, writes What's New for every locale
— so the notes folder needs a file for any locale added here — and submits.

Auth: ASC_KEY_ID / ASC_ISSUER_ID / ASC_KEY_PATH, or the key in
~/.appstoreconnect (private_keys/AuthKey_<id>.p8 + issuer_id).
"""

import argparse
import glob
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from asc_api import Client, make_token  # noqa: E402

BUNDLE_ID = "app.solomd"
PLATFORMS = {"ios": "IOS", "macos": "MAC_OS", "mac": "MAC_OS"}
LIMITS = {"description": 4000, "keywords": 100, "promotionalText": 170, "subtitle": 30}
#: Versions in these states can still take listing edits.
EDITABLE = {"PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED",
            "METADATA_REJECTED", "INVALID_BINARY"}


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


def load(folder, plat_key):
    shared = json.load(open(os.path.join(folder, "shared.json"), encoding="utf-8"))
    prefix = "macos" if plat_key in ("macos", "mac") else "ios"
    listing = {}
    for path in sorted(glob.glob(os.path.join(folder, f"{prefix}.*.md"))):
        locale = os.path.basename(path)[len(prefix) + 1:-3]
        listing[locale] = {"description": open(path, encoding="utf-8").read().strip()}
    missing = sorted(set(listing) ^ set(shared))
    if missing:
        sys.exit(f"ERROR: locales without both a {prefix}.<locale>.md and a shared.json entry: "
                 f"{', '.join(missing)}")
    problems = []
    for locale, fields in listing.items():
        fields.update(shared[locale])
        for name, limit in LIMITS.items():
            if len(fields.get(name) or "") > limit:
                problems.append(f"{locale} {name}: {len(fields[name])} > {limit}")
    if problems:
        sys.exit("ERROR: over App Store limits:\n  " + "\n  ".join(problems))
    return listing


def editable_app_info(client, app):
    """The app info record that can be edited. A new version brings one in
    PREPARE_FOR_SUBMISSION; one that is waiting for or in review is locked."""
    infos = client.get(f"/v1/apps/{app}/appInfos")["data"]
    for info in infos:
        state = info["attributes"].get("appStoreState") or info["attributes"].get("state")
        if state in EDITABLE:
            return info
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--platform", required=True, choices=sorted(PLATFORMS))
    ap.add_argument("--version", required=True)
    ap.add_argument("--dir", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    listing = load(args.dir, args.platform)
    print(f"==> {len(listing)} locales: {', '.join(listing)}")
    client = Client(make_token(*credentials()), dry_run=args.dry_run)
    app = client.app_id(BUNDLE_ID)
    platform = PLATFORMS[args.platform]

    version = client.find_version(app, platform, args.version)
    if version is None:
        print(f"==> creating {platform} {args.version}")
        version = client.create_version(app, platform, args.version)
    else:
        state = version["attributes"].get("appStoreState")
        print(f"==> {platform} {args.version} exists ({state})")
        if state not in EDITABLE:
            sys.exit(f"ERROR: {args.version} is {state}; its listing can no longer be edited")

    have = {l["attributes"]["locale"]: l for l in client.localizations(version["id"])}
    for locale, fields in listing.items():
        attrs = {k: fields[k] for k in ("description", "keywords", "promotionalText")}
        if locale in have:
            print(f"    {locale}: update")
            client.patch(f"/v1/appStoreVersionLocalizations/{have[locale]['id']}", {
                "data": {"type": "appStoreVersionLocalizations", "id": have[locale]["id"],
                         "attributes": attrs}})
        else:
            print(f"    {locale}: NEW locale")
            client.post("/v1/appStoreVersionLocalizations", {
                "data": {"type": "appStoreVersionLocalizations",
                         "attributes": {"locale": locale, **attrs},
                         "relationships": {"appStoreVersion": {
                             "data": {"type": "appStoreVersions", "id": version["id"]}}}}})
    extra = sorted(set(have) - set(listing))
    if extra:
        print(f"    left as they are (not in {args.dir}): {', '.join(extra)}")

    # Subtitle and name live on the app info, shared by iOS and macOS.
    info = editable_app_info(client, app)
    if info is None:
        print("==> no editable app info (nothing pending) — subtitles not written")
        return
    have_info = {l["attributes"]["locale"]: l for l in client.get(
        f"/v1/appInfos/{info['id']}/appInfoLocalizations", limit=200)["data"]}
    for locale, fields in listing.items():
        if locale in have_info:
            if have_info[locale]["attributes"].get("subtitle") == fields["subtitle"]:
                continue
            print(f"    subtitle {locale}: update")
            client.patch(f"/v1/appInfoLocalizations/{have_info[locale]['id']}", {
                "data": {"type": "appInfoLocalizations", "id": have_info[locale]["id"],
                         "attributes": {"subtitle": fields["subtitle"]}}})
        else:
            print(f"    subtitle {locale}: NEW locale")
            client.post("/v1/appInfoLocalizations", {
                "data": {"type": "appInfoLocalizations",
                         "attributes": {"locale": locale, "name": "SoloMD",
                                        "subtitle": fields["subtitle"]},
                         "relationships": {"appInfo": {
                             "data": {"type": "appInfos", "id": info["id"]}}}}})
    print("==> done")


if __name__ == "__main__":
    main()
