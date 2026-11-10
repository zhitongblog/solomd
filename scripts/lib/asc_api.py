"""
App Store Connect API — just enough of it to take an uploaded build all the
way to "Waiting for Review".

No third-party packages on purpose. This runs on a release machine, and a
release script that needs `pip install` first is a release script that breaks
on the day you need it. ES256 is signed by shelling out to openssl and
converting the DER signature to the raw form JOSE wants; HTTP is urllib.
"""

import base64
import json
import os
import socket
import ssl
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.appstoreconnect.apple.com"

#: Apple's API is reachable directly from everywhere this runs, and the local
#: proxy this machine exports into the environment drops roughly five of every
#: six connections to it mid-handshake — enough to lose a release to a timeout
#: that looks like an Apple outage. Requests here therefore ignore the ambient
#: proxy. Set ASC_USE_PROXY=1 on a network where the proxy is the only way out.
_opener = (urllib.request.build_opener()
           if os.environ.get("ASC_USE_PROXY") == "1"
           else urllib.request.build_opener(urllib.request.ProxyHandler({})))


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _der_to_jose(der: bytes) -> bytes:
    """ECDSA signatures come out of openssl as DER `SEQUENCE { INTEGER r,
    INTEGER s }`; JWS wants r and s as two fixed 32-byte big-endian numbers.
    DER trims leading zeros and adds one back when the high bit is set, so
    neither half is reliably 32 bytes until it is padded here."""
    if der[0] != 0x30:
        raise ValueError("not a DER sequence")
    idx = 2 if der[1] < 0x80 else 2 + (der[1] & 0x7F)

    def read_int(i):
        if der[i] != 0x02:
            raise ValueError("expected DER INTEGER")
        length = der[i + 1]
        val = der[i + 2 : i + 2 + length]
        return val.lstrip(b"\x00").rjust(32, b"\x00"), i + 2 + length

    r, idx = read_int(idx)
    s, _ = read_int(idx)
    return r + s


def make_token(key_path: str, key_id: str, issuer_id: str, ttl: int = 1200) -> str:
    """A signed JWT for the API. Apple rejects anything longer than 20
    minutes, so the default is exactly that and tokens are made per run."""
    now = int(time.time())
    header = {"alg": "ES256", "kid": key_id, "typ": "JWT"}
    payload = {
        "iss": issuer_id,
        "iat": now,
        "exp": now + ttl,
        "aud": "appstoreconnect-v1",
    }
    signing_input = f"{_b64url(json.dumps(header, separators=(',', ':')).encode())}." \
                    f"{_b64url(json.dumps(payload, separators=(',', ':')).encode())}"
    der = subprocess.run(
        ["openssl", "dgst", "-sha256", "-sign", key_path],
        input=signing_input.encode(),
        capture_output=True,
        check=True,
    ).stdout
    return f"{signing_input}.{_b64url(_der_to_jose(der))}"


#: What a faked create hands back in a dry run. Anything reached through this
#: id does not exist at Apple, so reads against it are answered locally rather
#: than sent — otherwise a dry run dies on a 404 the moment it creates
#: something, which is exactly the run that most needs to finish.
DRY_ID = "DRY-RUN-ID"


