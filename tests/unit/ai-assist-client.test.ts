/**
 * src/lib/aiAssistClient.ts: maps a POST /api/ai/generate Response (or a thrown fetch error) to
 * one of a small, closed set of UI states — never a raw status code or error message reaches the
 * card.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { callAiAssist, mapAiAssistResponse, CAP_REACHED_MESSAGE, UNAVAILABLE_MESSAGE } from '@/lib/aiAssistClient'

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('mapAiAssistResponse', () => {
  it('maps 200 with { text } to success, with a null providerKind when the body has none', async () => {
    expect(await mapAiAssistResponse(response(200, { text: 'hello' }))).toEqual({ status: 'success', text: 'hello', providerKind: null })
  })

  it('maps 200 with { text, providerKind } to success, carrying the provider kind through', async () => {
    expect(await mapAiAssistResponse(response(200, { text: 'hello', providerKind: 'dev' }))).toEqual({
      status: 'success',
      text: 'hello',
      providerKind: 'dev',
    })
  })

  it('ignores an unrecognized providerKind value, treating it as null', async () => {
    expect(await mapAiAssistResponse(response(200, { text: 'hello', providerKind: 'not-a-real-kind' }))).toEqual({
      status: 'success',
      text: 'hello',
      providerKind: null,
    })
  })

  it('maps 429 to cap_reached, using the server message when present', async () => {
    expect(await mapAiAssistResponse(response(429, { error: 'cap_reached', message: 'custom cap message' }))).toEqual({
      status: 'cap_reached',
      message: 'custom cap message',
    })
  })

  it('maps 429 to cap_reached with the default message when the body has none', async () => {
    expect(await mapAiAssistResponse(response(429, {}))).toEqual({ status: 'cap_reached', message: CAP_REACHED_MESSAGE })
  })

  it.each([401, 400, 403, 404, 503, 500])('maps %i to unavailable', async (status) => {
    expect(await mapAiAssistResponse(response(status, { error: 'whatever', message: 'some raw detail' }))).toEqual({
      status: 'unavailable',
      message: 'some raw detail',
    })
  })

  it('maps a non-429 failure with no message field to the default unavailable message', async () => {
    expect(await mapAiAssistResponse(response(503, {}))).toEqual({ status: 'unavailable', message: UNAVAILABLE_MESSAGE })
  })

  it('maps a 200 with a malformed body to unavailable, never throwing', async () => {
    expect(await mapAiAssistResponse(response(200, { notText: 'oops' }))).toEqual({ status: 'unavailable', message: UNAVAILABLE_MESSAGE })
  })
})

describe('callAiAssist', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('sends only { capability, subjectType, subjectId } — never any record content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, { text: 'draft' }))
    global.fetch = fetchMock as unknown as typeof fetch
    const controller = new AbortController()
    await callAiAssist('draft_email', 'lead', 'lead-123', controller.signal)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/ai/generate')
    expect(JSON.parse(init.body)).toEqual({ capability: 'draft_email', subjectType: 'lead', subjectId: 'lead-123' })
  })

  it('maps a thrown AbortError to idle, not network_error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')) as unknown as typeof fetch
    const result = await callAiAssist('summarize', 'contact', 'c-1', new AbortController().signal)
    expect(result).toEqual({ status: 'idle' })
  })

  it('maps any other thrown fetch error to network_error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch
    const result = await callAiAssist('next_step', 'lead', 'lead-1', new AbortController().signal)
    expect(result).toEqual({ status: 'network_error' })
  })
})
