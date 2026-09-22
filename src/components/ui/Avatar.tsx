'use client'

import { cn, initialsOf } from '@/lib/utils'

const sizes = {
  xs: 'size-5 text-[9.5px]',
  sm: 'size-6 text-[10.5px]',
  md: 'size-8 text-[12px]',
  lg: 'size-12 text-[16px]',
  xl: 'size-16 text-[21px]',
} as const

export function Avatar({
  name,
  initials,
  size = 'sm',
  className,
  title,
}: {
  name: string
  initials?: string
  size?: keyof typeof sizes
  className?: string
  title?: string
}) {
  return (
    <span
      title={title ?? name}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full border border-line',
        'bg-subtle font-semibold tracking-[-0.01em] text-ink-600 select-none',
        sizes[size],
        className,
      )}
    >
      {initials ?? initialsOf(name)}
    </span>
  )
}

export function AvatarStack({
  people,
  max = 3,
}: {
  people: Array<{ name: string; initials?: string }>
  max?: number
}) {
  const shown = people.slice(0, max)
  const rest = people.length - shown.length
  return (
    <span className="flex items-center">
      {shown.map((p, i) => (
        <Avatar
          key={p.name}
          name={p.name}
          initials={p.initials}
          size="xs"
          className={cn('ring-2 ring-surface', i > 0 && '-ml-1.5')}
        />
      ))}
      {rest > 0 && (
        <span className="-ml-1.5 inline-flex size-5 items-center justify-center rounded-full border border-line bg-surface text-[9.5px] font-semibold text-ink-500 ring-2 ring-surface">
          +{rest}
        </span>
      )}
    </span>
  )
}

/** Company monogram — square so it reads differently from person avatars. */
export function CompanyMark({
  name,
  size = 'sm',
  className,
}: {
  name: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const dims =
    size === 'lg'
      ? 'size-10 text-[13px] rounded-[9px]'
      : size === 'md'
        ? 'size-8 text-[11.5px] rounded-[7px]'
        : 'size-6 text-[10px] rounded-[6px]'
  return (
    <span
      title={name}
      className={cn(
        'inline-flex shrink-0 items-center justify-center border border-line bg-subtle',
        'font-semibold tracking-[-0.02em] text-ink-500 select-none',
        dims,
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  )
}
