'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from '@/lib/router-compat'
import {
  ArrowRightLeft,
  Download,
  Mail,
  MoreHorizontal,
  Plus,
  SlidersHorizontal,
  Trash2,
  UserPlus,
} from 'lucide-react'
import { PageShell } from '@/components/layout/PageShell'
import { Card } from '@/components/ui/Card'
import { Button, IconButton } from '@/components/ui/Button'
import { Badge, LEAD_STATUS_TONE, Tag } from '@/components/ui/Badge'
import { Avatar, CompanyMark } from '@/components/ui/Avatar'
import { Checkbox, Input, Label, SearchInput, Select, Textarea } from '@/components/ui/Field'
import { Modal } from '@/components/ui/Modal'
import { MenuDivider, MenuItem, MenuLabel, Popover } from '@/components/ui/Menu'
import { EmptyState } from '@/components/ui/Display'
import { Td, TableShell, Th, Thead, Tr } from '@/components/ui/Table'
import { LeadFunnel } from '@/components/common/LeadFunnel'
import { CompanyPicker } from '@/components/common/CompanyPicker'
import { useCrm } from '@/store/crm'
import {
  LEAD_STATUS_LABEL,
  LEAD_STATUS_ORDER,
  type Lead,
  type LeadSource,
  type LeadStatus,
} from '@/data/types'
import { cn, currency, currencyCompact, exportCsv, relativeTime, sortBy, sum } from '@/lib/utils'

type SortKey = 'name' | 'company' | 'score' | 'estValue' | 'lastTouchedAt'

const SOURCES = ['Inbound', 'Outbound', 'Referral', 'Event', 'Partner', 'Website'] as const

