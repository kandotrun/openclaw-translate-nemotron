/**
 * openclaw-translate-nemotron — OpenClaw Plugin
 *
 * Translates Japanese messages to English before LLM processing,
 * then translates English responses back to Japanese.
 * Uses Nemotron via Ollama Cloud for translation.
 *
 * Flow:
 *   Japanese input → [J→E translation via Nemotron] → English prompt to LLM
 *   English output from LLM → [E→J translation via Nemotron] → Japanese to user
 *
 * Based on whisper-dict-auto plugin architecture.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

// ============================================================================
// Config
// ============================================================================

interface PluginConfig {
  enabled?: boolean;
  ollamaBaseUrl?: string;
  apiKey?: string;
  sourceLang?: string;
  targetLang?: string;
  model?: string;
  maxTokens?: number;
  injectSystemPrompt?: boolean;
}

const DEFAULTS: Required<PluginConfig> = {
  enabled: true,
  ollamaBaseUrl: "https://ollama.com/v1",
  apiKey: "ollama-local",
  sourceLang: "Japanese",
  targetLang: "English",
  model: "nemotron-3-super:120b-cloud",
  maxTokens: 1024,
  injectSystemPrompt: true,
};

// ============================================================================
// Ollama Cloud Translation
// ============================================================================

async function translateWithOllama(
  text: string,
  sourceLang: string,
  targetLang: string,
  baseUrl: string,
  apiKey: string,
  model: string,
  maxTokens: number,
): Promise<string> {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

  const systemPrompt = `You are a professional, accurate ${targetLang} translator. Translate the following ${sourceLang} text to ${targetLang}. Only output the translation — no explanations, no comments, no quotes. Preserve the tone and nuance of the original. If the input is already in ${targetLang}, still translate it accurately to ${targetLang} as if it were ${sourceLang}.`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      max_tokens: maxTokens,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    throw new Error(
      `Ollama Cloud translation failed: ${response.status} ${response.statusText} — ${errorText}`,
    );
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (data.error) {
    throw new Error(`Ollama Cloud API error: ${data.error.message}`);
  }

  const translated =
    data.choices?.[0]?.message?.content?.trim() ?? text;

  return translated;
}

// ============================================================================
// Language Detection (simple heuristic)
// ============================================================================

/** Rough check if text is primarily Japanese (Hiragana/Katakana/Kanji) */
function isJapanese(text: string): boolean {
  // Count Japanese characters vs ASCII letters
  const japaneseChars = (
    text.match(/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u3400-\u4DBF]/g) || []
  ).length;
  const totalChars = text.replace(/\s/g, "").length;
  return totalChars > 0 && japaneseChars / totalChars > 0.3;
}

// ============================================================================
// Plugin
// ============================================================================

export default function register(api: any) {
  const raw = (api.pluginConfig || {}) as PluginConfig;
  const cfg: Required<PluginConfig> = { ...DEFAULTS, ...raw };

  if (!cfg.enabled) {
    api.logger.info("openclaw-translate-nemotron: disabled");
    return;
  }

  api.logger.info(
    `openclaw-translate-nemotron: enabled (model=${cfg.model}, ${cfg.sourceLang}→${cfg.targetLang})`,
  );

  // Keep a reference to the original send fn so we can wrap response
  const originalSend = api.sendMessage?.bind(api);

  // ========================================================================
  // before_prompt_build — translate input J→E
  // ========================================================================

  api.on(
    "before_prompt_build",
    async (event: {
      prompt?: string;
      messages?: Array<{ role?: string; content?: string }>;
    }) => {
      try {
        // Find the last user message
        const messages = event.messages || [];
        const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");

        if (!lastUserMsg?.content) return;

        const content = lastUserMsg.content as string;
        if (!isJapanese(content)) {
          // Not Japanese — optionally inject system prompt in English anyway
          if (cfg.injectSystemPrompt) {
            return {
              appendSystemContext: [
                "",
                "## Language",
                "You are conversing with the user in English. Respond in English only.",
              ].join("\n"),
            };
          }
          return;
        }

        api.logger.info(
          `openclaw-translate-nemotron: translating ${content.length} char J→E`,
        );

        // Translate Japanese → English
        const englishText = await translateWithOllama(
          content,
          cfg.sourceLang,
          cfg.targetLang,
          cfg.ollamaBaseUrl,
          cfg.apiKey,
          cfg.model,
          cfg.maxTokens,
        );

        // Update the last user message with English translation
        lastUserMsg.content = englishText;

        // Inject system prompt so LLM responds in English
        const systemInject = cfg.injectSystemPrompt
          ? [
              "",
              "## Language",
              "The user's message has been translated from Japanese to English. Respond in English only. The user prefers English responses.",
            ].join("\n")
          : "";

        return {
          appendSystemContext: systemInject,
        };
      } catch (err) {
        api.logger.error(`openclaw-translate-nemotron: translation error — ${err}`);
        // Don't block the flow on translation failure
        return;
      }
    },
    { priority: 30 },
  );

  // ========================================================================
  // after_agent_run — translate output E→J
  // ========================================================================

  if (api.on) {
    api.on(
      "after_agent_run",
      async (event: { response?: string; messages?: Array<{ role?: string; content?: string }> }) => {
        try {
          const response = event.response || "";
          if (!response || !isJapanese(response)) return;

          api.logger.info(
            `openclaw-translate-nemotron: translating ${response.length} char E→J`,
          );

          const japaneseText = await translateWithOllama(
            response,
            cfg.targetLang,
            cfg.sourceLang,
            cfg.ollamaBaseUrl,
            cfg.apiKey,
            cfg.model,
            cfg.maxTokens,
          );

          // Update the response
          event.response = japaneseText;

          // Also find and update the last assistant message in messages
          if (event.messages) {
            const lastAssistant = [...event.messages].reverse().find(
              (m) => m.role === "assistant",
            );
            if (lastAssistant?.content) {
              lastAssistant.content = japaneseText;
            }
          }
        } catch (err) {
          api.logger.error(`openclaw-translate-nemotron: response translation error — ${err}`);
        }
      },
      { priority: 30 },
    );
  }

  api.logger.info(
    `openclaw-translate-nemotron: registered (model=${cfg.model}, ${cfg.sourceLang}→${cfg.targetLang})`,
  );
}
