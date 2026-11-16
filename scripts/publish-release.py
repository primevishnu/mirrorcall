import os
import sys
import json
import urllib.request
import subprocess
from pathlib import Path

REPO = "primevishnu/mirrorcall"
TAG = "v2.1.0"
RELEASE_NAME = "MirrorCall 2.1.0"
DIST_DIR = Path(__file__).resolve().parent.parent / "dist"
APK_NAME = "MirrorCall-2.1.0.apk"
SHA_NAME = "MirrorCall-2.1.0.apk.sha256"

RELEASE_NOTES = """## MirrorCall 2.1.0

Private, two-person peer-to-peer Android video calls with on-the-fly camera flip / mirroring.

### What's New in 2.1.0
- **Control preferences:** Settings offers 4s, 8s or Always visible controls with accessibility support.
- **Pre-call choices:** Home-screen remembers start-muted, camera-off and initial camera choice.
- **Share-menu import:** Share complete MC1 codes directly from compatible apps.
- **Audio-output picker:** Route calls through available audio outputs (speaker, phone, Bluetooth) on Android 12+.
- **Notification controls:** Ongoing call notification with Mute/Unmute and Hang up actions.
- **Diagnostics & Health:** Call health sheet with bounded memory logs and redacted IP addresses/credentials.

### Installation
1. Download `MirrorCall-2.1.0.apk` below.
2. Install on two Android devices (Android 8.0+ required, ARM64 / ARMv7).
3. Grant camera and microphone permissions.
4. Follow the in-app instructions to start a private call and exchange setup codes.

**SHA-256 Checksum:** `f2ebbe9312e19020b0d6928e5d5dc20b28b2d66a1fbe04462f262416e1ba47e4`
"""

def main():
    token = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("GITHUB_TOKEN")
    if not token:
        print("Error: GITHUB_TOKEN environment variable or command-line argument required.")
        print("Usage: python scripts/publish-release.py <GITHUB_PAT_TOKEN>")
        sys.exit(1)

    # 1. Push code and tag
    print("Pushing main branch and tags to GitHub...")
    remote_url = f"https://x-access-token:{token}@github.com/{REPO}.git"
    res = subprocess.run(["git", "push", remote_url, "main", "--tags"], capture_output=True, text=True)
    if res.returncode != 0:
        print("Git push error:", res.stderr)
        sys.exit(res.returncode)
    print("Code and tags pushed successfully.")

    # 2. Update repository metadata (topics and description)
    print("Updating repository metadata...")
    req_meta = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "MirrorCall-Release-Script"
        },
        data=json.dumps({
            "description": "Private, two-person Android video calls with on-the-fly camera flip/mirroring (WebRTC).",
            "homepage": f"https://github.com/{REPO}#readme"
        }).encode("utf-8"),
        method="PATCH"
    )
    try:
        with urllib.request.urlopen(req_meta) as resp:
            print("Repository details updated.")
    except Exception as e:
        print("Warning updating repo info:", e)

    req_topics = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}/topics",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "MirrorCall-Release-Script"
        },
        data=json.dumps({
            "names": ["android", "webrtc", "video-calling", "camera-flip", "privacy", "peer-to-peer", "camera2", "open-source"]
        }).encode("utf-8"),
        method="PUT"
    )
    try:
        with urllib.request.urlopen(req_topics) as resp:
            print("Topics updated.")
    except Exception as e:
        print("Warning updating topics:", e)

    # 3. Create GitHub Release
    print(f"Creating release {TAG}...")
    req_rel = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}/releases",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "MirrorCall-Release-Script"
        },
        data=json.dumps({
            "tag_name": TAG,
            "target_commitish": "main",
            "name": RELEASE_NAME,
            "body": RELEASE_NOTES,
            "draft": False,
            "prerelease": False
        }).encode("utf-8"),
        method="POST"
    )
    try:
        with urllib.request.urlopen(req_rel) as resp:
            release_data = json.loads(resp.read().decode("utf-8"))
            release_id = release_data["id"]
            upload_url_template = release_data["upload_url"]  # format: .../assets{?name,label}
            print(f"Release created successfully (ID: {release_id}).")
    except urllib.error.HTTPError as e:
        if e.code == 422:
            print(f"Release for {TAG} may already exist, fetching existing release...")
            req_get = urllib.request.Request(
                f"https://api.github.com/repos/{REPO}/releases/tags/{TAG}",
                headers={"Authorization": f"Bearer {token}", "User-Agent": "MirrorCall-Release-Script"}
            )
            with urllib.request.urlopen(req_get) as resp:
                release_data = json.loads(resp.read().decode("utf-8"))
                upload_url_template = release_data["upload_url"]
        else:
            print("Error creating release:", e.read().decode())
            sys.exit(1)

    # 4. Upload assets
    base_upload_url = upload_url_template.split("{")[0]

    for asset_name, content_type in [
        (APK_NAME, "application/vnd.android.package-archive"),
        (SHA_NAME, "text/plain")
    ]:
        asset_file = DIST_DIR / asset_name
        if not asset_file.exists():
            print(f"Warning: {asset_file} not found, skipping.")
            continue
        print(f"Uploading {asset_name} ({asset_file.stat().st_size} bytes)...")
        with open(asset_file, "rb") as f:
            data = f.read()

        req_upload = urllib.request.Request(
            f"{base_upload_url}?name={asset_name}",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": content_type,
                "Content-Length": str(len(data)),
                "User-Agent": "MirrorCall-Release-Script"
            },
            data=data,
            method="POST"
        )
        try:
            with urllib.request.urlopen(req_upload) as resp:
                print(f"Successfully uploaded {asset_name} to release!")
        except Exception as e:
            print(f"Error uploading {asset_name}:", e)

    print("\nRelease publish completed successfully!")
    print(f"View release at: https://github.com/{REPO}/releases/tag/{TAG}")

if __name__ == "__main__":
    main()
