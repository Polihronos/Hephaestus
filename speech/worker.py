"""Persistent local speech recognition. Audio never goes to an inference service."""
import base64
import json
import os
import sys
import time

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
sys.stdout.reconfigure(encoding="utf-8")
from faster_whisper import WhisperModel
import numpy as np

def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)

try:
    local_model = os.path.join(os.path.dirname(__file__), "models", "base.en")
    model_name = os.environ.get("COMPANION_WHISPER_MODEL", local_model if os.path.isfile(os.path.join(local_model, "model.bin")) else "base.en")
    model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=6)
    # Warm up once, rather than paying model setup cost on the first utterance.
    segments, _ = model.transcribe(np.zeros(16000, dtype=np.float32), language="en", beam_size=1, temperature=0, vad_filter=False)
    list(segments)
    emit({"event": "ready", "model": "Whisper base.en" if model_name == local_model else model_name})
except Exception as error:
    emit({"event": "failed", "error": str(error)})
    sys.exit(1)

for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        params = request.get("params", {})
        started = time.perf_counter()
        if request["command"] == "file":
            audio = params["path"]
        else:
            audio = np.frombuffer(base64.b64decode(params["audio"]), dtype="<f4").copy()
            if audio.size < 2400 or audio.size > 16000 * 32:
                raise ValueError("Audio must be between 0.15 and 32 seconds")
        segments, info = model.transcribe(
            audio, language=params.get("language", "en"), beam_size=1,
            temperature=0, condition_on_previous_text=False,
            vad_filter=True, vad_parameters={"threshold": 0.6, "min_speech_duration_ms": 250, "min_silence_duration_ms": 150, "speech_pad_ms": 80}, without_timestamps=True,
        )
        segments = list(segments)
        text = " ".join(s.text.strip() for s in segments if s.no_speech_prob < 0.8 and s.avg_logprob > -1.3).strip()
        emit({"id": request["id"], "result": {"text": text, "elapsedMs": round((time.perf_counter()-started)*1000), "language": info.language}})
    except Exception as error:
        emit({"id": request.get("id", 0), "error": str(error)})
