import { resolveAuth } from '@lib/auth'
import { loadCrmData } from '@lib/data-loader'
import { CrmProvider } from '@/store/crm'
import { AppLayout } from '@/components/layout/AppLayout'

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { orgId, owner } = await resolveAuth()
  const data = await loadCrmData(orgId, owner.id)

  return (
    <CrmProvider initialData={data} orgId={orgId}>
      <AppLayout>{children}</AppLayout>
    </CrmProvider>
  )
}
