import json, os, sys, wave

WHISPER_CACHE = os.path.expanduser("~/.cache/whisper")

def write_wav(path, raw_pcm, sample_rate=16000):
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(raw_pcm)

def get_model_path(name):
    lp = os.path.expanduser(f'~/.cache/huggingface/hub/models--Systran--faster-whisper-{name}')
    if os.path.isdir(lp):
        return lp
    return name

def main():
    model = None
    model_name = None

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except:
            continue

        msg_type = msg.get('type')

        if msg_type == 'load':
            name = msg.get('model', 'small')
            print(json.dumps({'type': 'ready', 'model': name}), flush=True)
            sys.stdout.flush()

        elif msg_type == 'transcribe':
            wav_path = msg.get('wav')
            language = msg.get('language')

            if not model or model_name != msg.get('model'):
                model_name = msg.get('model', 'base')
                print(json.dumps({'type': 'status', 'message': f'Loading model {model_name}...'}), flush=True)
                try:
                    import whisper
                    model = whisper.load_model(model_name, device='cuda', download_root=WHISPER_CACHE)
                    print(json.dumps({'type': 'status', 'message': 'Model loaded'}), flush=True)
                except ImportError:
                    try:
                        from faster_whisper import WhisperModel
                        mp = get_model_path(model_name)
                        model = WhisperModel(mp, device='cuda', compute_type='int8_float16')
                        print(json.dumps({'type': 'status', 'message': 'Model loaded'}), flush=True)
                    except (ImportError, RuntimeError) as e:
                        print(json.dumps({'type': 'error', 'message': f'No whisper library available: {e}'}), flush=True)
                        sys.stdout.flush()
                        continue

            if not wav_path or not os.path.exists(wav_path):
                print(json.dumps({'type': 'error', 'message': 'WAV file not found'}), flush=True)
                sys.stdout.flush()
                continue

            try:
                opts = {}
                if language:
                    opts['language'] = language

                result = model.transcribe(wav_path, **opts)
                text = result['text'].strip() if isinstance(result, dict) else ''
                lang = result.get('language', language or 'en') if isinstance(result, dict) else (language or 'en')

                print(json.dumps({'type': 'result', 'text': text, 'language': lang}), flush=True)
            except Exception as e:
                print(json.dumps({'type': 'error', 'message': str(e)}), flush=True)
                sys.stdout.flush()

if __name__ == '__main__':
    main()