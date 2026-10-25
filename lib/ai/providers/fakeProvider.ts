// Server-only. Deterministic, offline, zero-cost — the default provider everywhere (every test,
// and local dev unless AI_ALLOW_DEV_PROVIDERS=true AND the OpenAI-compatible env vars are all
// set — see getDevAiProvider.ts). Never makes a network call, never reads an env var, never
// fails for any reason other than being asked to.
import type { AiCompleteOutcome, AiProvider } from '@lib/ai/provider'

export const fakeProvider: AiProvider = {
  async complete(input): Promise<AiCompleteOutcome> {
    const text = `[FAKE DRAFT] ${input.userPrompt.slice(0, 120)}`
    return {
      ok: true,
      result: {
        text,
        // Rough, deterministic token-count stand-in (~4 chars/token) — never meant to be
        // accurate, only stable enough for a test to assert an exact number against.
        inputTokens: Math.ceil((input.systemPrompt.length + input.userPrompt.length) / 4),
        outputTokens: Math.ceil(text.length / 4),
      },
    }
  },
}
