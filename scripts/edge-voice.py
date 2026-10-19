"""One continuous Nam Minh performance, fixed cadence, service word boundaries."""
import asyncio
import json
import sys
from pathlib import Path
import edge_tts

async def main():
    request_path = Path(sys.argv[1])
    request = json.loads(request_path.read_text(encoding="utf-8-sig"))
    directory = request_path.parent
    audio = directory / "voice.mp3"
    boundaries = directory / "edge-boundaries.jsonl"
    for attempt in range(2):
        try:
            communicate = edge_tts.Communicate(
                request["narration"], voice=request["voice"], rate=request["rate"],
                pitch=request["pitch"], boundary="WordBoundary", connect_timeout=10, receive_timeout=45)
            await asyncio.wait_for(communicate.save(str(audio), str(boundaries)), timeout=90)
            rows = [json.loads(line) for line in boundaries.read_text(encoding="utf-8").splitlines() if line.strip()]
            words = [{"word": row["text"], "start": row["offset"] / 10000000,
                      "end": (row["offset"] + row["duration"]) / 10000000}
                     for row in rows if row.get("type") == "WordBoundary"]
            if not words or audio.stat().st_size < 1000:
                raise RuntimeError("Missing speech or word boundaries")
            (directory / "edge-voice-result.json").write_text(json.dumps({"words": words}), encoding="utf-8")
            return
        except Exception:
            if attempt == 1:
                raise
            await asyncio.sleep(2)

try:
    asyncio.run(main())
except Exception as error:
    print("Edge Nam Minh speech unavailable (%s); no paid API fallback" % type(error).__name__, file=sys.stderr)
    sys.exit(1)
