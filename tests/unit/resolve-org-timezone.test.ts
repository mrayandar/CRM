/**
 * Unit coverage for resolveOrgTimezone (lib/timezones.ts) — the Stage 0 follow-up fix. Without
 * this, every org created before Organization.timezone existed would silently start computing
 * its business periods in UTC the moment Stage 0 shipped, with no admin having chosen that.
 */
import { describe, expect, it } from 'vitest'
import { resolveOrgTimezone } from '@lib/timezones'

describe('resolveOrgTimezone', () => {
  it('uses the stored org timezone once an admin has configured one', () => {
    expect(
      resolveOrgTimezone({
        orgTimezone: 'Asia/Karachi',
        orgTimezoneConfigured: true,
        viewerTimezone: 'America/New_York',
      }),
    ).toBe('Asia/Karachi')
  })

  it("falls back to the viewer's own timezone while unconfigured — never the raw UTC default", () => {
    expect(
      resolveOrgTimezone({
        orgTimezone: 'UTC',
        orgTimezoneConfigured: false,
        viewerTimezone: 'Asia/Karachi',
      }),
    ).toBe('Asia/Karachi')
  })

  it('still falls back to the viewer even if the stored value happens to be something other than UTC (defensive)', () => {
    expect(
      resolveOrgTimezone({
        orgTimezone: 'Europe/London',
        orgTimezoneConfigured: false,
        viewerTimezone: 'Asia/Karachi',
      }),
    ).toBe('Asia/Karachi')
  })

  it('a configured UTC is honored as a real, deliberate choice — not treated as "unset"', () => {
    expect(
      resolveOrgTimezone({
        orgTimezone: 'UTC',
        orgTimezoneConfigured: true,
        viewerTimezone: 'Asia/Karachi',
      }),
    ).toBe('UTC')
  })
})
