"""CI packaging: one commit-addressed release with a digest-pinned manifest.
The rolling dev release is for manual installs; auto-update never consumes it.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1])
sha = os.environ["BRIDGE_BUILD_COMMIT"]
tag = "runner-" + sha
assets = sorted(root.glob("bridge-*.tar.gz"))
if len(assets) != 4:
    raise SystemExit("all four platform builds are required before publication")
manifest = {"schema_version": 1, "commit": sha, "artifacts": {
    path.name.removeprefix("bridge-").removesuffix(".tar.gz"): {
        "url": f"https://github.com/state-vector/bridge/releases/download/{tag}/{path.name}",
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    } for path in assets
}}
path = root / "manifest.json"
path.write_text(json.dumps(manifest, indent=2) + "\n")
if subprocess.run(["gh", "release", "view", tag], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
    # A rerun must not overwrite a previously distributed build. Its original
    # manifest remains the one canonical artifact set for this source commit.
    subprocess.run(["gh", "release", "download", tag, "--pattern", "manifest.json", "--dir", str(root / "existing")], check=True)
    old = json.loads((root / "existing/manifest.json").read_text())
    if old.get("commit") != sha or old.get("schema_version") != 1:
        raise SystemExit("existing immutable release has invalid provenance")
else:
    subprocess.run(["gh", "release", "create", tag, "--target", sha, "--prerelease", "--latest=false",
                    "--title", tag, "--notes", f"Commit-addressed runner build {sha}; auto-update promotion requires green CI.",
                    *map(str, assets), str(path)], check=True)
