# OpenClaw Translate — Nemotron

OpenClaw plugin that translates Japanese messages to English before LLM processing, then translates English responses back to Japanese — powered by NVIDIA Nemotron via local Ollama.

## What It Does

```
You (Japanese) → [J→E translation] → LLM (English) → [E→J translation] → You (Japanese)
```

1. **Input**: Your Japanese message
2. **Translate J→E**: Nemotron running locally via Ollama translates to English
3. **LLM**: English prompt is sent to the configured OpenClaw model (e.g. Qwen, Kimi)
4. **Translate E→J**: Nemotron translates the English response back to Japanese
5. **Output**: You receive Japanese in Signal

## Requirements

- [Ollama](https://ollama.com/download) installed and running
- Nemotron model pulled locally

```bash
# Pull Nemotron (MoE, 86GB total, ~12GB active on RTX 4090)
ollama pull nemotron-3-super:120b

# Or the smaller nano variant (~20GB)
ollama pull nemotron-3-nano:30b
```

## Installation

The plugin is already installed at `~/.openclaw/extensions/openclaw-translate-nemotron/`. Enable it by adding to your OpenClaw config:

```json
{
  "extensions": {
    "entries": {
      "openclaw-translate-nemotron": {
        "enabled": true
      }
    }
  }
}
```

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable/disable the plugin |
| `model` | `nemotron-3-super:120b` | Ollama model for translation |
| `ollamaBaseUrl` | `http://127.0.0.1:11434/v1` | Ollama API endpoint |
| `apiKey` | `ollama` | API key (local Ollama uses `ollama`) |
| `sourceLang` | `Japanese` | Source language |
| `targetLang` | `English` | Target language |
| `maxTokens` | `1024` | Max tokens per translation |
| `injectSystemPrompt` | `true` | Inject English system prompt so LLM responds in English |

## How It Works

- **`before_prompt_build` hook**: Intercepts your Japanese message, translates it to English, and injects an English-only system prompt so the LLM responds in English
- **`after_agent_run` hook**: Translates the English LLM response back to Japanese

## Hardware Notes

| GPU | Can Run |
|-----|---------|
| RTX 4090 (24GB) | `nemotron-3-super:120b` ✅ (~12GB active) |
| RTX 3090 (24GB) | `nemotron-3-super:120b` ✅ |
| RTX 4080 (16GB) | `nemotron-3-nano:30b` ✅ |
| 32GB RAM | `nemotron-3-nano:30b` ✅ |

## Model Quality

- **nemotron-3-super:120b** — Best quality, MoE architecture, 12B active params, 256K context
- **nemotron-3-nano:30b** — Lighter, ~30B params, faster but lower quality

## Why Nemotron?

NVIDIA Nemotron is specifically trained for instruction-following and agentic tasks, making it excellent for translation work — particularly Japanese ↔ English.

## Repo

https://github.com/kandotrun/openclaw-translate-nemotron
