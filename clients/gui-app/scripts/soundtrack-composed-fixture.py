"""Generate an owned, short dev soundtrack set in a directory served locally."""
import json
import math
import pathlib
import struct
import sys
import wave

folder = pathlib.Path(sys.argv[1])
folder.mkdir(parents=True, exist_ok=True)
rate = 16000
with wave.open(str(folder / "tone.wav"), "wb") as audio:
    audio.setparams((1, 2, rate, rate * 2, "NONE", "not compressed"))
    audio.writeframes(b"".join(
        struct.pack("<h", int(3000 * math.sin(2 * math.pi * 330 * i / rate) * min(1, i / 160, (rate * 2 - i) / 160)))
        for i in range(rate * 2)
    ))
manifest = {
    "version": 2,
    "tracks": [{"kind": "composed", "name": "fixture-tone", "title": "Fixture tone", "recording": "fixture-tone"}],
    "views": {view: ["fixture-tone"] for view in ("home", "task", "bot", "settings")},
    "stems": {"tracks": [], "recordings": [{"name": "fixture-tone", "file": "tone.wav"}]},
}
(folder / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
