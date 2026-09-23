'use client'

import { CreateOrganization } from '@clerk/nextjs'

export default function CreateOrgPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas">
      <CreateOrganization afterCreateOrganizationUrl="/" />
    </div>
  )
}
