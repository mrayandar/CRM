'use client'

import { NavLink } from '@/lib/router-compat'
import {
  BarChart3,
  Building2,
  CheckSquare,
  Columns3,
  LayoutDashboard,
  Settings,
  Users,
  UserPlus,
  ChevronsUpDown,
} from 'lucide-react'
import { cn, dayDelta } from '@/lib/utils'
import { useCrm } from '@/store/crm'
import { Avatar } from '@/components/ui/Avatar'
import { Popover, MenuDivider, MenuItem, MenuLabel } from '@/components/ui/Menu'
import {
  OrganizationSwitcher,
  useUser,
  useClerk,
} from '@clerk/nextjs'

interface NavEntry {
  to: string
  label: string
  icon: typeof LayoutDashboard
  count?: number
  countTone?: 'neutral' | 'alert'
}

export function Sidebar() {
  const { leads, tasks, deals, contacts, stageById } = useCrm()

  const newLeads = leads.filter((l) => l.status === 'new').length
  const overdueTasks = tasks.filter((t) => !t.done && dayDelta(t.dueDate) < 0).length
  const openTasks = tasks.filter((t) => !t.done).length
  // Same definition Dashboard's "Closing in 30 days" card uses: any open deal due within 30
  // days (including already-overdue ones, same as that card).
  const closingSoon = deals.filter((d) => !stageById(d.stageId).isClosed && dayDelta(d.closeDate) <= 30).length
  const champions = contacts.filter((c) => c.lifecycle === 'Champion').length

  const primary: NavEntry[] = [
    { to: '/', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/leads', label: 'Leads', icon: UserPlus, count: newLeads },
    { to: '/contacts', label: 'Contacts', icon: Users },
    { to: '/companies', label: 'Companies', icon: Building2 },
    { to: '/pipeline', label: 'Pipeline', icon: Columns3 },
    {
      to: '/tasks',
      label: 'Tasks',
      icon: CheckSquare,
      count: overdueTasks || openTasks,
      countTone: overdueTasks ? 'alert' : 'neutral',
    },
    { to: '/reports', label: 'Reports', icon: BarChart3 },
    { to: '/settings', label: 'Settings', icon: Settings },
  ]

  return (
    <aside className="flex h-dvh w-[236px] shrink-0 flex-col border-r border-line bg-surface">
      <WorkspaceSwitcher />

      <nav className="flex-1 overflow-y-auto scrollbar-slim px-2 py-2">
        <ul className="space-y-0.5">
          {primary.map((entry) => (
            <li key={entry.to}>
              <NavItem {...entry} />
            </li>
          ))}
        </ul>

        <div className="mt-5 px-2">
          <p className="mb-1.5 text-[10.5px] font-semibold tracking-[0.07em] text-ink-400 uppercase">
            Saved views
          </p>
          <ul className="space-y-0.5">
            <SavedView to="/leads?status=new" label="Untouched leads" count={newLeads} />
            <SavedView to="/pipeline?close=30" label="Closing in 30 days" count={closingSoon} />
            <SavedView to="/contacts?tag=Champion" label="Champions" count={champions} />
          </ul>
        </div>
      </nav>

      {/*
        A quota widget belongs here once there's a real org-level target to show — see
        PROGRESS.md for the recommendation (wire up Settings' "Quarterly team quota" field to a
        persisted value). Showing one against a fabricated number was worse than showing nothing.
      */}
      <div className="border-t border-line p-2">
        <UserMenu />
      </div>
    </aside>
  )
}

function WorkspaceSwitcher() {
  return (
    <div className="flex h-14 shrink-0 items-center border-b border-line px-2">
      <OrganizationSwitcher
        hidePersonal
        afterCreateOrganizationUrl="/"
        afterSelectOrganizationUrl="/"
        appearance={{
          elements: {
            rootBox: 'w-full',
            organizationSwitcherTrigger:
              'w-full rounded-[8px] px-1.5 py-1.5 hover:bg-subtler transition-colors text-[13px]',
          },
        }}
      />
    </div>
  )
}

function UserMenu() {
  const { currentUser } = useCrm()
  const { user: clerkUser } = useUser()
  const { signOut } = useClerk()

  const displayName = clerkUser?.fullName ?? currentUser.name
  const displayEmail = clerkUser?.primaryEmailAddress?.emailAddress ?? currentUser.email
  const displayRole = currentUser.role
  const initials = currentUser.initials

  return (
    <Popover
      width={228}
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={toggle}
          className="flex w-full items-center gap-2.5 rounded-panel px-2 py-2 text-left transition-colors hover:bg-subtle"
        >
          <Avatar name={displayName} initials={initials} size="md" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-semibold text-ink-900">
              {displayName}
            </span>
            <span className="block truncate text-[11.5px] text-ink-500">{displayRole}</span>
          </span>
          <ChevronsUpDown size={13} className="shrink-0 text-ink-400" />
        </button>
      )}
    >
      {({ close }) => (
        <>
          <MenuLabel>{displayEmail}</MenuLabel>
          <MenuItem onClick={close}>Profile & preferences</MenuItem>
          <MenuItem onClick={close}>Notification settings</MenuItem>
          <MenuItem onClick={close}>Keyboard shortcuts</MenuItem>
          <MenuDivider />
          <MenuItem
            onClick={() => {
              close()
              signOut({ redirectUrl: '/sign-in' })
            }}
            tone="danger"
          >
            Sign out
          </MenuItem>
        </>
      )}
    </Popover>
  )
}

function NavItem({ to, label, icon: Icon, count, countTone = 'neutral' }: NavEntry) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        cn(
          'group flex h-8 items-center gap-2.5 rounded-[7px] px-2 text-[13px] font-medium transition-colors duration-75',
          isActive
            ? 'bg-subtle text-ink-900'
            : 'text-ink-600 hover:bg-subtler hover:text-ink-900',
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            size={15}
            strokeWidth={2}
            className={cn('shrink-0', isActive ? 'text-brand-600' : 'text-ink-400 group-hover:text-ink-600')}
          />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {count !== undefined && count > 0 && (
            <span
              className={cn(
                'tabular rounded-full px-1.5 text-[10.5px] leading-[17px] font-semibold',
                countTone === 'alert'
                  ? 'bg-negative-soft text-negative'
                  : 'bg-subtle text-ink-500 group-hover:bg-[#ececef]',
              )}
            >
              {count}
            </span>
          )}
        </>
      )}
    </NavLink>
  )
}

function SavedView({ to, label, count }: { to: string; label: string; count: number }) {
  return (
    <li>
      <NavLink
        to={to}
        className="group flex h-7 items-center gap-2 rounded-[7px] px-0 text-[12.5px] text-ink-500 transition-colors hover:text-ink-900"
      >
        <span className="size-1 shrink-0 rounded-full bg-ink-400/60" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="tabular text-[11px] text-ink-400">{count}</span>
      </NavLink>
    </li>
  )
}
