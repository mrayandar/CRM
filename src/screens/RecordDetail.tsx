'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { Link, useParams } from '@/lib/router-compat'
import {
  ArrowRight,
  Building2,
  CalendarPlus,
  CheckCircle2,
  Coins,
  ExternalLink,
  Mail,
  MapPin,
  Phone,
  Plus,
  Sparkles,
  StickyNote,
} from 'lucide-react'
import { PageShell } from '@/components/layout/PageShell'
import { Card, CardHeader, SectionLabel } from '@/components/ui/Card'
import { Button, IconButton } from '@/components/ui/Button'
import { Badge, DEAL_STAGE_TONE, LEAD_STATUS_TONE, Tag, type Tone } from '@/components/ui/Badge'
import { Avatar, CompanyMark } from '@/components/ui/Avatar'
import { EmptyState, KeyValue, Meter } from '@/components/ui/Display'
import { Input, Label, Segmented, Select, Textarea } from '@/components/ui/Field'
import { Modal } from '@/components/ui/Modal'
import { MenuItem, Popover } from '@/components/ui/Menu'
import { ActivityTimeline } from '@/components/common/ActivityStream'
import { TaskRow } from '@/components/common/TaskRow'
import { useCrm } from '@/store/crm'
import { generatedTimeline } from '@/data/timeline'
import {
  DEAL_STAGE_LABEL,
  LEAD_STATUS_LABEL,
  LEAD_STATUS_ORDER,
  type Activity,
  type Contact,
  type Deal,
  type Lead,
  type Priority,
} from '@/data/types'
import {
  cn,
  currency,
  formatDate,
  relativeTime,
  sortBy,
} from '@/lib/utils'

type Tab = 'activity' | 'tasks' | 'notes' | 'deals'

const LIFECYCLE_TONE: Record<Contact['lifecycle'], Tone> = {
  Customer: 'positive',
  Champion: 'accent',
  Prospect: 'info',
  Evaluator: 'neutral',
  Churned: 'negative',
}

export function LeadDetail() {
  const { id } = useParams<{ id: string }>()
  const { leads } = useCrm()
  const lead = leads.find((l) => l.id === id)

  if (!lead) return <NotFound kind="Lead" backTo="/leads" />
  return <RecordDetail key={lead.id} lead={lead} />
}

export function ContactDetail() {
  const { id } = useParams<{ id: string }>()
  const { contacts } = useCrm()
  const contact = contacts.find((c) => c.id === id)

  if (!contact) return <NotFound kind="Contact" backTo="/contacts" />
  return <RecordDetail key={contact.id} contact={contact} />
}

