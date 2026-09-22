'use client'

import { useState } from 'react'
import { GripVertical, Plus } from 'lucide-react'
import { PageShell } from '@/components/layout/PageShell'
import { Card, CardHeader, SectionLabel } from '@/components/ui/Card'
import { Button, IconButton } from '@/components/ui/Button'
import { Badge, StatusDot, DEAL_STAGE_TONE, Tag } from '@/components/ui/Badge'
import { Avatar } from '@/components/ui/Avatar'
import { Input, Label, Segmented, Select } from '@/components/ui/Field'
import { Td, TableShell, Th, Thead, Tr } from '@/components/ui/Table'
import { useCrm } from '@/store/crm'
import { DEAL_STAGE_LABEL, DEAL_STAGE_ORDER } from '@/data/types'
import { cn } from '@/lib/utils'

type Section = 'profile' | 'pipeline' | 'team' | 'notifications'

export function Settings() {
  const { currentUser, owners } = useCrm()
  const [section, setSection] = useState<Section>('profile')
  const [notifications, setNotifications] = useState({
    dealStage: true,
    mentions: true,
    dailyDigest: false,
    overdueTasks: true,
    leadAssigned: true,
  })

  return (
    <PageShell
      title="Settings"
      subtitle="Workspace, pipeline, and notification preferences"
      toolbar={
        <Segmented
          value={section}
          onChange={setSection}
          options={[
            { value: 'profile', label: 'Profile' },
            { value: 'pipeline', label: 'Pipeline' },
            { value: 'team', label: 'Team' },
            { value: 'notifications', label: 'Notifications' },
          ]}
        />
      }
    >
      <div className="mx-auto max-w-[840px] space-y-4 p-5">
        {section === 'profile' && (
          <>
            <Card>
              <CardHeader title="Your profile" subtitle="Visible to everyone in the workspace" />
              <div className="space-y-4 px-5 py-4">
                <div className="flex items-center gap-4">
                  <Avatar name={currentUser.name} initials={currentUser.initials} size="xl" />
                  <div>
                    <Button variant="secondary" size="sm">
                      Upload photo
                    </Button>
                    <p className="mt-1.5 text-[11.5px] text-ink-400">PNG or JPG, up to 2MB.</p>
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Label>Full name</Label>
                    <Input defaultValue={currentUser.name} />
                  </div>
                  <div>
                    <Label>Role</Label>
                    <Input defaultValue={currentUser.role} />
                  </div>
                  <div>
                    <Label>Email</Label>
                    <Input defaultValue={currentUser.email} />
                  </div>
                  <div>
                    <Label>Time zone</Label>
                    <Select defaultValue="pt" className="h-9">
                      <option value="pt">Pacific Time (US & Canada)</option>
                      <option value="et">Eastern Time (US & Canada)</option>
                      <option value="gmt">London (GMT)</option>
                      <option value="cet">Central European Time</option>
                    </Select>
                  </div>
                </div>
              </div>
              <footer className="flex items-center justify-end gap-2 border-t border-line bg-subtler px-5 py-3">
                <Button variant="ghost">Cancel</Button>
                <Button variant="primary">Save changes</Button>
              </footer>
            </Card>

            <Card>
              <CardHeader title="Workspace" subtitle="Applies to all members of Acme Revenue Team" />
              <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
                <div>
                  <Label>Workspace name</Label>
                  <Input defaultValue="Acme Revenue Team" />
                </div>
                <div>
                  <Label>Default currency</Label>
                  <Select defaultValue="usd" className="h-9">
                    <option value="usd">USD — US Dollar</option>
                    <option value="eur">EUR — Euro</option>
                    <option value="gbp">GBP — British Pound</option>
                  </Select>
                </div>
                <div>
                  <Label>Fiscal year starts</Label>
                  <Select defaultValue="jan" className="h-9">
                    <option value="jan">January</option>
                    <option value="apr">April</option>
                    <option value="jul">July</option>
                  </Select>
                </div>
                <div>
                  <Label>Quarterly team quota</Label>
                  <Input defaultValue="1,200,000" className="tabular" />
                </div>
              </div>
            </Card>
          </>
        )}

        {section === 'pipeline' && (
          <>
            <Card>
              <CardHeader
                title="Deal stages"
                subtitle="Drag to reorder. Probability drives the weighted forecast."
                action={
                  <Button variant="secondary" size="xs" icon={<Plus size={12} />}>
                    Add stage
                  </Button>
                }
              />
              <ul className="divide-y divide-line">
                {DEAL_STAGE_ORDER.map((stage) => (
                  <li
                    key={stage}
                    className="group flex items-center gap-3 px-5 py-3 transition-colors hover:bg-subtler"
                  >
                    <GripVertical size={14} className="shrink-0 cursor-grab text-ink-400/60" />
                    <StatusDot tone={DEAL_STAGE_TONE[stage]} />
                    <span className="min-w-0 flex-1 text-[13px] font-medium text-ink-800">
                      {DEAL_STAGE_LABEL[stage]}
                    </span>
                    {(stage === 'won' || stage === 'lost') && (
                      <Badge tone={stage === 'won' ? 'positive' : 'negative'}>Closed stage</Badge>
                    )}
                    <span className="tabular w-16 text-right text-[12.5px] text-ink-500">
                      {STAGE_PROBABILITY[stage]}%
                    </span>
                    <IconButton
                      label={`Edit ${DEAL_STAGE_LABEL[stage]}`}
                      className="opacity-0 group-hover:opacity-100"
                    >
                      <Plus size={13} className="rotate-45" />
                    </IconButton>
                  </li>
                ))}
              </ul>
            </Card>

            <Card>
              <CardHeader title="Lead sources" subtitle="Used for attribution across reports" />
              <div className="flex flex-wrap gap-1.5 px-5 py-4">
                {['Inbound', 'Outbound', 'Referral', 'Event', 'Partner', 'Website'].map((s) => (
                  <Tag key={s}>{s}</Tag>
                ))}
                <button
                  type="button"
                  className="inline-flex items-center gap-0.5 rounded-[5px] border border-dashed border-line-strong px-1.5 py-[1px] text-[11.5px] font-medium text-ink-400 hover:border-ink-400 hover:text-ink-600"
                >
                  <Plus size={10} /> Add source
                </button>
              </div>
            </Card>
          </>
        )}

        {section === 'team' && (
          <Card className="overflow-hidden">
            <CardHeader
              title="Team members"
              subtitle={`${owners.length} seats in use of 10`}
              action={
                <Button variant="primary" size="xs" icon={<Plus size={12} />}>
                  Invite
                </Button>
              }
            />
            <TableShell className="[&_table]:min-w-[560px]">
              <Thead>
                <Th>Member</Th>
                <Th>Email</Th>
                <Th>Role</Th>
                <Th align="right">Access</Th>
              </Thead>
              <tbody>
                {owners.map((owner, i) => (
                  <Tr key={owner.id}>
                    <Td>
                      <div className="flex items-center gap-2.5">
                        <Avatar name={owner.name} initials={owner.initials} size="md" />
                        <span className="text-[13px] font-medium text-ink-900">{owner.name}</span>
                        {owner.id === currentUser.id && <Badge tone="brand">You</Badge>}
                      </div>
                    </Td>
                    <Td className="text-ink-500">{owner.email}</Td>
                    <Td className="text-ink-600">{owner.role}</Td>
                    <Td align="right">
                      <Badge tone={i === 0 ? 'accent' : 'neutral'}>
                        {i === 0 ? 'Admin' : 'Member'}
                      </Badge>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </TableShell>
          </Card>
        )}

        {section === 'notifications' && (
          <Card>
            <CardHeader title="Notifications" subtitle="Choose what reaches your inbox" />
            <div className="px-5 py-4">
              <SectionLabel>Deals & pipeline</SectionLabel>
              <div className="mt-2 divide-y divide-line">
                <Toggle
                  label="Deal stage changes"
                  description="When a deal you own moves between stages"
                  checked={notifications.dealStage}
                  onChange={(v) => setNotifications((n) => ({ ...n, dealStage: v }))}
                />
                <Toggle
                  label="New lead assigned to me"
                  description="Immediately when routing assigns you a lead"
                  checked={notifications.leadAssigned}
                  onChange={(v) => setNotifications((n) => ({ ...n, leadAssigned: v }))}
                />
              </div>

              <SectionLabel className="mt-5">Activity</SectionLabel>
              <div className="mt-2 divide-y divide-line">
                <Toggle
                  label="Mentions and comments"
                  description="When a teammate @mentions you on a record"
                  checked={notifications.mentions}
                  onChange={(v) => setNotifications((n) => ({ ...n, mentions: v }))}
                />
                <Toggle
                  label="Overdue task reminders"
                  description="A single reminder each morning for overdue work"
                  checked={notifications.overdueTasks}
                  onChange={(v) => setNotifications((n) => ({ ...n, overdueTasks: v }))}
                />
                <Toggle
                  label="Daily pipeline digest"
                  description="Summary of pipeline movement from the previous day"
                  checked={notifications.dailyDigest}
                  onChange={(v) => setNotifications((n) => ({ ...n, dailyDigest: v }))}
                />
              </div>
            </div>
          </Card>
        )}
      </div>
    </PageShell>
  )
}

const STAGE_PROBABILITY: Record<string, number> = {
  discovery: 20,
  proposal: 45,
  negotiation: 65,
  contract: 85,
  won: 100,
  lost: 0,
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-ink-800">{label}</p>
        <p className="mt-0.5 text-[12px] leading-4 text-ink-500">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-[18px] w-[32px] shrink-0 rounded-full border transition-colors duration-150',
          checked ? 'border-brand-600 bg-brand-600' : 'border-line-strong bg-subtle',
        )}
      >
        <span
          className={cn(
            'absolute top-[2px] size-[12px] rounded-full bg-white shadow-hairline transition-[left] duration-150',
            checked ? 'left-[17px]' : 'left-[2px]',
          )}
        />
      </button>
    </div>
  )
}
