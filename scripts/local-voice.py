"""Offline Vietnamese speech; deterministic scene boundaries, no cloud services."""
import json
import sys
import wave
from pathlib import Path
from piper import PiperVoice, SynthesisConfig

request_path = Path(sys.argv[1])
request = json.loads(request_path.read_text(encoding="utf-8-sig"))
voice = PiperVoice.load(request["model"])
directory = request_path.parent

def synthesize(scale):
    rows = []
    for scene in request["scenes"]:
        target = directory / ("scene-%s.wav" % scene["scene_id"])
        with wave.open(str(target), "wb") as stream:
            voice.synthesize_wav(scene["narration"], stream,
                                 syn_config=SynthesisConfig(length_scale=scale))
        with wave.open(str(target), "rb") as stream:
            seconds = stream.getnframes() / stream.getframerate()
        rows.append({"scene_id": scene["scene_id"], "path": str(target), "duration": seconds})
    return rows

rows = synthesize(1.0)
duration = sum(r["duration"] for r in rows)
scale = 1.0
if duration < 45 or duration > 60:
    scale = max(0.7, min(1.8, 55.0 / max(duration, 0.1)))
    rows = synthesize(scale)
(directory / "local-voice-result.json").write_text(
    json.dumps({"scenes": rows, "length_scale": scale,
                "timing_method": "measured-scenes-estimated-words"}, ensure_ascii=False), encoding="utf-8")
