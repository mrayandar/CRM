import { resolveAuth, canAccessPayments } from '@lib/auth'
import { loadCrmData } from '@lib/data-loader'
import { CrmProvider } from '@/store/crm'
import { QueryProvider } from '@/store/queryClient'
import { QueryCacheSecurityGuard } from '@/store/QueryCacheSecurityGuard'
import { AppLayout } from '@/components/layout/AppLayout'

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { orgId, owner, scopeOwnerId } = await resolveAuth()
  const hasPaymentAccess = await canAccessPayments()
  const data = await loadCrmData({ orgId, scopeOwnerId }, owner.id, hasPaymentAccess)

  return (
    <QueryProvider>
      <CrmProvider initialData={data} orgId={orgId}>
        <QueryCacheSecurityGuard>
          <AppLayout>{children}</AppLayout>
        </QueryCacheSecurityGuard>
      </CrmProvider>
    </QueryProvider>
  )
}
