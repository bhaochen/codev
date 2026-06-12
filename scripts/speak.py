import json, os, sys, tempfile, asyncio

async def speak(text: str, voice: str = "en-US-JennyNeural", output_path: str | None = None) -> dict:
    try:
        import edge_tts
        communicate = edge_tts.Communicate(text, voice)
        if output_path:
            await communicate.save(output_path)
            return {"success": True, "audio_path": output_path}
        tmp = tempfile.mktemp(suffix=".mp3")
        await communicate.save(tmp)
        return {"success": True, "audio_path": tmp}
    except ImportError:
        pass

    return {"success": False, "error": "edge-tts is not installed. Run: pip install edge-tts"}

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Usage: speak.py <text> [--voice <name>] [--output <path>]"}))
        sys.exit(1)

    text = sys.argv[1]
    voice = "en-US-JennyNeural"
    output_path = None

    i = 2
    while i < len(sys.argv):
        if sys.argv[i] == "--voice" and i + 1 < len(sys.argv):
            voice = sys.argv[i + 1]
            i += 2
        elif sys.argv[i] == "--output" and i + 1 < len(sys.argv):
            output_path = sys.argv[i + 1]
            i += 2
        else:
            i += 1

    result = asyncio.run(speak(text, voice, output_path))
    print(json.dumps(result))

if __name__ == "__main__":
    main()