'use client'

import { AlertCircle, X } from 'lucide-react'
import { IconButton } from './Button'

export interface ToastItem {
  id: string
  message: string
}

export function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[]
  onDismiss: (id: string) => void
}) {
  if (toasts.length === 0) return null

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-110 flex w-[calc(100%-2rem)] max-w-[360px] flex-col gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="alert"
          className="pointer-events-auto animate-slide-in flex items-start gap-2.5 rounded-panel border border-line bg-surface py-2.5 pr-2 pl-3 shadow-pop"
        >
          <AlertCircle size={15} className="mt-0.5 shrink-0 text-negative" />
          <p className="min-w-0 flex-1 text-[13px] leading-5 text-ink-800">{toast.message}</p>
          <IconButton label="Dismiss" onClick={() => onDismiss(toast.id)} className="-my-0.5 size-7">
            <X size={13} />
          </IconButton>
        </div>
      ))}
    </div>
  )
}
