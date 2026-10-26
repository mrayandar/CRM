// Client-side helper for the AI assist card (RecordDetail.tsx). Pure (no DOM, no React) so it's
// testable without a browser — the only thing it does is call POST /api/ai/generate and map its
// response to one of a small, closed set of UI states, never a raw HTTP status or error message.

export type AiAssistCapability = 'draft_email' | 'summarize' | 'next_step'
export type AiAssistSubjectType = 'lead' | 'contact'
/** Never the provider's name, URL, key, or allowlist — see app/api/ai/generate/route.ts's own
 *  doc comment. 'dev' covers both the fake provider and the OpenAI-compatible dev adapter. */
export type AiProviderKind = 'dev' | 'production'

export const CAP_REACHED_MESSAGE = "You've reached this month's AI assist limit for your plan."
export const UNAVAILABLE_MESSAGE = "AI assist isn't available right now. Please try again later."

export type AiAssistUiState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; text: string; providerKind: AiProviderKind | null }
  | { status: 'cap_reached'; message: string }
  | { status: 'unavailable'; message: string }
  | { status: 'network_error' }

/**
 * Maps a `fetch` Response from POST /api/ai/generate to a UI state. 429 is the one status with
 * its own message (the cap-reached case); every other non-2xx (401/400/403/404/503/5xx) collapses
 * to the same generic "unavailable" message — none of those are actionable by the person clicking
 * the button, and the route's own body never contains anything more specific worth surfacing
 * (see app/api/ai/generate/route.ts's own doc comment on its check order). A genuine network
 * failure (the fetch itself throwing, e.g. offline) is a separate state with its own retry button
 * — see `callAiAssist` below, which is what actually hits that path.
 */
export async function mapAiAssistResponse(response: Response): Promise<AiAssistUiState> {
  if (response.status === 429) {
    const json = await response.json().catch(() => null)
    return { status: 'cap_reached', message: typeof json?.message === 'string' ? json.message : CAP_REACHED_MESSAGE }
  }
  if (!response.ok) {
    const json = await response.json().catch(() => null)
    return { status: 'unavailable', message: typeof json?.message === 'string' ? json.message : UNAVAILABLE_MESSAGE }
  }
  const json = await response.json().catch(() => null)
  if (!json || typeof json.text !== 'string') return { status: 'unavailable', message: UNAVAILABLE_MESSAGE }
  const providerKind = json.providerKind === 'dev' || json.providerKind === 'production' ? json.providerKind : null
  return { status: 'success', text: json.text, providerKind }
}

/**
 * The only thing the AI assist card ever sends: a capability and a subject reference — never any
 * record content (the server reads and builds the prompt itself from a scoped by-id lookup). Pass
 * an `AbortSignal` so closing the modal (RecordDetail.tsx) can cancel the in-flight request.
 */
export async function callAiAssist(
  capability: AiAssistCapability,
  subjectType: AiAssistSubjectType,
  subjectId: string,
  signal: AbortSignal,
): Promise<AiAssistUiState> {
  try {
    const response = await fetch('/api/ai/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capability, subjectType, subjectId }),
      signal,
    })
    return await mapAiAssistResponse(response)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return { status: 'idle' }
    return { status: 'network_error' }
  }
}