export function Leads() {
  const navigate = useNavigate()
  const { leads, owners, ownerById, setLeadStatus, updateLead } = useCrm()
  const [params, setParams] = useSearchParams()
  const [newLeadOpen, setNewLeadOpen] = useState(false)
  const [reassignOpen, setReassignOpen] = useState(false)

  const status = (params.get('status') as LeadStatus | null) ?? 'all'
  const [query, setQuery] = useState('')
  const [owner, setOwner] = useState('all')
  const [source, setSource] = useState('all')
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'lastTouchedAt',
    dir: 'desc',
  })
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const counts = useMemo(() => {
    const base = Object.fromEntries(LEAD_STATUS_ORDER.map((s) => [s, 0])) as Record<LeadStatus, number>
    for (const lead of leads) base[lead.status] += 1
    return base
  }, [leads])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows = leads.filter((lead) => {
      if (status !== 'all' && lead.status !== status) return false
      if (owner !== 'all' && lead.ownerId !== owner) return false
      if (source !== 'all' && lead.source !== source) return false
      if (!q) return true
      return `${lead.name} ${lead.company} ${lead.email} ${lead.title}`.toLowerCase().includes(q)
    })

    return sortBy(
      rows,
      (lead) =>
        sort.key === 'lastTouchedAt'
          ? new Date(lead.lastTouchedAt).getTime()
          : sort.key === 'score'
            ? lead.score
            : sort.key === 'estValue'
              ? lead.estValue
              : lead[sort.key].toLowerCase(),
      sort.dir,
    )
  }, [leads, status, owner, source, query, sort])

  const toggleSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    )

  const allSelected = filtered.length > 0 && filtered.every((l) => selected.has(l.id))
  const activeFilters = [owner !== 'all', source !== 'all', status !== 'all'].filter(Boolean).length

  const exportLeads = () => {
    exportCsv(
      'leads.csv',
      filtered.map((lead) => ({
        name: lead.name,
        title: lead.title,
        company: lead.company,
        email: lead.email,
        phone: lead.phone,
        status: LEAD_STATUS_LABEL[lead.status],
        source: lead.source,
        owner: ownerById(lead.ownerId).name,
        score: lead.score,
        estValue: lead.estValue,
        lastTouchedAt: lead.lastTouchedAt,
      })),
    )
  }

  const setStatus = (next: LeadStatus | 'all') => {
    const nextParams = new URLSearchParams(params)
    if (next === 'all') nextParams.delete('status')
    else nextParams.set('status', next)
    setParams(nextParams, { replace: true })
    setSelected(new Set())
  }

  return (
    <PageShell
      title="Leads"
      subtitle={`${filtered.length} of ${leads.length} leads · ${currencyCompact(
        sum(filtered.map((l) => l.estValue)),
      )} estimated value`}
      actions={
        <>
          <Button variant="secondary" size="sm" icon={<Download size={14} />} onClick={exportLeads}>
            Export
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<Plus size={14} />}
            onClick={() => setNewLeadOpen(true)}
          >
            New lead
          </Button>
        </>
      }
      toolbar={
        <>
          <SearchInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search leads by name, company, email…"
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
          <Select value={source} onChange={(e) => setSource(e.target.value)} className="w-[140px]">
            <option value="all">All sources</option>
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <Button
            variant="ghost"
            size="sm"
            icon={<SlidersHorizontal size={13} />}
            className={cn(activeFilters > 0 && 'text-brand-700')}
          >
            {activeFilters === 0
              ? 'Add filter'
              : `${activeFilters} ${activeFilters === 1 ? 'filter' : 'filters'}`}
          </Button>

          <div className="ml-auto flex items-center gap-2">
            {selected.size > 0 ? (
              <div className="flex animate-fade-in items-center gap-2">
                <span className="tabular text-[12px] font-medium text-ink-600">
                  {selected.size} selected
                </span>
                <Button variant="secondary" size="sm" icon={<Mail size={13} />}>
                  Email
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<ArrowRightLeft size={13} />}
                  onClick={() => setReassignOpen(true)}
                >
                  Reassign
                </Button>
                <IconButton label="Delete selected" variant="danger">
                  <Trash2 size={13} />
                </IconButton>
              </div>
            ) : (
              <span className="text-[12px] text-ink-400">
                Sorted by{' '}
                <span className="font-medium text-ink-600">
                  {SORT_LABEL[sort.key]} {sort.dir === 'desc' ? '↓' : '↑'}
                </span>
              </span>
            )}
          </div>
        </>
      }
    >
      <div className="mx-auto max-w-[1440px] space-y-4 p-5">
        <LeadFunnel counts={counts} active={status} onSelect={setStatus} />

        <Card className="overflow-hidden">
          {filtered.length === 0 ? (
            <EmptyState
              icon={<UserPlus size={16} />}
              title="No leads match these filters"
              description="Try clearing the status funnel selection or widening your search."
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    setQuery('')
                    setOwner('all')
                    setSource('all')
                    setStatus('all')
                  }}
                >
                  Clear all filters
                </Button>
              }
            />
          ) : (
            <TableShell>
              <Thead>
                <Th className="w-9 pr-0">
                  <Checkbox
                    checked={allSelected}
                    onChange={(checked) =>
                      setSelected(checked ? new Set(filtered.map((l) => l.id)) : new Set())
                    }
                    label="Select all leads"
                  />
                </Th>
                <Th sortable sorted={sort.key === 'name' && sort.dir} onSort={() => toggleSort('name')}>
                  Lead
                </Th>
                <Th
                  sortable
                  sorted={sort.key === 'company' && sort.dir}
                  onSort={() => toggleSort('company')}
                >
                  Company
                </Th>
                <Th>Status</Th>
                <Th>Source</Th>
                <Th>Owner</Th>
                <Th
                  align="right"
                  sortable
                  sorted={sort.key === 'score' && sort.dir}
                  onSort={() => toggleSort('score')}
                >
                  Score
                </Th>
                <Th
                  align="right"
                  sortable
                  sorted={sort.key === 'estValue' && sort.dir}
                  onSort={() => toggleSort('estValue')}
                >
                  Est. value
                </Th>
                <Th
                  align="right"
                  sortable
                  sorted={sort.key === 'lastTouchedAt' && sort.dir}
                  onSort={() => toggleSort('lastTouchedAt')}
                >
                  Last activity
                </Th>
                <Th className="w-10" />
              </Thead>
              <tbody>
                {filtered.map((lead) => {
                  const ownerRecord = ownerById(lead.ownerId)
                  const isSelected = selected.has(lead.id)
                  return (
                    <Tr
                      key={lead.id}
                      selected={isSelected}
                      onClick={() => navigate(`/leads/${lead.id}`)}
                    >
                      <Td className="pr-0">
                        <span onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={isSelected}
                            label={`Select ${lead.name}`}
                            onChange={(checked) =>
                              setSelected((prev) => {
                                const next = new Set(prev)
                                if (checked) next.add(lead.id)
                                else next.delete(lead.id)
                                return next
                              })
                            }
                          />
                        </span>
                      </Td>
                      <Td>
                        <div className="flex items-center gap-2.5">
                          <Avatar name={lead.name} size="md" />
                          <div className="min-w-0">
                            <p className="truncate text-[13px] leading-[17px] font-medium text-ink-900">
                              {lead.name}
                              {(lead.convertedDealId ?? lead.convertedContactId) && (
                                <Badge tone="brand" className="ml-2">
                                  Converted
                                </Badge>
                              )}
                            </p>
                            <p className="truncate text-[11.5px] leading-4 text-ink-400">
                              {lead.title}
                            </p>
                          </div>
                        </div>
                      </Td>
                      <Td>
                        <div className="flex items-center gap-2">
                          <CompanyMark name={lead.company} />
                          <span className="truncate text-[12.5px] text-ink-700">{lead.company}</span>
                        </div>
                      </Td>
                      <Td>
                        <Badge tone={LEAD_STATUS_TONE[lead.status]} dot>
                          {LEAD_STATUS_LABEL[lead.status]}
                        </Badge>
                      </Td>
                      <Td>
                        <Tag>{lead.source}</Tag>
                      </Td>
                      <Td>
                        <div className="flex items-center gap-2">
                          <Avatar name={ownerRecord.name} initials={ownerRecord.initials} size="xs" />
                          <span className="truncate text-[12.5px] text-ink-600">
                            {ownerRecord.name.split(' ')[0]}
                          </span>
                        </div>
                      </Td>
                      <Td align="right">
                        <ScoreCell score={lead.score} />
                      </Td>
                      <Td align="right" className="tabular font-medium text-ink-900">
                        {currency(lead.estValue)}
                      </Td>
                      <Td align="right" className="tabular text-[12.5px] text-ink-500">
                        {relativeTime(lead.lastTouchedAt)}
                      </Td>
                      <Td>
                        <span onClick={(e) => e.stopPropagation()}>
                          <RowMenu
                            lead={lead}
                            onStatus={(next) => setLeadStatus(lead.id, next)}
                            onOpen={() => navigate(`/leads/${lead.id}`)}
                          />
                        </span>
                      </Td>
                    </Tr>
                  )
                })}
              </tbody>
            </TableShell>
          )}

          {filtered.length > 0 && (
            <div className="flex items-center justify-between border-t border-line bg-subtler px-5 py-2.5">
              <span className="text-[12px] text-ink-500">
                Showing <span className="tabular font-medium text-ink-800">{filtered.length}</span> of{' '}
                {leads.length} leads
              </span>
              <span className="tabular text-[12px] text-ink-500">
                Total estimated value{' '}
                <span className="font-semibold text-ink-900">
                  {currency(sum(filtered.map((l) => l.estValue)))}
                </span>
              </span>
            </div>
          )}
        </Card>
      </div>

      {newLeadOpen && <NewLeadModal onClose={() => setNewLeadOpen(false)} />}

      {reassignOpen && (
        <ReassignModal
          leads={leads.filter((l) => selected.has(l.id))}
          owners={owners}
          updateLead={updateLead}
          onClose={() => setReassignOpen(false)}
          onDone={() => {
            setReassignOpen(false)
            setSelected(new Set())
          }}
        />
      )}
    </PageShell>
  )
}

