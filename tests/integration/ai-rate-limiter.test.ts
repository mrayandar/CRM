/**
 * lib/ai/rateLimiter.ts: the atomic cap-reservation primitive every AI-assist cap (per-user-hour,
 * per-org-hour, per-org-month) shares. Real DB, no mocked auth — this module has no session
 * concept of its own.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { prisma } from '@lib/prisma'
import { hourBucketStart, monthBucketStart, reserveSlot, refundSlot } from '@lib/ai/rateLimiter'

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
let n = 0
function scopeId() {
  n += 1
  return `ai-ratelimit-${RUN}-${n}`
}

afterEach(async () => {
  await prisma.aiRateLimitCounter.deleteMany({ where: { scopeId: { startsWith: `ai-ratelimit-${RUN}-` } } })
})

describe('hourBucketStart / monthBucketStart', () => {
  it('floors to the start of the UTC hour', () => {
    const bucket = hourBucketStart(new Date('2026-03-15T14:47:32.123Z'))
    expect(bucket.toISOString()).toBe('2026-03-15T14:00:00.000Z')
  })
  it('floors to the start of the UTC month', () => {
    const bucket = monthBucketStart(new Date('2026-03-15T14:47:32.123Z'))
    expect(bucket.toISOString()).toBe('2026-03-01T00:00:00.000Z')
  })
})

describe('reserveSlot: atomic cap reservation', () => {
  it('the first reservation for a brand-new bucket always succeeds', async () => {
    const id = scopeId()
    const bucket = hourBucketStart(new Date())
    expect(await reserveSlot('user_hour', id, bucket, 5)).toBe(true)
    const row = await prisma.aiRateLimitCounter.findUnique({
      where: { scopeType_scopeId_bucketStart: { scopeType: 'user_hour', scopeId: id, bucketStart: bucket } },
    })
    expect(row?.requestCount).toBe(1)
  })

  it('stops granting reservations once the cap is reached, and leaves the counter at the cap', async () => {
    const id = scopeId()
    const bucket = hourBucketStart(new Date())
    expect(await reserveSlot('user_hour', id, bucket, 2)).toBe(true)
    expect(await reserveSlot('user_hour', id, bucket, 2)).toBe(true)
    expect(await reserveSlot('user_hour', id, bucket, 2)).toBe(false)
    expect(await reserveSlot('user_hour', id, bucket, 2)).toBe(false)
    const row = await prisma.aiRateLimitCounter.findUnique({
      where: { scopeType_scopeId_bucketStart: { scopeType: 'user_hour', scopeId: id, bucketStart: bucket } },
    })
    expect(row?.requestCount).toBe(2) // never incremented past the cap by a rejected attempt
  })

  it('two concurrent requests racing a cap of 1 can never both succeed', async () => {
    const id = scopeId()
    const bucket = hourBucketStart(new Date())
    const [a, b] = await Promise.all([reserveSlot('user_hour', id, bucket, 1), reserveSlot('user_hour', id, bucket, 1)])
    expect([a, b].filter(Boolean)).toHaveLength(1)
    const row = await prisma.aiRateLimitCounter.findUnique({
      where: { scopeType_scopeId_bucketStart: { scopeType: 'user_hour', scopeId: id, bucketStart: bucket } },
    })
    expect(row?.requestCount).toBe(1)
  })

  it('different scopeType/scopeId/bucketStart values never share a counter', async () => {
    const id = scopeId()
    const bucket = hourBucketStart(new Date())
    expect(await reserveSlot('user_hour', id, bucket, 1)).toBe(true)
    expect(await reserveSlot('org_hour', id, bucket, 1)).toBe(true) // same scopeId, different scopeType
    expect(await reserveSlot('user_hour', id, monthBucketStart(new Date()), 1)).toBe(true) // different bucket
  })
})

describe('refundSlot', () => {
  it('gives back a reserved slot so a later reservation can succeed again', async () => {
    const id = scopeId()
    const bucket = hourBucketStart(new Date())
    expect(await reserveSlot('user_hour', id, bucket, 1)).toBe(true)
    expect(await reserveSlot('user_hour', id, bucket, 1)).toBe(false)
    await refundSlot('user_hour', id, bucket)
    expect(await reserveSlot('user_hour', id, bucket, 1)).toBe(true)
  })

  it('floors at 0 — refunding a counter that is already 0 never goes negative', async () => {
    const id = scopeId()
    const bucket = hourBucketStart(new Date())
    await refundSlot('user_hour', id, bucket) // no row exists yet at all
    expect(await reserveSlot('user_hour', id, bucket, 1)).toBe(true)
    await refundSlot('user_hour', id, bucket)
    await refundSlot('user_hour', id, bucket) // double refund
    const row = await prisma.aiRateLimitCounter.findUnique({
      where: { scopeType_scopeId_bucketStart: { scopeType: 'user_hour', scopeId: id, bucketStart: bucket } },
    })
    expect(row?.requestCount).toBe(0)
  })
})
