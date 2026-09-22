'use client'

import type { ReactNode, ThHTMLAttributes } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { cn } from '@/lib/utils'

export function TableShell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-x-auto scrollbar-slim', className)}>
      <table className="w-full min-w-[880px] border-collapse text-left">{children}</table>
    </div>
  )
}

export function Thead({ children }: { children: ReactNode }) {
  return (
    <thead className="sticky top-0 z-10 bg-subtler/95 backdrop-blur-sm">
      <tr className="border-b border-line">{children}</tr>
    </thead>
  )
}

interface ThProps extends ThHTMLAttributes<HTMLTableCellElement> {
  align?: 'left' | 'right'
  sortable?: boolean
  sorted?: 'asc' | 'desc' | false
  onSort?: () => void
  children?: ReactNode
}

export function Th({ align = 'left', sortable, sorted, onSort, className, children, ...rest }: ThProps) {
  const content = (
    <span
      className={cn(
        'inline-flex items-center gap-1',
        align === 'right' && 'flex-row-reverse',
      )}
    >
      {children}
      {sortable && (
        <span className={cn('text-ink-400', !sorted && 'opacity-0 group-hover/th:opacity-60')}>
          {sorted === 'desc' ? <ArrowDown size={11} /> : <ArrowUp size={11} />}
        </span>
      )}
    </span>
  )

  return (
    <th
      scope="col"
      className={cn(
        'group/th h-9 px-3 text-[11.5px] leading-4 font-semibold tracking-[0.01em] whitespace-nowrap',
        sorted ? 'text-ink-700' : 'text-ink-500',
        align === 'right' && 'text-right',
        sortable && 'cursor-pointer select-none hover:text-ink-900',
        className,
      )}
      onClick={sortable ? onSort : undefined}
      {...rest}
    >
      {content}
    </th>
  )
}

export function Tr({
  children,
  onClick,
  className,
  selected,
}: {
  children: ReactNode
  onClick?: () => void
  className?: string
  selected?: boolean
}) {
  return (
    <tr
      onClick={onClick}
      className={cn(
        'group/row border-b border-line last:border-b-0 transition-colors duration-75',
        onClick && 'cursor-pointer',
        selected ? 'bg-brand-50/60' : 'hover:bg-subtler',
        className,
      )}
    >
      {children}
    </tr>
  )
}

export function Td({
  children,
  align = 'left',
  className,
  colSpan,
}: {
  children?: ReactNode
  align?: 'left' | 'right'
  className?: string
  colSpan?: number
}) {
  return (
    <td
      colSpan={colSpan}
      className={cn(
        'h-[46px] px-3 align-middle text-[13px] leading-5 text-ink-700',
        align === 'right' && 'text-right',
        className,
      )}
    >
      {children}
    </td>
  )
}

/** Sub-header row that introduces a group of rows (e.g. a company). */
export function GroupRow({
  children,
  colSpan,
}: {
  children: ReactNode
  colSpan: number
}) {
  return (
    <tr className="border-b border-line bg-subtle/70">
      <td colSpan={colSpan} className="h-8 px-3">
        {children}
      </td>
    </tr>
  )
}