function RecordDetail({ lead, contact }: { lead?: Lead; contact?: Contact }) {
  const {
    activities,
    tasks,
    deals,
    contacts,
    ownerById,
    addNote,
    addTask,
    setLeadStatus,
  } = useCrm()

  const record = (lead ?? contact)!
  const type = lead ? 'lead' : 'contact'
  const subject = { type, id: record.id, label: record.name } as const

  const [tab, setTab] = useState<Tab>('activity')
  const [note, setNote] = useState('')
  const [newTask, setNewTask] = useState('')
  const [convertOpen, setConvertOpen] = useState(false)
  const [converted, setConverted] = useState<{ dealId: string | null; contactId: string } | null>(null)

  const owner = ownerById(record.ownerId)

  const timeline = useMemo(() => {
    const real = activities.filter((a) => a.subject?.id === record.id)
    const seeded = generatedTimeline({
      id: record.id,
      name: record.name,
      company: record.company,
      createdAt: record.createdAt,
      lastActivityAt: lead ? lead.lastTouchedAt : contact!.lastInteractionAt,
      ownerId: record.ownerId,
      type,
    })
    const merged: Activity[] = [...real, ...seeded]
    return sortBy(merged, (a) => new Date(a.at).getTime(), 'desc')
  }, [activities, record, type, lead, contact])

  const notes = timeline.filter((a) => a.kind === 'note')
  const recordTasks = tasks.filter((t) => t.relatedTo?.id === record.id)
  const openTasks = recordTasks.filter((t) => !t.done)

  const relatedDeals = deals.filter(
    (d) =>
      d.company === record.company ||
      d.leadId === record.id ||
      (contact && d.contactId === contact.id),
  )

  // A lead that has been converted also exists as a contact — don't list it as a colleague.
  const colleagues = contacts.filter(
    (c) => c.company === record.company && c.id !== record.id && c.leadId !== record.id,
  )

  const submitNote = () => {
    const body = note.trim()
    if (!body) return
    addNote(subject, body)
    setNote('')
    setTab('activity')
  }

  const submitTask = () => {
    const title = newTask.trim()
    if (!title) return
    addTask({
      title,
      dueDate: new Date(Date.now() + 86_400_000 * 2).toISOString(),
      priority: 'medium',
      subject,
    })
    setNewTask('')
  }

  const tabs: Array<{ value: Tab; label: string; count?: number }> = [
    { value: 'activity', label: 'Activity', count: timeline.length },
    { value: 'tasks', label: 'Tasks', count: openTasks.length },
    { value: 'notes', label: 'Notes', count: notes.length },
    { value: 'deals', label: 'Deals', count: relatedDeals.length },
  ]

  return (
    <PageShell
      back={lead ? '/leads' : '/contacts'}
      eyebrow={lead ? 'Lead' : 'Contact'}
      title={record.name}
      subtitle={`${record.title} · ${record.company}`}
      actions={
        <>
          <Button variant="secondary" size="sm" icon={<Mail size={14} />}>
            Email
          </Button>
          <Button variant="secondary" size="sm" icon={<CalendarPlus size={14} />}>
            Schedule
          </Button>
          {lead ? (
            <Button
              variant="primary"
              size="sm"
              icon={<Sparkles size={14} />}
              disabled={Boolean(lead.convertedDealId ?? converted)}
              onClick={() => setConvertOpen(true)}
            >
              {lead.convertedDealId ?? converted ? 'Converted' : 'Convert to deal'}
            </Button>
          ) : (
            <Button variant="primary" size="sm" icon={<Plus size={14} />}>
              New deal
            </Button>
          )}
        </>
      }
    >
      <div className="mx-auto grid max-w-[1440px] items-start gap-4 p-5 lg:grid-cols-[340px_minmax(0,1fr)]">
        {/* ---------------- Profile panel ---------------- */}
        <div className="space-y-4 lg:sticky lg:top-5">
          <Card className="overflow-hidden">
            <div className="flex flex-col items-start gap-3 px-5 pt-5 pb-4">
              <Avatar name={record.name} size="xl" />
              <div>
                <h2 className="text-[17px] leading-6 font-semibold tracking-[-0.02em] text-ink-900">
                  {record.name}
                </h2>
                <p className="mt-0.5 text-[12.5px] text-ink-500">{record.title}</p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {lead && (
                  <Badge tone={LEAD_STATUS_TONE[lead.status]} dot>
                    {LEAD_STATUS_LABEL[lead.status]}
                  </Badge>
                )}
                {contact && (
                  <Badge tone={LIFECYCLE_TONE[contact.lifecycle]} dot>
                    {contact.lifecycle}
                  </Badge>
                )}
                {lead && <Tag>{lead.source}</Tag>}
                {(lead?.convertedDealId ?? converted) && <Badge tone="brand">Converted</Badge>}
              </div>

              <div className="mt-1 flex w-full items-center gap-1.5">
                <Button variant="secondary" size="sm" icon={<Mail size={13} />} className="flex-1">
                  Email
                </Button>
                <Button variant="secondary" size="sm" icon={<Phone size={13} />} className="flex-1">
                  Call
                </Button>
                {lead && (
                  <Popover
                    align="end"
                    width={180}
                    trigger={({ toggle }) => (
                      <IconButton label="Change status" variant="secondary" onClick={toggle}>
                        <ArrowRight size={14} />
                      </IconButton>
                    )}
                  >
                    {({ close }) => (
                      <>
                        {LEAD_STATUS_ORDER.map((s) => (
                          <MenuItem
                            key={s}
                            selected={lead.status === s}
                            onClick={() => {
                              setLeadStatus(lead.id, s)
                              close()
                            }}
                          >
                            {LEAD_STATUS_LABEL[s]}
                          </MenuItem>
                        ))}
                      </>
                    )}
                  </Popover>
                )}
              </div>
            </div>

            <dl className="border-t border-line px-5 py-3">
              <KeyValue label="Email">
                <a
                  href={`mailto:${record.email}`}
                  className="truncate text-brand-700 hover:underline"
                >
                  {record.email}
                </a>
              </KeyValue>
              <KeyValue label="Phone">
                <span className="tabular">{record.phone}</span>
              </KeyValue>
              <KeyValue label="Company">
                <span className="inline-flex items-center gap-1.5">
                  <CompanyMark name={record.company} />
                  {record.company}
                </span>
              </KeyValue>
              <KeyValue label="Location">
                <span className="inline-flex items-center gap-1.5 text-ink-600">
                  <MapPin size={11} className="text-ink-400" />
                  {record.location}
                </span>
              </KeyValue>
              <KeyValue label="Owner">
                <span className="inline-flex items-center gap-1.5">
                  <Avatar name={owner.name} initials={owner.initials} size="xs" />
                  {owner.name}
                </span>
              </KeyValue>
              <KeyValue label="Created">{formatDate(record.createdAt)}</KeyValue>
              <KeyValue label="Last activity">
                {relativeTime(lead ? lead.lastTouchedAt : contact!.lastInteractionAt)}
              </KeyValue>
            </dl>

            {lead && (
              <div className="border-t border-line px-5 py-4">
                <div className="flex items-baseline justify-between">
                  <SectionLabel>Lead score</SectionLabel>
                  <span className="tabular text-[13px] font-semibold text-ink-900">
                    {lead.score}
                    <span className="text-[11.5px] font-normal text-ink-400">/100</span>
                  </span>
                </div>
                <Meter
                  className="mt-2"
                  value={lead.score}
                  tone={lead.score >= 75 ? 'positive' : lead.score >= 50 ? 'neutral' : 'neutral'}
                />
                <div className="mt-3 flex items-center justify-between">
                  <span className="text-[12px] text-ink-500">Estimated value</span>
                  <span className="tabular text-[13px] font-semibold text-ink-900">
                    {currency(lead.estValue)}
                  </span>
                </div>
              </div>
            )}

            {contact && (
              <div className="border-t border-line px-5 py-4">
                <SectionLabel>Tags</SectionLabel>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {contact.tags.map((tag) => (
                    <Tag key={tag}>{tag}</Tag>
                  ))}
                  <button
                    type="button"
                    className="inline-flex items-center gap-0.5 rounded-[5px] border border-dashed border-line-strong px-1.5 py-[1px] text-[11.5px] font-medium text-ink-400 hover:border-ink-400 hover:text-ink-600"
                  >
                    <Plus size={10} /> Add
                  </button>
                </div>
                <div className="mt-4 flex items-center justify-between">
                  <span className="text-[12px] text-ink-500">Account value</span>
                  <span className="tabular text-[13px] font-semibold text-ink-900">
                    {contact.accountValue > 0 ? currency(contact.accountValue) : '—'}
                  </span>
                </div>
              </div>
            )}
          </Card>

          {colleagues.length > 0 && (
            <Card>
              <CardHeader
                title={`Also at ${record.company}`}
                subtitle={`${colleagues.length} related ${colleagues.length === 1 ? 'contact' : 'contacts'}`}
              />
              <ul className="divide-y divide-line">
                {colleagues.slice(0, 4).map((person) => (
                  <li key={person.id}>
                    <Link
                      to={`/contacts/${person.id}`}
                      className="flex items-center gap-2.5 px-5 py-2.5 transition-colors hover:bg-subtler"
                    >
                      <Avatar name={person.name} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] font-medium text-ink-900">
                          {person.name}
                        </span>
                        <span className="block truncate text-[11.5px] text-ink-400">
                          {person.title}
                        </span>
                      </span>
                      <ExternalLink size={12} className="shrink-0 text-ink-400" />
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        {/* ---------------- Main column ---------------- */}
        <div className="space-y-4">
          {converted && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-positive-line bg-positive-soft px-5 py-3.5 animate-pop-in">
              <CheckCircle2 size={15} className="text-positive" />
              <p className="text-[12.5px] font-medium text-ink-800">
                Lead converted. A deal and a contact record were created.
              </p>
              <div className="ml-auto flex items-center gap-2">
                <Link to="/pipeline">
                  <Button variant="secondary" size="xs">
                    View deal
                  </Button>
                </Link>
                <Link to={`/contacts/${converted.contactId}`}>
                  <Button variant="secondary" size="xs">
                    View contact
                  </Button>
                </Link>
              </div>
            </div>
          )}

          <Card>
            <div className="p-4">
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={`Log a note about ${record.name.split(' ')[0]}… (⌘↵ to save)`}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submitNote()
                }}
              />
              <div className="mt-2.5 flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <Button variant="ghost" size="xs" icon={<Phone size={12} />}>
                    Call
                  </Button>
                  <Button variant="ghost" size="xs" icon={<Mail size={12} />}>
                    Email
                  </Button>
                  <Button variant="ghost" size="xs" icon={<CalendarPlus size={12} />}>
                    Meeting
                  </Button>
                </div>
                <Button variant="primary" size="sm" onClick={submitNote} disabled={!note.trim()}>
                  Log note
                </Button>
              </div>
            </div>
          </Card>

          <Card>
            <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
              <Segmented value={tab} onChange={setTab} options={tabs} />
              <span className="hidden text-[11.5px] text-ink-400 sm:block">
                {openTasks.length > 0
                  ? `${openTasks.length} open ${openTasks.length === 1 ? 'task' : 'tasks'}`
                  : 'No open tasks'}
              </span>
            </div>

            {tab === 'activity' && (
              <div className="px-5 py-4">
                <ActivityTimeline items={timeline} />
              </div>
            )}

            {tab === 'notes' && (
              <div className="px-5 py-4">
                {notes.length === 0 ? (
                  <EmptyState
                    icon={<StickyNote size={16} />}
                    title="No notes yet"
                    description="Use the composer above to capture context from your last conversation."
                  />
                ) : (
                  <ActivityTimeline items={notes} />
                )}
              </div>
            )}

            {tab === 'tasks' && (
              <div>
                <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
                  <Input
                    value={newTask}
                    onChange={(e) => setNewTask(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitTask()
                    }}
                    placeholder="Add a task for this record…"
                    className="h-8"
                  />
                  <Button variant="secondary" size="sm" onClick={submitTask} disabled={!newTask.trim()}>
                    Add
                  </Button>
                </div>
                {recordTasks.length === 0 ? (
                  <EmptyState
                    icon={<CheckCircle2 size={16} />}
                    title="No tasks on this record"
                    description="Add a follow-up so this relationship does not go quiet."
                  />
                ) : (
                  <div className="divide-y divide-line">
                    {sortBy(recordTasks, (t) => (t.done ? 1 : 0)).map((task) => (
                      <TaskRow key={task.id} task={task} showRelated={false} showOwner />
                    ))}
                  </div>
                )}
              </div>
            )}

            {tab === 'deals' && (
              <div>
                {relatedDeals.length === 0 ? (
                  <EmptyState
                    icon={<Coins size={16} />}
                    title="No deals yet"
                    description={
                      lead
                        ? 'Convert this lead to create the first deal for this company.'
                        : 'Create a deal to start tracking revenue for this account.'
                    }
                    action={
                      lead ? (
                        <Button variant="primary" onClick={() => setConvertOpen(true)}>
                          Convert to deal
                        </Button>
                      ) : undefined
                    }
                  />
                ) : (
                  <ul className="divide-y divide-line">
                    {sortBy(relatedDeals, (d) => -d.value).map((deal) => (
                      <li key={deal.id}>
                        <Link
                          to="/pipeline"
                          className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-subtler"
                        >
                          <Building2 size={14} className="shrink-0 text-ink-400" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12.5px] font-medium text-ink-900">
                              {deal.name}
                            </span>
                            <span className="tabular block text-[11.5px] text-ink-400">
                              Closes {formatDate(deal.closeDate)} · {deal.probability}% probability
                            </span>
                          </span>
                          <Badge tone={DEAL_STAGE_TONE[deal.stage]} dot>
                            {DEAL_STAGE_LABEL[deal.stage]}
                          </Badge>
                          <span className="tabular w-[92px] shrink-0 text-right text-[13px] font-semibold text-ink-900">
                            {currency(deal.value)}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Card>
        </div>
      </div>

      {lead && (
        <ConvertModal
          lead={lead}
          open={convertOpen}
          onClose={() => setConvertOpen(false)}
          onConverted={(result) => setConverted(result)}
        />
      )}
    </PageShell>
  )
}

function ConvertModal({
  lead,
  open,
  onClose,
  onConverted,
}: {
  lead: Lead
  open: boolean
  onClose: () => void
  onConverted: (result: { dealId: string | null; contactId: string }) => void
}) {
  const { convertLead, owners } = useCrm()
  const [name, setName] = useState(`${lead.company} — New opportunity`)
  const [value, setValue] = useState(lead.estValue.toLocaleString('en-US'))
  const [stage, setStage] = useState<Deal['stage']>('discovery')
  const [ownerId, setOwnerId] = useState(lead.ownerId)
  const [priority, setPriority] = useState<Priority>('medium')
  const [closeDate, setCloseDate] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() + 30)
    return d.toISOString().slice(0, 10)
  })

  const numericValue = Number(value.replace(/[^0-9]/g, '')) || 0

  const submit = () => {
    const result = convertLead(lead.id, {
      ownerId,
      deal: {
        name: name.trim() || `${lead.company} — New opportunity`,
        value: numericValue,
        stage,
        closeDate: new Date(`${closeDate}T12:00:00`).toISOString(),
        priority,
      },
    })
    onConverted(result)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={560}
      title="Convert to deal"
      description={`Creates a deal and a contact record from ${lead.name}, and marks the lead as qualified.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={numericValue <= 0}>
            Create deal
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3 rounded-panel border border-line bg-subtler px-3.5 py-3">
          <Avatar name={lead.name} size="md" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold text-ink-900">{lead.name}</p>
            <p className="truncate text-[11.5px] text-ink-500">
              {lead.title} · {lead.company}
            </p>
          </div>
          <Badge tone={LEAD_STATUS_TONE[lead.status]} dot>
            {LEAD_STATUS_LABEL[lead.status]}
          </Badge>
        </div>

        <Field label="Deal name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Deal value">
            <div className="relative">
              <span className="absolute top-1/2 left-2.5 -translate-y-1/2 text-[13px] text-ink-400">
                $
              </span>
              <Input
                value={value}
                inputMode="numeric"
                onChange={(e) => {
                  const digits = e.target.value.replace(/[^0-9]/g, '')
                  setValue(digits ? Number(digits).toLocaleString('en-US') : '')
                }}
                className="tabular pl-6"
              />
            </div>
          </Field>
          <Field label="Expected close date">
            <Input type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} />
          </Field>
          <Field label="Starting stage">
            <Select
              value={stage}
              onChange={(e) => setStage(e.target.value as Deal['stage'])}
              className="h-9"
            >
              {(['discovery', 'proposal', 'negotiation', 'contract'] as const).map((s) => (
                <option key={s} value={s}>
                  {DEAL_STAGE_LABEL[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority">
            <Select
              value={priority}
              onChange={(e) => setPriority(e.target.value as Priority)}
              className="h-9"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </Select>
          </Field>
        </div>

        <Field label="Deal owner">
          <Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className="h-9">
            {owners.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} · {o.role}
              </option>
            ))}
          </Select>
        </Field>

        <p className="text-[11.5px] leading-4 text-ink-400">
          The lead stays linked to the new deal so the original source and activity history are
          preserved.
        </p>
      </div>
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

function NotFound({ kind, backTo }: { kind: string; backTo: string }) {
  return (
    <PageShell title={`${kind} not found`} back={backTo}>
      <div className={cn('p-5')}>
        <Card>
          <EmptyState
            title={`This ${kind.toLowerCase()} no longer exists`}
            description="It may have been deleted, merged, or converted into another record."
            action={
              <Link to={backTo}>
                <Button variant="primary">Back to list</Button>
              </Link>
            }
          />
        </Card>
      </div>
    </PageShell>
  )
}
