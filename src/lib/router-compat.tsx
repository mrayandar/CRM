'use client'

/**
 * Thin compatibility layer over Next.js's App Router navigation primitives,
 * shaped to match the react-router-dom v6 API this UI was originally built
 * against (`Link` with a `to` prop, `NavLink` render props, `useNavigate`,
 * `useSearchParams` with a setter). This lets every existing page/component
 * keep its JSX and logic exactly as-is — only the import line changes from
 * `react-router-dom` to `@/lib/router-compat`.
 */

import NextLink from 'next/link'
import {
  usePathname,
  useRouter,
  useSearchParams as useNextSearchParams,
} from 'next/navigation'
import { useCallback, type AnchorHTMLAttributes, type ReactNode } from 'react'

export { useParams } from 'next/navigation'

type NavigateOptions = { replace?: boolean }

export function useNavigate() {
  const router = useRouter()
  return useCallback(
    (path: string, opts?: NavigateOptions) => {
      if (opts?.replace) router.replace(path)
      else router.push(path)
    },
    [router],
  )
}

/**
 * Mirrors react-router-dom's `useSearchParams`: returns a live snapshot of
 * the current query string plus a setter that pushes/replaces the URL,
 * built on top of Next's read-only `useSearchParams` + `useRouter`.
 */
export function useSearchParams(): [
  URLSearchParams,
  (next: URLSearchParams, opts?: NavigateOptions) => void,
] {
  const router = useRouter()
  const pathname = usePathname() ?? '/'
  const current = useNextSearchParams()
  const snapshot = new URLSearchParams(current.toString())

  const setSearchParams = useCallback(
    (next: URLSearchParams, opts?: NavigateOptions) => {
      const qs = next.toString()
      const url = qs ? `${pathname}?${qs}` : pathname
      if (opts?.replace) router.replace(url)
      else router.push(url)
    },
    [pathname, router],
  )

  return [snapshot, setSearchParams]
}

interface CompatLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  to: string
  children?: ReactNode
}

export function Link({ to, children, ...rest }: CompatLinkProps) {
  return (
    <NextLink href={to} {...rest}>
      {children}
    </NextLink>
  )
}

interface NavLinkRenderProps {
  isActive: boolean
}

interface CompatNavLinkProps {
  to: string
  end?: boolean
  className?: string | ((props: NavLinkRenderProps) => string)
  children?: ReactNode | ((props: NavLinkRenderProps) => ReactNode)
}

export function NavLink({ to, end = false, className, children }: CompatNavLinkProps) {
  const pathname = usePathname() ?? '/'
  const toPath = to.split('?')[0]!

  const isActive = end
    ? pathname === toPath
    : pathname === toPath || pathname.startsWith(toPath === '/' ? '\u0000' : `${toPath}/`)

  const resolvedClassName = typeof className === 'function' ? className({ isActive }) : className
  const resolvedChildren = typeof children === 'function' ? children({ isActive }) : children

  return (
    <Link to={to} className={resolvedClassName}>
      {resolvedChildren}
    </Link>
  )
}
