'use client'

import type { ReactNode } from 'react'
import { Sidebar } from './Sidebar'
import { CommandPaletteProvider } from './CommandPalette'

export function AppLayout({ children }: { children: ReactNode }) {
  return (
    <CommandPaletteProvider>
      <div className="flex h-dvh overflow-hidden bg-canvas">
        <Sidebar />
        {children}
      </div>
    </CommandPaletteProvider>
  )
}
