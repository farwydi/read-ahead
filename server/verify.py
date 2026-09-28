#!/usr/bin/env python3
"""Проверка настоящего HTTP-синтеза и скорости без сторонних библиотек."""
import array
import io
import json
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request
import wave

BASE = "http://127.0.0.1:8080"


def synthesize(text, output_format="wav"):
    payload = {"input": text, "voice": "russian", "language": "Russian",
               "response_format": output_format, "seed": 42, "max_new_tokens": 256}
    request = urllib.request.Request(BASE + "/v1/audio/speech",
                                     json.dumps(payload).encode(),
                                     {"Content-Type": "application/json"})
    started = time.monotonic()
    with urllib.request.urlopen(request, timeout=300) as response:
        assert response.status == 200
        first = response.read(2)
        first_audio = time.monotonic() - started
        data = first + response.read()
    elapsed = time.monotonic() - started
    if output_format == "wav":
        with wave.open(io.BytesIO(data)) as audio:
            assert (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) == (1, 2, 24000)
            duration = audio.getnframes() / audio.getframerate()
            pcm = audio.readframes(audio.getnframes())
        Path("/tmp/qwen-tts-check.wav").write_bytes(data)
    else:
        pcm = data
        duration = len(pcm) / 48000
    samples = array.array("h", pcm)
    peak = max(abs(sample) for sample in samples)
    assert 0.5 < duration < 20, ("empty or token-capped output", duration)
    assert peak > 100, ("silent output", peak)
    return {"text": text, "format": output_format, "seconds": round(elapsed, 3),
            "audio_seconds": round(duration, 3), "rtf": round(elapsed / duration, 3),
            "first_bytes_seconds": round(first_audio, 3), "peak_pcm16": peak}


if __name__ == "__main__":
    text = sys.argv[1] if len(sys.argv) > 1 else "Привет! Это проверка озвучки на домашнем сервере."
    # WAV и первый PCM прогревают разные codec-кеши; второй PCM уже повторный.
    for output_format in ("wav", "pcm", "pcm"):
        print(json.dumps(synthesize(text, output_format),
                         ensure_ascii=False), flush=True)
    request = urllib.request.Request(BASE + "/v1/audio/speech", b'{"input":""}',
                                     {"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(request, timeout=10)
        raise AssertionError("empty input accepted")
    except urllib.error.HTTPError as error:
        assert error.code == 400, error.code
    print('{"empty_input_status":400}', flush=True)
