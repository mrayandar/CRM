'use client'

import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from '@/lib/router-compat'
import {
  Building2,
  ChevronDown,
  ChevronRight,
  Download,
  MoreHorizontal,
  Plus,
  Users,
} from 'lucide-react'
import { PageShell } from '@/components/layout/PageShell'
import { Card } from '@/components/ui/Card'
import { Button, IconButton } from '@/components/ui/Button'
import { Badge, Tag, type Tone } from '@/components/ui/Badge'
import { Avatar, CompanyMark } from '@/components/ui/Avatar'
import { SearchInput, Segmented, Select } from '@/components/ui/Field'
import { MenuDivider, MenuItem, Popover } from '@/components/ui/Menu'
import { EmptyState } from '@/components/ui/Display'
import { GroupRow, Td, TableShell, Th, Thead, Tr } from '@/components/ui/Table'
import { useCrm } from '@/store/crm'
import type { Contact } from '@/data/types'
import { cn, currency, currencyCompact, dayDelta, relativeTime, sortBy, sum } from '@/lib/utils'

const LIFECYCLE_TONE: Record<Contact['lifecycle'], Tone> = {
  Customer: 'positive',
  Champion: 'accent',
  Prospect: 'info',
  Evaluator: 'neutral',
  Churned: 'negative',
}

type View = 'company' | 'flat'

