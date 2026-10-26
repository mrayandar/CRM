// Pure, no DOM — client-side guard before AvatarUploader ever calls Clerk's own upload. Clerk
// would reject an invalid file too, but checking here first means a bad pick never leaves the
// browser and the person gets an immediate, specific message instead of a round-trip failure.
export const AVATAR_ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024

/** Null means valid. Takes a plain `{ type, size }` (what a `File` already is) rather than the
 *  `File` type itself, so this is testable without constructing a real File/Blob. */
export function validateAvatarFile(file: { type: string; size: number }): string | null {
  if (!AVATAR_ALLOWED_TYPES.includes(file.type as (typeof AVATAR_ALLOWED_TYPES)[number])) {
    return 'Please choose a PNG, JPEG, or WEBP image.'
  }
  if (file.size > AVATAR_MAX_BYTES) {
    return 'Images must be 5 MB or smaller.'
  }
  return null
}
