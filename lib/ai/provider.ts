// Server-only. The one interface every AI provider implementation (real or fake) must satisfy —
// kept deliberately tiny so swapping providers never touches a call site, only which object
// `getDevAiProvider()` (or, from Stage 3 on, the org-aware resolver) hands back.

/** Every distinct, meaningfully-different-to-the-caller way a `complete()` call can fail to
 *  produce usable text. Never a raw provider error string — a type the caller can branch on and
 *  a human-readable message can be built from, without ever having to inspect (or log) the
 *  underlying response. */
export type AiErrorType =
  | 'dev_providers_disabled'
  | 'missing_config'
  | 'timeout'
  | 'network'
  | 'auth'
  | 'rate_limited'
  | 'empty_or_truncated_output'
  | 'provider_error'

export interface AiCompleteInput {
  systemPrompt: string
  userPrompt: string
  /** Hard ceiling on the provider's own output token budget — never inferred from the prompt. */
  maxOutputTokens: number
  /** Aborts the in-flight request past this many milliseconds and returns `'timeout'` — never
   *  left to the caller's own ambient fetch timeout (there isn't one). */
  timeoutMs: number
}

export interface AiCompleteResult {
  text: string
  inputTokens: number
  outputTokens: number
}

export type AiCompleteOutcome =
  | { ok: true; result: AiCompleteResult }
  | { ok: false; errorType: AiErrorType }

export interface AiProvider {
  complete(input: AiCompleteInput): Promise<AiCompleteOutcome>
}
