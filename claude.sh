# cp ~/Code/Agent/versperclaw/cli-dev ~/.local/bin/cli-dev
# ln -sf ~/Code/Agent/versperclaw/cli-dev ~/.local/bin/cli-dev

cd ~/Code/Agent/versperclaw ANTHROPIC_BASE_URL="http://127.0.0.1:8001" ANTHROPIC_API_KEY="dummy" CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 ./cli-dev --bare --model "Qwen3.5-4B.Q4_K_M.gguf"

cd ~/Code/Llm/evalbotv1 llama-server --model Jackrong/Qwen3.5-4B-Claude-4.6-Opus-Reasoning-Distilled-GGUF/Qwen3.5-4B.Q4_K_M.gguf --mmproj Jackrong/Qwen3.5-4B-Claude-4.6-Opus-Reasoning-Distilled-GGUF/mmproj-BF16.gguf --seed 3407 --temp 1.0 --top-p 0.95 --min-p 0.01 --top-k 40 -c 49152 --port 8001 --host 0.0.0.0
