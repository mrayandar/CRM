'use client'

import { CreateOrganization, OrganizationList, useUser } from '@clerk/nextjs'

/**
 * Where `resolveAuth()` sends a signed-in user with no *active* organization.
 *
 * Two distinct cases land here, and they need different components:
 *  - no memberships at all  -> create one. `skipInvitationScreen` matters:
 *    without it Clerk parks the user on an invite step and never activates
 *    the new org, so `resolveAuth()` bounces them straight back here.
 *  - has memberships, none active -> they must *select* one, which is what
 *    sets the session's active org. Without `afterSelectOrganizationUrl`
 *    there is nowhere for that selection to return to.
 */
export default function CreateOrgPage() {
  const { user, isLoaded } = useUser()

  if (!isLoaded) return null

  const hasMemberships = (user?.organizationMemberships?.length ?? 0) > 0

  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas">
      {hasMemberships ? (
        <OrganizationList
          hidePersonal
          afterSelectOrganizationUrl="/"
          afterCreateOrganizationUrl="/"
        />
      ) : (
        <CreateOrganization skipInvitationScreen afterCreateOrganizationUrl="/" />
      )}
    </div>
  )
}
