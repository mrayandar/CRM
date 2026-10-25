/**
 * lib/ai/providers/openAiCompatibleProvider.ts, lib/ai/providers/fakeProvider.ts, and
 * lib/ai/getDevAiProvider.ts — no real network calls anywhere in this file (fetch is always
 * mocked). Covers the dev-only guard (refuses without AI_ALLOW_DEV_PROVIDERS=true, before even
 * reading the key), that the key never appears in any log/error/response, that error logging
 * carries only a type/status — never a request body — and the empty-output/timeout/auth/rate-
 * limit error-type mapping.
 *
 * Every "API key" used below is an obviously-fake literal (e.g. "test-key-not-real") — this file
 * never reads the real AI_API_KEY from the actual local .env, so nothing resembling a real
 * credential can ever appear in a test failure's diff output either.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeProvider } from '@lib/ai/providers/fakeProvider'
import { openAiCompatibleProvider } from '@lib/ai/providers/openAiCompatibleProvider'
import { getDevAiProvider } from '@lib/ai/getDevAiProvider'

const FAKE_KEY = 'test-key-not-real-0000'
const ENV_KEYS = ['AI_ALLOW_DEV_PROVIDERS', 'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_REASONING_EFFORT'] as const
let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('fakeProvider: deterministic, no network, no env reads', () => {
  it('always succeeds with stable, derivable output', async () => {
    const outcome = await fakeProvider.complete({
      systemPrompt: 'sys', userPrompt: 'hello world', maxOutputTokens: 100, timeoutMs: 1000,
    })
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.result.text).toBe('[FAKE DRAFT] hello world')
      expect(outcome.result.inputTokens).toBeGreaterThan(0)
      expect(outcome.result.outputTokens).toBeGreaterThan(0)
    }
  })
})

describe('getDevAiProvider: resolution rule', () => {
  it('returns the fake provider when AI_ALLOW_DEV_PROVIDERS is unset', () => {
    expect(getDevAiProvider()).toBe(fakeProvider)
  })
  it('returns the fake provider even when allowed, if the config is incomplete', () => {
    process.env.AI_ALLOW_DEV_PROVIDERS = 'true'
    process.env.AI_BASE_URL = 'https://example.test/v1'
    // AI_API_KEY and AI_MODEL deliberately left unset.
    expect(getDevAiProvider()).toBe(fakeProvider)
  })
  it('returns the real adapter only when allowed AND fully configured', () => {
    process.env.AI_ALLOW_DEV_PROVIDERS = 'true'
    process.env.AI_BASE_URL = 'https://example.test/v1'
    process.env.AI_API_KEY = FAKE_KEY
    process.env.AI_MODEL = 'test-model'
    expect(getDevAiProvider()).toBe(openAiCompatibleProvider)
  })
})

describe('openAiCompatibleProvider: dev-only guard', () => {
  it('refuses without AI_ALLOW_DEV_PROVIDERS=true, before ever reading the key or calling fetch', async () => {
    process.env.AI_BASE_URL = 'https://example.test/v1'
    process.env.AI_API_KEY = FAKE_KEY
    process.env.AI_MODEL = 'test-model'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await openAiCompatibleProvider.complete({
      systemPrompt: 'sys', userPrompt: 'user', maxOutputTokens: 100, timeoutMs: 1000,
    })

    expect(outcome).toEqual({ ok: false, errorType: 'dev_providers_disabled' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses when allowed but missing config, without calling fetch', async () => {
    process.env.AI_ALLOW_DEV_PROVIDERS = 'true'
    // AI_BASE_URL/AI_API_KEY/AI_MODEL all left unset.
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await openAiCompatibleProvider.complete({
      systemPrompt: 'sys', userPrompt: 'user', maxOutputTokens: 100, timeoutMs: 1000,
    })

    expect(outcome).toEqual({ ok: false, errorType: 'missing_config' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

function allowAndConfigure() {
  process.env.AI_ALLOW_DEV_PROVIDERS = 'true'
  process.env.AI_BASE_URL = 'https://example.test/v1'
  process.env.AI_API_KEY = FAKE_KEY
  process.env.AI_MODEL = 'test-model'
}

describe('openAiCompatibleProvider: the key never appears in any log, error, or response', () => {
  it('a successful call never logs anything, and never echoes the key in the result', async () => {
    allowAndConfigure()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'a draft' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
          { status: 200 },
        ),
      ),
    )

    const outcome = await openAiCompatibleProvider.complete({
      systemPrompt: 'sys', userPrompt: 'user', maxOutputTokens: 100, timeoutMs: 1000,
    })

    expect(outcome).toEqual({ ok: true, result: { text: 'a draft', inputTokens: 10, outputTokens: 5 } })
    expect(JSON.stringify(outcome)).not.toContain(FAKE_KEY)
    expect(errorSpy).not.toHaveBeenCalled()
    for (const call of errorSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(FAKE_KEY)
    }
  })

  it('an auth failure logs only a status code, never the key or the request body', async () => {
    allowAndConfigure()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })))

    const outcome = await openAiCompatibleProvider.complete({
      systemPrompt: 'secret system instructions', userPrompt: 'secret user data', maxOutputTokens: 100, timeoutMs: 1000,
    })

    expect(outcome).toEqual({ ok: false, errorType: 'auth' })
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const loggedArgs = JSON.stringify(errorSpy.mock.calls)
    expect(loggedArgs).not.toContain(FAKE_KEY)
    expect(loggedArgs).not.toContain('secret system instructions')
    expect(loggedArgs).not.toContain('secret user data')
    expect(loggedArgs).toContain('401')
  })

  it('a rate-limit response maps to rate_limited, logged without any request content', async () => {
    allowAndConfigure()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', { status: 429 })))

    const outcome = await openAiCompatibleProvider.complete({
      systemPrompt: 'sys', userPrompt: 'user', maxOutputTokens: 100, timeoutMs: 1000,
    })

    expect(outcome).toEqual({ ok: false, errorType: 'rate_limited' })
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(FAKE_KEY)
  })

  it('a generic provider error (500) maps to provider_error', async () => {
    allowAndConfigure()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 500 })))

    const outcome = await openAiCompatibleProvider.complete({
      systemPrompt: 'sys', userPrompt: 'user', maxOutputTokens: 100, timeoutMs: 1000,
    })
    expect(outcome).toEqual({ ok: false, errorType: 'provider_error' })
  })

  it('empty output maps to empty_or_truncated_output, not a silent empty draft', async () => {
    allowAndConfigure()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: {} }),
          { status: 200 },
        ),
      ),
    )

    const outcome = await openAiCompatibleProvider.complete({
      systemPrompt: 'sys', userPrompt: 'user', maxOutputTokens: 100, timeoutMs: 1000,
    })
    expect(outcome).toEqual({ ok: false, errorType: 'empty_or_truncated_output' })
  })

  it('a hanging request is aborted at timeoutMs and maps to timeout', async () => {
    allowAndConfigure()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        }),
      ),
    )

    const outcome = await openAiCompatibleProvider.complete({
      systemPrompt: 'sys', userPrompt: 'user', maxOutputTokens: 100, timeoutMs: 20,
    })
    expect(outcome).toEqual({ ok: false, errorType: 'timeout' })
  })

  it('reasoning_effort is included in the request only when AI_REASONING_EFFORT is set', async () => {
    allowAndConfigure()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let capturedBody: string | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body as string
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }), { status: 200 })
      }),
    )

    await openAiCompatibleProvider.complete({ systemPrompt: 's', userPrompt: 'u', maxOutputTokens: 10, timeoutMs: 1000 })
    expect(JSON.parse(capturedBody!)).not.toHaveProperty('reasoning_effort')

    process.env.AI_REASONING_EFFORT = 'low'
    await openAiCompatibleProvider.complete({ systemPrompt: 's', userPrompt: 'u', maxOutputTokens: 10, timeoutMs: 1000 })
    expect(JSON.parse(capturedBody!)).toMatchObject({ reasoning_effort: 'low' })
  })

  it('normalizes the base URL so a trailing slash or none both call the same endpoint', async () => {
    allowAndConfigure()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const calledUrls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calledUrls.push(url)
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }), { status: 200 })
      }),
    )

    process.env.AI_BASE_URL = 'https://example.test/v1/'
    await openAiCompatibleProvider.complete({ systemPrompt: 's', userPrompt: 'u', maxOutputTokens: 10, timeoutMs: 1000 })
    process.env.AI_BASE_URL = 'https://example.test/v1'
    await openAiCompatibleProvider.complete({ systemPrompt: 's', userPrompt: 'u', maxOutputTokens: 10, timeoutMs: 1000 })

    expect(calledUrls).toEqual([
      'https://example.test/v1/chat/completions',
      'https://example.test/v1/chat/completions',
    ])
  })
})