export function Contacts() {
  const navigate = useNavigate()
  const { contacts, owners, ownerById } = useCrm()
  const [params, setParams] = useSearchParams()

  const tagFilter = params.get('tag')
  const [query, setQuery] = useState('')
  const [owner, setOwner] = useState('all')
  const [lifecycle, setLifecycle] = useState('all')
  const [view, setView] = useState<View>('company')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return contacts.filter((c) => {
      if (owner !== 'all' && c.ownerId !== owner) return false
      if (lifecycle !== 'all' && c.lifecycle !== lifecycle) return false
      if (tagFilter && !c.tags.includes(tagFilter)) return false
      if (!q) return true
      return `${c.name} ${c.company} ${c.email} ${c.title} ${c.tags.join(' ')}`
        .toLowerCase()
        .includes(q)
    })
  }, [contacts, query, owner, lifecycle, tagFilter])

  const companies = useMemo(() => {
    const map = new Map<string, Contact[]>()
    for (const contact of sortBy(filtered, (c) => c.name)) {
      const list = map.get(contact.company) ?? []
      list.push(contact)
      map.set(contact.company, list)
    }
    return sortBy([...map.entries()], ([, list]) => -list[0]!.accountValue).map(
      ([company, people]) => ({
        company,
        people,
        accountValue: people[0]!.accountValue,
        openDeals: sum(people.map((p) => p.openDeals)),
        lastInteractionAt: sortBy(people, (p) => -new Date(p.lastInteractionAt).getTime())[0]!
          .lastInteractionAt,
      }),
    )
  }, [filtered])

  const flatRows = useMemo(
    () => sortBy(filtered, (c) => -new Date(c.lastInteractionAt).getTime()),
    [filtered],
  )

  const columnCount = view === 'company' ? 7 : 8
  const stale = filtered.filter((c) => dayDelta(c.lastInteractionAt) <= -30).length

  return (
    <PageShell
      title="Contacts"
      subtitle={`${filtered.length} contacts across ${companies.length} companies · ${stale} not touched in 30 days`}
      actions={
        <>
          <Button variant="secondary" size="sm" icon={<Download size={14} />}>
            Export
          </Button>
          <Button variant="primary" size="sm" icon={<Plus size={14} />}>
            New contact
          </Button>
        </>
      }
      toolbar={
        <>
          <SearchInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search contacts, companies, tags…"
            className="w-full sm:w-[290px]"
          />
          <Select value={owner} onChange={(e) => setOwner(e.target.value)} className="w-[150px]">
            <option value="all">All owners</option>
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
          <Select
            value={lifecycle}
            onChange={(e) => setLifecycle(e.target.value)}
            className="w-[150px]"
          >
            <option value="all">All lifecycle stages</option>
            {Object.keys(LIFECYCLE_TONE).map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
          {tagFilter && (
            <Button
              variant="subtle"
              size="sm"
              onClick={() => {
                const next = new URLSearchParams(params)
                next.delete('tag')
                setParams(next, { replace: true })
              }}
            >
              Tag: {tagFilter} ✕
            </Button>
          )}

          <div className="ml-auto">
            <Segmented
              value={view}
              onChange={setView}
              options={[
                { value: 'company', label: 'By company' },
                { value: 'flat', label: 'All contacts' },
              ]}
            />
          </div>
        </>
      }
    >
      <div className="mx-auto max-w-[1440px] p-5">
        <Card className="overflow-hidden">
          {filtered.length === 0 ? (
            <EmptyState
              icon={<Users size={16} />}
              title="No contacts match these filters"
              description="Adjust the owner, lifecycle stage, or search terms to see more people."
            />
          ) : (
            <TableShell>
              <Thead>
                <Th>Contact</Th>
                {view === 'flat' && <Th>Company</Th>}
                <Th>Tags</Th>
                <Th>Lifecycle</Th>
                <Th>Owner</Th>
                <Th align="right">Open deals</Th>
                <Th align="right">Last interaction</Th>
                <Th className="w-10" />
              </Thead>

              {view === 'company' ? (
                companies.map(({ company, people, accountValue, openDeals, lastInteractionAt }) => {
                  const isCollapsed = collapsed.has(company)
                  return (
                    <tbody key={company}>
                      <GroupRow colSpan={columnCount}>
                        <button
                          type="button"
                          onClick={() =>
                            setCollapsed((prev) => {
                              const next = new Set(prev)
                              if (next.has(company)) next.delete(company)
                              else next.add(company)
                              return next
                            })
                          }
                          className="flex w-full items-center gap-2 text-left"
                        >
                          {isCollapsed ? (
                            <ChevronRight size={13} className="text-ink-400" />
                          ) : (
                            <ChevronDown size={13} className="text-ink-400" />
                          )}
                          <CompanyMark name={company} />
                          <span className="text-[12.5px] font-semibold text-ink-900">{company}</span>
                          <span className="tabular text-[11.5px] text-ink-400">
                            {people.length} {people.length === 1 ? 'contact' : 'contacts'}
                          </span>
                          <span className="ml-auto flex items-center gap-4">
                            {openDeals > 0 && (
                              <span className="tabular text-[11.5px] text-ink-500">
                                {openDeals} open {openDeals === 1 ? 'deal' : 'deals'}
                              </span>
                            )}
                            <span className="tabular text-[11.5px] text-ink-500">
                              {accountValue > 0 ? `${currencyCompact(accountValue)} account` : 'No revenue yet'}
                            </span>
                            <span className="tabular w-[100px] text-right text-[11.5px] text-ink-400">
                              {relativeTime(lastInteractionAt)}
                            </span>
                          </span>
                        </button>
                      </GroupRow>
                      {!isCollapsed &&
                        people.map((contact) => (
                          <ContactRow
                            key={contact.id}
                            contact={contact}
                            showCompany={false}
                            ownerName={ownerById(contact.ownerId).name}
                            ownerInitials={ownerById(contact.ownerId).initials}
                            onOpen={() => navigate(`/contacts/${contact.id}`)}
                          />
                        ))}
                    </tbody>
                  )
                })
              ) : (
                <tbody>
                  {flatRows.map((contact) => (
                    <ContactRow
                      key={contact.id}
                      contact={contact}
                      showCompany
                      ownerName={ownerById(contact.ownerId).name}
                      ownerInitials={ownerById(contact.ownerId).initials}
                      onOpen={() => navigate(`/contacts/${contact.id}`)}
                    />
                  ))}
                </tbody>
              )}
            </TableShell>
          )}

          {filtered.length > 0 && (
            <div className="flex items-center justify-between border-t border-line bg-subtler px-5 py-2.5">
              <span className="text-[12px] text-ink-500">
                <span className="tabular font-medium text-ink-800">{filtered.length}</span> contacts ·{' '}
                <span className="tabular font-medium text-ink-800">{companies.length}</span> companies
              </span>
              <span className="tabular text-[12px] text-ink-500">
                Total account value{' '}
                <span className="font-semibold text-ink-900">
                  {currency(sum(companies.map((c) => c.accountValue)))}
                </span>
              </span>
            </div>
          )}
        </Card>
      </div>
    </PageShell>
  )
}

