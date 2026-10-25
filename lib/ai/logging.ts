import { createHash } from 'node:crypto'

/** A short, non-reversible fingerprint of a built prompt — lets an operator correlate repeated
 *  identical requests (e.g. a retry storm) in logs without the log ever containing the prompt's
 *  actual content. Never used for anything security-sensitive (it's not secret, just a trace id). */
export function promptHash(userPrompt: string): string {
  return createHash('sha256').update(userPrompt).digest('hex').slice(0, 16)
}

export interface AiRequestLogEntry {
  capability: string
  orgId: string
  inputTokens?: number
  outputTokens?: number
  latencyMs: number
  errorType?: string
  promptHash: string
}

/** The only place the generate route logs anything about a request. Deliberately only ever
 *  passed the fields above — never the prompt text, the provider's response text, or any API
 *  key — so there is no call site that could accidentally log something sensitive. */
export function logAiRequest(entry: AiRequestLogEntry): void {
  console.log('[ai-assist]', JSON.stringify(entry))
}