class Client:
    def __init__(self, token: str, dry_run: bool = False):
        self.token = token
        self.dry_run = dry_run

    def _call(self, method, path, body=None, params=None):
        url = API + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        if self.dry_run and method != "GET":
            print(f"    [dry-run] {method} {url}")
            if body:
                print("    [dry-run] " + json.dumps(body, ensure_ascii=False)[:400])
            return {"data": {"id": DRY_ID, "attributes": {}}}
        if self.dry_run and DRY_ID in path:
            print(f"    [dry-run] GET {url} — resource would not exist yet")
            return {"data": []}
        data = json.dumps(body).encode() if body is not None else None
        # Reads are retried because the network between here and Apple drops
        # connections mid-handshake often enough to lose a release run to it.
        # Writes are not: a dropped POST may still have been applied, and every
        # write in this flow is re-runnable by starting the script again, which
        # finds what already exists instead of duplicating it.
        attempts = 4
        for attempt in range(1, attempts + 1):
            req = urllib.request.Request(url, data=data, method=method)
            req.add_header("Authorization", f"Bearer {self.token}")
            if data:
                req.add_header("Content-Type", "application/json")
            try:
                with _opener.open(req, timeout=90) as resp:
                    raw = resp.read()
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as e:
                detail = e.read().decode(errors="replace")
                try:
                    errs = json.loads(detail).get("errors", [])
                    detail = "; ".join(
                        f"{x.get('title')}: {x.get('detail')}" for x in errs
                    ) or detail
                except Exception:
                    pass
                raise RuntimeError(f"{method} {path} -> HTTP {e.code}: {detail}") from None
            except (urllib.error.URLError, ssl.SSLError, socket.timeout, OSError) as e:
                if attempt == attempts:
                    raise RuntimeError(f"{method} {path} -> {e}") from None
                print(f"    {method} {path}: {e} — retrying ({attempt}/{attempts - 1})")
                time.sleep(2 * attempt)

    def get(self, path, **params):
        return self._call("GET", path, params=params or None)

    def post(self, path, body):
        return self._call("POST", path, body=body)

    def patch(self, path, body):
        return self._call("PATCH", path, body=body)

    # -- the handful of resources this flow touches -------------------------

    def app_id(self, bundle_id: str) -> str:
        data = self.get("/v1/apps", **{"filter[bundleId]": bundle_id})["data"]
        if not data:
            raise RuntimeError(f"no app with bundleId {bundle_id}")
        return data[0]["id"]

    def find_build(self, app: str, platform: str, cf_bundle_version: str):
        """Builds are identified to Apple by CFBundleVersion, which is what
        `version` holds here — not the marketing version."""
        data = self.get(
            "/v1/builds",
            **{
                "filter[app]": app,
                "filter[preReleaseVersion.platform]": platform,
                "filter[version]": cf_bundle_version,
                "limit": 10,
            },
        )["data"]
        return data[0] if data else None

    def find_version(self, app: str, platform: str, version_string: str):
        """Read through the app, not through `/v1/appStoreVersions` — that
        collection is write-only to the API (`CREATE, DELETE, GET_INSTANCE,
        UPDATE`) and answers a plain GET with a 403."""
        data = self.get(
            f"/v1/apps/{app}/appStoreVersions",
            **{
                "filter[platform]": platform,
                "filter[versionString]": version_string,
                "limit": 10,
            },
        )["data"]
        return data[0] if data else None

    def find_editable_version(self, app: str, platform: str):
        """Find an existing unsubmitted / rejected version on this platform that
        blocks `create_version` (Apple allows only one editable version per
        platform at a time) so we can rename its `versionString` in place."""
        editable_states = (
            "PREPARE_FOR_SUBMISSION",
            "DEVELOPER_REJECTED",
            "REJECTED",
            "METADATA_REJECTED",
            "INVALID_BINARY",
        )
        data = self.get(
            f"/v1/apps/{app}/appStoreVersions",
            **{
                "filter[platform]": platform,
                "filter[appStoreState]": ",".join(editable_states),
                "limit": 10,
            },
        )["data"]
        if data:
            return data[0]
        # If an earlier version is sitting in WAITING_FOR_REVIEW or IN_REVIEW,
        # cancel its reviewSubmission so it returns to DEVELOPER_REJECTED and
        # can be superseded by the newer version.
        subs = self.get(
            "/v1/reviewSubmissions",
            **{
                "filter[app]": app,
                "filter[platform]": platform,
                "filter[state]": "WAITING_FOR_REVIEW,IN_REVIEW",
                "limit": 10,
            },
        )["data"]
        if subs:
            for s in subs:
                sid = s["id"]
                self.patch(
                    f"/v1/reviewSubmissions/{sid}",
                    {
                        "data": {
                            "type": "reviewSubmissions",
                            "id": sid,
                            "attributes": {"canceled": True},
                        }
                    },
                )
            for _ in range(10):
                time.sleep(2)
                data = self.get(
                    f"/v1/apps/{app}/appStoreVersions",
                    **{
                        "filter[platform]": platform,
                        "filter[appStoreState]": ",".join(editable_states),
                        "limit": 10,
                    },
                )["data"]
                if data:
                    break
        return data[0] if data else None

    def update_version_string(self, version_id: str, version_string: str):
        """Rename an existing editable `appStoreVersion` to `version_string`."""
        return self.patch(
            f"/v1/appStoreVersions/{version_id}",
            {
                "data": {
                    "type": "appStoreVersions",
                    "id": version_id,
                    "attributes": {"versionString": version_string},
                }
            },
        )["data"]

    def create_version(self, app: str, platform: str, version_string: str,
                       release_type: str = "AFTER_APPROVAL"):
        return self.post(
            "/v1/appStoreVersions",
            {
                "data": {
                    "type": "appStoreVersions",
                    "attributes": {
                        "platform": platform,
                        "versionString": version_string,
                        "releaseType": release_type,
                    },
                    "relationships": {
                        "app": {"data": {"type": "apps", "id": app}}
                    },
                }
            },
        )["data"]

    def set_export_compliance(self, build_id: str, uses_non_exempt: bool):
        """A build whose `usesNonExemptEncryption` is null is the "Missing
        Export Compliance" state, and review will not take it. The bundle
        should declare `ITSAppUsesNonExemptEncryption` so this never comes up;
        answering here is what rescues a build that was uploaded before it
        did."""
        return self.patch(
            f"/v1/builds/{build_id}",
            {
                "data": {
                    "type": "builds",
                    "id": build_id,
                    "attributes": {"usesNonExemptEncryption": uses_non_exempt},
                }
            },
        )

    def attach_build(self, version_id: str, build_id: str):
        return self._call(
            "PATCH",
            f"/v1/appStoreVersions/{version_id}/relationships/build",
            body={"data": {"type": "builds", "id": build_id}},
        )

    def localizations(self, version_id: str):
        return self.get(f"/v1/appStoreVersions/{version_id}/appStoreVersionLocalizations",
                        **{"limit": 200})["data"]

    def set_whats_new(self, localization_id: str, text: str):
        return self.patch(
            f"/v1/appStoreVersionLocalizations/{localization_id}",
            {
                "data": {
                    "type": "appStoreVersionLocalizations",
                    "id": localization_id,
                    "attributes": {"whatsNew": text},
                }
            },
        )

    def submit_for_review(self, app: str, platform: str, version_id: str):
        """The current flow: a reviewSubmission holds items, then gets
        flipped to submitted. `appStoreVersionSubmissions` is the old one and
        is gone for apps using the unified submission experience."""
        existing = self.get(
            "/v1/reviewSubmissions",
            **{
                "filter[app]": app,
                "filter[platform]": platform,
                "filter[state]": "READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW",
                "limit": 10,
            },
        )["data"]
        open_subs = [s for s in existing
                     if s["attributes"].get("state") == "READY_FOR_REVIEW"]
        if open_subs:
            submission = open_subs[0]
        else:
            submission = self.post(
                "/v1/reviewSubmissions",
                {
                    "data": {
                        "type": "reviewSubmissions",
                        "attributes": {"platform": platform},
                        "relationships": {
                            "app": {"data": {"type": "apps", "id": app}}
                        },
                    }
                },
            )["data"]
        self.post(
            "/v1/reviewSubmissionItems",
            {
                "data": {
                    "type": "reviewSubmissionItems",
                    "relationships": {
                        "reviewSubmission": {
                            "data": {"type": "reviewSubmissions", "id": submission["id"]}
                        },
                        "appStoreVersion": {
                            "data": {"type": "appStoreVersions", "id": version_id}
                        },
                    },
                }
            },
        )
        return self.patch(
            f"/v1/reviewSubmissions/{submission['id']}",
            {
                "data": {
                    "type": "reviewSubmissions",
                    "id": submission["id"],
                    "attributes": {"submitted": True},
                }
            },
        )
