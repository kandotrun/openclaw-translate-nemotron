/**
 * openclaw-translate-nemotron — OpenClaw Plugin
 *
 * Translates Japanese messages to English before LLM processing,
 * then translates English responses back to Japanese.
 * Uses Nemotron via local Ollama for translation.
 *
 * Flow:
 *   Japanese input → [J→E translation] → LLM (English)
 *   English output → [E→J translation] → Japanese to user
 */

import { EventEmitter } from "node:events";

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
  ollamaBaseUrl: "http://127.0.0.1:11434/v1",
  apiKey: "ollama",
  sourceLang: "Japanese",
  targetLang: "English",
  model: "nemotron-3-super:120b",
  maxTokens: 1024,
  injectSystemPrompt: true,
};

// ============================================================================
// Ollama Translation
// ============================================================================

async function translate(
  text: string,
  sourceLang: string,
  targetLang: string,
  baseUrl: string,
  apiKey: string,
  model: string,
  maxTokens: number,
): Promise<string> {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

  const systemPrompt = `You are a professional, accurate ${targetLang} translator. Translate the following ${sourceLang} text to ${targetLang}. Only output the translation — no explanations, no quotes, no comments. Preserve the tone and nuance of the original.`;

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
    const errorText = await response.text().catch(() => "unknown");
    throw new Error(`Ollama translation failed: ${response.status} — ${errorText}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (data.error) {
    throw new Error(`Ollama error: ${data.error.message}`);
  }

  return data.choices?.[0]?.message?.content?.trim() ?? text;
}

// ============================================================================
// Language Detection
// ============================================================================

function isJapanese(text: string): boolean {
  const japaneseChars = (
    text.match(/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u3400-\u4DBF]/g) || []
  ).length;
  const totalChars = text.replace(/\s/g, "").length;
  return totalChars > 0 && japaneseChars / totalChars > 0.3;
}

// ============================================================================
// Prompt Parser — extract user message from full prompt string
// ============================================================================

/**
 * The before_prompt_build prompt string looks roughly like:
 * [system instructions]
 * [history with role tags]
 * USER: 日本語メッセージ
 * ASSISTANT: ...
 *
 * We find the last "USER:" tagged block and check if it's Japanese.
 */
function extractLastUserMessage(prompt: string): { before: string; userContent: string; after: string } | null {
  // Match the last occurrence of USER: prefix followed by content
  // Pattern: starts with USER: or \nUSER: and captures everything up to the next role tag or end
  const userPattern = /(?:^|\n)(USER):\s*([\s\S]*?)(?=\n(?:ASSISTANT|SYSTEM|USER|TOOL|RESULT|$))/gm;

  const matches: Array<{ start: number; end: number; content: string }> = [];
  let match;

  while ((match = userPattern.exec(prompt)) !== null) {
    matches.push({
      start: match.index,
      end: userPattern.lastIndex,
      content: match[2].trim(),
    });
  }

  if (matches.length === 0) return null;

  const last = matches[matches.length - 1];
  const before = prompt.slice(0, last.start);
  const after = prompt.slice(last.end);

  return { before, userContent: last.content, after };
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

  // ========================================================================
  // before_prompt_build — translate J→E input
  // ========================================================================

  api.on(
    "before_prompt_build",
    async (event: { prompt?: string }) => {
      const prompt = event.prompt;
      if (!prompt) return;

      const extracted = extractLastUserMessage(prompt);
      if (!extracted || !extracted.userContent) return;

      const { before, userContent, after } = extracted;

      if (!isJapanese(userContent)) {
        // Not Japanese — just inject English system prompt
        if (cfg.injectSystemPrompt) {
          return {
            appendSystemContext: [
              "",
              "## Language",
              "You are speaking with the user in English. Respond in English only.",
            ].join("\n"),
          };
        }
        return;
      }

      try {
        api.logger.info(
          `openclaw-translate-nemotron: translating ${userContent.length} char J→E`,
        );

        // Translate Japanese → English
        const englishText = await translate(
          userContent,
          cfg.sourceLang,
          cfg.targetLang,
          cfg.ollamaBaseUrl,
          cfg.apiKey,
          cfg.model,
          cfg.maxTokens,
        );

        // Reconstruct prompt with English user message
        // Add role tag back
        const roleTag = prompt.match(/\n(USER):\s*$/m)?.[1] || "USER";
        const translatedPrompt =
          before +
          `${roleTag}: ${englishText}` +
          after;

        api.logger.info(
          `openclaw-translate-nemotron: translated to "${englishText.slice(0, 50)}..."`,
        );

        return {
          prompt: translatedPrompt,
          appendSystemContext: cfg.injectSystemPrompt
            ? [
                "",
                "## Language",
                "The user's message has been translated from Japanese to English. Respond in English only.",
              ].join("\n")
            : "",
        };
      } catch (err) {
        api.logger.error(`openclaw-translate-nemotron: J→E translation error — ${err}`);
        return;
      }
    },
    { priority: 30 },
  );

  // ========================================================================
  // after_agent_run — translate E→J output
  // ========================================================================

  if (api.on) {
    api.on(
      "after_agent_run",
      async (event: { response?: string }) => {
        const response = event.response;
        if (!response || !isJapanese(response)) return;

        try {
          api.logger.info(
            `openclaw-translate-nemotron: translating ${response.length} char E→J`,
          );

          const japaneseText = await translate(
            response,
            cfg.targetLang,
            cfg.sourceLang,
            cfg.ollamaBaseUrl,
            cfg.apiKey,
            cfg.model,
            cfg.maxTokens,
          );

          event.response = japaneseText;

          api.logger.info(
            `openclaw-translate-nemotron: E→J done → "${japaneseText.slice(0, 30)}..."`,
          );
        } catch (err) {
          api.logger.error(`openclaw-translate-nemotron: E→J translation error — ${err}`);
        }
      },
      { priority: 30 },
    );
  }

  api.logger.info(
    `openclaw-translate-nemotron: registered (model=${cfg.model}, ${cfg.sourceLang}→${cfg.targetLang})`,
  );
}