function ContactRow({
  contact,
  showCompany,
  ownerName,
  ownerInitials,
  onOpen,
}: {
  contact: Contact
  showCompany: boolean
  ownerName: string
  ownerInitials: string
  onOpen: () => void
}) {
  const stale = dayDelta(contact.lastInteractionAt) <= -30

  return (
    <Tr onClick={onOpen}>
      <Td>
        <div className="flex items-center gap-2.5">
          <Avatar name={contact.name} size="md" />
          <div className="min-w-0">
            <p className="truncate text-[13px] leading-[17px] font-medium text-ink-900">
              {contact.name}
            </p>
            <p className="truncate text-[11.5px] leading-4 text-ink-400">{contact.title}</p>
          </div>
        </div>
      </Td>
      {showCompany && (
        <Td>
          <div className="flex items-center gap-2">
            <CompanyMark name={contact.company} />
            <span className="truncate text-[12.5px] text-ink-700">{contact.company}</span>
          </div>
        </Td>
      )}
      <Td>
        <div className="flex flex-wrap items-center gap-1">
          {contact.tags.slice(0, 2).map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
          {contact.tags.length > 2 && (
            <span className="text-[11.5px] text-ink-400">+{contact.tags.length - 2}</span>
          )}
        </div>
      </Td>
      <Td>
        <Badge tone={LIFECYCLE_TONE[contact.lifecycle]} dot>
          {contact.lifecycle}
        </Badge>
      </Td>
      <Td>
        <div className="flex items-center gap-2">
          <Avatar name={ownerName} initials={ownerInitials} size="xs" />
          <span className="truncate text-[12.5px] text-ink-600">{ownerName.split(' ')[0]}</span>
        </div>
      </Td>
      <Td align="right" className="tabular">
        {contact.openDeals > 0 ? (
          <span className="font-medium text-ink-900">{contact.openDeals}</span>
        ) : (
          <span className="text-ink-400">—</span>
        )}
      </Td>
      <Td align="right">
        <span
          className={cn('tabular text-[12.5px]', stale ? 'text-warning' : 'text-ink-500')}
          title={stale ? 'No interaction in over 30 days' : undefined}
        >
          {relativeTime(contact.lastInteractionAt)}
        </span>
      </Td>
      <Td>
        <span onClick={(e) => e.stopPropagation()}>
          <Popover
            align="end"
            width={196}
            trigger={({ toggle, open }) => (
              <IconButton
                label={`Actions for ${contact.name}`}
                onClick={toggle}
                className={cn(
                  'text-ink-400',
                  open
                    ? 'bg-subtle text-ink-700'
                    : 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100',
                )}
              >
                <MoreHorizontal size={15} />
              </IconButton>
            )}
          >
            {({ close }) => (
              <>
                <MenuItem onClick={() => { onOpen(); close() }}>Open contact</MenuItem>
                <MenuItem onClick={close}>Log activity</MenuItem>
                <MenuItem onClick={close}>Add to sequence</MenuItem>
                <MenuItem icon={<Building2 size={13} />} onClick={close}>
                  View company
                </MenuItem>
                <MenuDivider />
                <MenuItem tone="danger" onClick={close}>
                  Delete contact
                </MenuItem>
              </>
            )}
          </Popover>
        </span>
      </Td>
    </Tr>
  )
}
