import json, os, sys, tempfile, wave

WAV_HEADER_SIZE = 44

WHISPER_CACHE = os.path.expanduser("~/.cache/whisper")

def write_wav(path: str, raw_pcm: bytes, sample_rate: int = 16000):
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(raw_pcm)

def get_model_path(name):
    lp = os.path.expanduser(f"~/.cache/huggingface/hub/models--Systran--faster-whisper-{name}")
    if os.path.isdir(lp):
        return lp
    return name

def transcribe(wav_path: str, model_size: str = "small", language: str | None = None) -> dict:
    try:
        from faster_whisper import WhisperModel
        model_path = get_model_path(model_size)
        model = WhisperModel(model_path, device="cuda", compute_type="int8_float16")
        opts = {"beam_size": 5}
        if language:
            opts["language"] = language
        segments, info = model.transcribe(wav_path, **opts)
        text = " ".join(seg.text for seg in segments)
        return {"success": True, "text": text.strip(), "language": info.language}
    except ImportError:
        pass

    try:
        import whisper
        model = whisper.load_model(model_size, device="cuda", download_root=WHISPER_CACHE)
        opts = {}
        if language:
            opts["language"] = language
        result = model.transcribe(wav_path, **opts)
        return {"success": True, "text": result["text"].strip(), "language": result.get("language", "")}
    except ImportError:
        pass

    return {"success": False, "error": "Neither faster-whisper nor openai-whisper is installed. Run: pip install faster-whisper"}

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Usage: transcribe.py <wav_path> [--model <size>] [--language <code>]"}))
        sys.exit(1)

    wav_path = sys.argv[1]
    model_size = "small"
    language = None

    i = 2
    while i < len(sys.argv):
        if sys.argv[i] == "--model" and i + 1 < len(sys.argv):
            model_size = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == "--language" and i + 1 < len(sys.argv):
            language = sys.argv[i + 1]
            i += 2
        else:
            i += 1

    if sys.argv[1] == "--stdin-pcm":
        sample_rate = int(sys.argv[2]) if len(sys.argv) > 2 else 16000
        raw = sys.stdin.buffer.read()
        tmp = tempfile.mktemp(suffix=".wav")
        write_wav(tmp, raw, sample_rate)
        wav_path = tmp
        result = transcribe(wav_path, model_size, language)
        os.unlink(tmp)
    else:
        result = transcribe(wav_path, model_size, language)

    print(json.dumps(result))

if __name__ == "__main__":
    main()
