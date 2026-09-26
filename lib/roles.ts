/**
 * Maps a Clerk organization role key to the CRM's display role stored on `Owner.role`.
 * Clerk uses prefixed keys ("org:admin" / "org:member"); anything that isn't an admin is a Member.
 * Shared by the on-demand sync in `resolveAuth()` and the Clerk webhook so they can't disagree.
 */
export function ownerRoleFromClerk(clerkRole: string | null | undefined): 'Admin' | 'Member' {
  return clerkRole === 'org:admin' || clerkRole === 'admin' ? 'Admin' : 'Member'
}
