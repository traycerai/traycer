#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT=.github/rolaand-local/bootstrap-build.sh
python3 - "$SCRIPT" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()

text = text.replace(
    'ROLFOX_RAW="https://raw.githubusercontent.com/Rolaand-Jayz/Rolfox/main"\n',
    'OPTIMIZATION_PAYLOAD_URL="https://raw.githubusercontent.com/Rolaand-Jayz/Rolfox/5633cfc1c4b7f536942ea672cf5ef8c5d601b224/.github/patches/apply_patches.py.gz.b64"\n'
    'LOCAL_PATCH_PAYLOAD_URL="https://raw.githubusercontent.com/Rolaand-Jayz/Rolfox/b86ade0ba939a504730da245438cac93b0fdcc78/.github/patches/traycer-local-only.patch.gz.b64"\n',
    1,
)

old_optimization = '''curl -fsSL --retry 3 \\
  "$ROLFOX_RAW/.github/patches/apply_patches.py.gz.b64" \\
  | base64 -d | gunzip > /tmp/apply-optimizations.py
'''
new_optimization = '''curl -fsSL --retry 3 "$OPTIMIZATION_PAYLOAD_URL" \\
  | base64 -d | gunzip > /tmp/apply-optimizations.py
'''
if old_optimization not in text:
    raise SystemExit("optimization payload block was not found")
text = text.replace(old_optimization, new_optimization, 1)

old_local = '''# Reassemble and verify the accountless/local-only source patch.
: > /tmp/traycer-local.patch.gz.b64
for part in $(seq -w 0 8); do
  curl -fsSL --retry 3 \\
    "$ROLFOX_RAW/.github/patches/traycer-local-only.parts/part-$part" \\
    >> /tmp/traycer-local.patch.gz.b64
done
'''
new_local = '''# Download and verify the immutable accountless/local-only source patch.
curl -fsSL --retry 3 "$LOCAL_PATCH_PAYLOAD_URL" \\
  -o /tmp/traycer-local.patch.gz.b64
'''
if old_local not in text:
    raise SystemExit("local patch payload block was not found")
text = text.replace(old_local, new_local, 1)

if "ROLFOX_RAW" in text:
    raise SystemExit("mutable Rolfox payload reference remains")

path.write_text(text)
PY

exec bash "$SCRIPT"