/** Bulk owner reassignment — reuses updateLead (the same call EditLeadModal makes) per selected
 *  lead, so the tenant-ownership check on the new owner (getOwnerById in updateLeadAction) applies
 *  identically here. */
function ReassignModal({
  leads,
  owners,
  updateLead,
  onClose,
  onDone,
}: {
  leads: Lead[]
  owners: { id: string; name: string; role: string }[]
  updateLead: (leadId: string, input: {
    name: string
    title: string
    email: string
    phone: string
    companyId: string
    source: Lead['source']
    ownerId: string
  }) => void
  onClose: () => void
  onDone: () => void
}) {
  const [ownerId, setOwnerId] = useState(owners[0]?.id ?? '')

  const submit = () => {
    if (!ownerId) return
    for (const lead of leads) {
      updateLead(lead.id, {
        name: lead.name,
        title: lead.title,
        email: lead.email,
        phone: lead.phone,
        companyId: lead.companyId,
        source: lead.source,
        ownerId,
      })
    }
    onDone()
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={440}
      title="Reassign leads"
      description={`Move ${leads.length} ${leads.length === 1 ? 'lead' : 'leads'} to a new owner.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!ownerId}>
            Reassign
          </Button>
        </>
      }
    >
      <Field label="New owner">
        <Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className="h-9">
          {owners.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name} · {o.role}
            </option>
          ))}
        </Select>
      </Field>
    </Modal>
  )
}

function NewLeadModal({ onClose }: { onClose: () => void }) {
  const { addLead, owners, currentUser } = useCrm()
  const [name, setName] = useState('')
  const [companyId, setCompanyId] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [source, setSource] = useState<LeadSource>('Inbound')
  const [status, setStatus] = useState<LeadStatus>('new')
  const [ownerId, setOwnerId] = useState(currentUser.id)
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const emailInvalid = email.trim() !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  const canSubmit = name.trim() !== '' && companyId !== '' && !emailInvalid && !saving

  const submit = async () => {
    if (!canSubmit) return
    setSaving(true)
    setError(null)
    try {
      await addLead({ name, companyId, email, phone, source, status, ownerId, notes })
      onClose()
    } catch {
      setError('Could not save the lead. Please try again.')
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={saving ? () => {} : onClose}
      width={560}
      title="New lead"
      description="Add a prospect to your pipeline. You can convert it to a contact and deal later."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>
            {saving ? 'Creating…' : 'Create lead'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Cooper" autoFocus />
          </Field>
          <CompanyPicker companyId={companyId} onChange={setCompanyId} />
          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jane@acme.com"
              aria-invalid={emailInvalid}
            />
          </Field>
          <Field label="Phone">
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 555 010 0199" />
          </Field>
          <Field label="Source">
            <Select value={source} onChange={(e) => setSource(e.target.value as LeadSource)} className="h-9">
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value as LeadStatus)} className="h-9">
              {LEAD_STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {LEAD_STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Owner">
          <Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className="h-9">
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} · {o.role}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Notes">
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Anything worth remembering about this lead…"
          />
        </Field>

        {emailInvalid && <p className="text-[11.5px] leading-4 text-negative">Enter a valid email address.</p>}
        {error && <p className="text-[11.5px] leading-4 text-negative">{error}</p>}
      </form>
    </Modal>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      {children}
    </div>
  )
}

const SORT_LABEL: Record<SortKey, string> = {
  name: 'name',
  company: 'company',
  score: 'score',
  estValue: 'est. value',
  lastTouchedAt: 'last activity',
}

function ScoreCell({ score }: { score: number }) {
  const tone = score >= 75 ? 'bg-positive' : score >= 50 ? 'bg-ink-400' : 'bg-line-strong'
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1 w-10 overflow-hidden rounded-full bg-subtle">
        <span className={cn('block h-full rounded-full', tone)} style={{ width: `${score}%` }} />
      </span>
      <span className="tabular w-5 text-[12.5px] font-medium text-ink-700">{score}</span>
    </span>
  )
}

function RowMenu({
  lead,
  onStatus,
  onOpen,
}: {
  lead: Lead
  onStatus: (status: LeadStatus) => void
  onOpen: () => void
}) {
  return (
    <Popover
      align="end"
      width={200}
      trigger={({ toggle, open }) => (
        <IconButton
          label={`Actions for ${lead.name}`}
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
          <MenuItem onClick={() => { onOpen(); close() }}>Open lead</MenuItem>
          <MenuItem onClick={close}>Log activity</MenuItem>
          <MenuItem onClick={close}>Send email</MenuItem>
          <MenuDivider />
          <MenuLabel>Set status</MenuLabel>
          {LEAD_STATUS_ORDER.map((s) => (
            <MenuItem
              key={s}
              selected={lead.status === s}
              onClick={() => {
                onStatus(s)
                close()
              }}
            >
              {LEAD_STATUS_LABEL[s]}
            </MenuItem>
          ))}
          <MenuDivider />
          <MenuItem tone="danger" onClick={close}>
            Delete lead
          </MenuItem>
        </>
      )}
    </Popover>
  )
}
