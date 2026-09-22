'use client'

import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle'
type Size = 'xs' | 'sm' | 'md'

const variants: Record<Variant, string> = {
  primary:
    'bg-brand-600 text-white border border-brand-600 hover:bg-brand-700 hover:border-brand-700 shadow-hairline',
  secondary:
    'bg-surface text-ink-700 border border-line-strong hover:bg-subtle hover:text-ink-900 shadow-hairline',
  subtle: 'bg-subtle text-ink-700 border border-transparent hover:bg-[#eeeef0] hover:text-ink-900',
  ghost: 'bg-transparent text-ink-600 border border-transparent hover:bg-subtle hover:text-ink-900',
  danger:
    'bg-surface text-negative border border-negative-line hover:bg-negative-soft shadow-hairline',
}

const sizes: Record<Size, string> = {
  xs: 'h-7 px-2 text-[12px] gap-1 rounded-[6px]',
  sm: 'h-8 px-2.5 text-[13px] gap-1.5 rounded-[7px]',
  md: 'h-9 px-3.5 text-[13.5px] gap-2 rounded-[8px]',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  icon?: ReactNode
  trailingIcon?: ReactNode
}

export function Button({
  variant = 'secondary',
  size = 'sm',
  icon,
  trailingIcon,
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap',
        'transition-[background-color,border-color,color,box-shadow] duration-100',
        'disabled:pointer-events-none disabled:opacity-45',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
      {trailingIcon}
    </button>
  )
}

export function IconButton({
  className,
  variant = 'ghost',
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-[7px] transition-colors duration-100',
        'disabled:pointer-events-none disabled:opacity-45',
        variants[variant],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}
