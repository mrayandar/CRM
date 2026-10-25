'use client'

import type { ReactNode } from 'react'
import { Sidebar } from './Sidebar'
import { CommandPaletteProvider } from './CommandPalette'
import { SplitPaymentModal } from '@/components/common/SplitPaymentModal'
import { useCrm } from '@/store/crm'
import { NotificationsProvider } from '@/store/notifications'

export function AppLayout({ children }: { children: ReactNode }) {
  const { deals, wonPaymentSetupDealId, closeWonPaymentSetup } = useCrm()
  // Rendered once, here, rather than per-screen, since a deal can enter Won from any of several
  // screens (Pipeline's drag/menu/edit modal/new-deal-as-Won). wonPaymentSetupDealId is already
  // null for anyone without payment access (openWonPaymentSetup no-ops for them via
  // shouldPromptWonPaymentSetup) — nothing further to gate here.
  const wonDeal = wonPaymentSetupDealId ? deals.find((d) => d.id === wonPaymentSetupDealId) : undefined

  return (
    <NotificationsProvider>
      <CommandPaletteProvider>
        <div className="flex h-dvh overflow-hidden bg-canvas">
          <Sidebar />
          {children}
        </div>
        {wonDeal && (
          <SplitPaymentModal
            deal={wonDeal}
            onClose={closeWonPaymentSetup}
            title={`Set up payments for ${wonDeal.name}`}
            cancelLabel="Skip for now"
          />
        )}
      </CommandPaletteProvider>
    </NotificationsProvider>
  )
}
