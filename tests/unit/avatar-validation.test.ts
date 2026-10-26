import { describe, expect, it } from 'vitest'
import { validateAvatarFile, AVATAR_MAX_BYTES } from '@/lib/avatarValidation'

describe('validateAvatarFile', () => {
  it.each(['image/png', 'image/jpeg', 'image/webp'])('accepts %s under the size cap', (type) => {
    expect(validateAvatarFile({ type, size: 1024 })).toBeNull()
  })

  it.each(['image/gif', 'image/svg+xml', 'application/pdf', 'text/plain', ''])('rejects an unsupported type (%s)', (type) => {
    expect(validateAvatarFile({ type, size: 1024 })).toMatch(/PNG, JPEG, or WEBP/)
  })

  it('accepts a file exactly at the size cap', () => {
    expect(validateAvatarFile({ type: 'image/png', size: AVATAR_MAX_BYTES })).toBeNull()
  })

  it('rejects a file one byte over the size cap', () => {
    expect(validateAvatarFile({ type: 'image/png', size: AVATAR_MAX_BYTES + 1 })).toMatch(/5 MB/)
  })

  it('checks type before size — an oversized file of the wrong type gets the type message', () => {
    expect(validateAvatarFile({ type: 'image/gif', size: AVATAR_MAX_BYTES + 1 })).toMatch(/PNG, JPEG, or WEBP/)
  })
})
