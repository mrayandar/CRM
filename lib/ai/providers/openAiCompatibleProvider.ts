// Server-only. Generic OpenAI-compatible chat-completions adapter, driven entirely by env vars —
// never hardcodes a model name, a provider's identity, or a price anywhere in this file. Works
// with any provider that speaks the OpenAI chat-completions shape; this app's own local dev setup
// happens to point it at Google AI Studio's Gemini via its OpenAI-compatible endpoint, but
// nothing here knows or needs to know that.
//
// Dev-only guard: refuses to run at all — before even reading AI_API_KEY — unless
// AI_ALLOW_DEV_PROVIDERS is exactly "true". That variable must only ever be set in a local
// .env, never in Vercel (see PROGRESS.md's pre-launch checklist) — it's the one thing standing
// between "a developer's own free-tier key" and "a real customer's request using it."
//
// Never logs a request body, a response body, or the API key — every console.error call below
// passes only a fixed message plus a status code / error-type string, nothing captured from the
// request or response content.
import type { AiCompleteInput, AiCompleteOutcome, AiProvider } from '@lib/ai/provider'

function normalizeBaseUrl(base: string): string {
  return base.replace(/\/+$/, '')
}

/** Joins a base URL and a path so a trailing slash on the base (or none) both produce exactly
 *  one correct URL — `"https://api.example.com/v1/"` and `"https://api.example.com/v1"` both
 *  become `"https://api.example.com/v1/chat/completions"`. */
function joinUrl(base: string, path: string): string {
  return `${normalizeBaseUrl(base)}/${path.replace(/^\/+/, '')}`
}

export const openAiCompatibleProvider: AiProvider = {
  async complete(input: AiCompleteInput): Promise<AiCompleteOutcome> {
    if (process.env.AI_ALLOW_DEV_PROVIDERS !== 'true') {
      return { ok: false, errorType: 'dev_providers_disabled' }
    }

    const baseUrl = process.env.AI_BASE_URL
    const apiKey = process.env.AI_API_KEY
    const model = process.env.AI_MODEL
    if (!baseUrl || !apiKey || !model) {
      return { ok: false, errorType: 'missing_config' }
    }

    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.userPrompt },
      ],
      max_tokens: input.maxOutputTokens,
    }
    // Only ever sent when explicitly configured — never assumed, never defaulted, since most
    // OpenAI-compatible providers don't support this field at all and would reject an unknown one.
    if (process.env.AI_REASONING_EFFORT) {
      body.reasoning_effort = process.env.AI_REASONING_EFFORT
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), input.timeoutMs)
    try {
      const response = await fetch(joinUrl(baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (response.status === 401 || response.status === 403) {
        console.error(`AI provider call failed: auth error (status ${response.status})`)
        return { ok: false, errorType: 'auth' }
      }
      if (response.status === 429) {
        console.error('AI provider call failed: rate limited')
        return { ok: false, errorType: 'rate_limited' }
      }
      if (!response.ok) {
        console.error(`AI provider call failed: provider error (status ${response.status})`)
        return { ok: false, errorType: 'provider_error' }
      }

      const json: unknown = await response.json()
      const choice = (json as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> })
        ?.choices?.[0]
      const text = choice?.message?.content
      const finishReason = choice?.finish_reason
      const usage = (json as { usage?: { prompt_tokens?: number; completion_tokens?: number } })?.usage ?? {}

      // A reasoning model can spend its entire output budget "thinking" and return empty
      // content with finish_reason "length" — that must surface as a clear error, never as a
      // silently empty draft the UI would show as if the model had nothing to say.
      if (!text || text.trim() === '') {
        console.error(`AI provider call failed: empty output (finish_reason=${finishReason ?? 'unknown'})`)
        return { ok: false, errorType: 'empty_or_truncated_output' }
      }

      return {
        ok: true,
        result: {
          text,
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
        },
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        console.error('AI provider call failed: timeout')
        return { ok: false, errorType: 'timeout' }
      }
      console.error(`AI provider call failed: network error (${err instanceof Error ? err.message : 'unknown'})`)
      return { ok: false, errorType: 'network' }
    } finally {
      clearTimeout(timer)
    }
  },
}
