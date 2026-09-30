'use client'

import { useState } from 'react'
import { Check, Plus, Loader2, UserX, X } from 'lucide-react'
import { PageShell } from '@/components/layout/PageShell'
import { Card, CardHeader, SectionLabel } from '@/components/ui/Card'
import { Button, IconButton } from '@/components/ui/Button'
import { Badge, Tag } from '@/components/ui/Badge'
import { Avatar } from '@/components/ui/Avatar'
import { Input, Label, Segmented, Select } from '@/components/ui/Field'
import { Td, TableShell, Th, Thead, Tr } from '@/components/ui/Table'
import { Modal } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/Display'
import { StageManager } from '@/components/common/StageManager'
import { useCrm } from '@/store/crm'
import { cn, formatDate } from '@/lib/utils'
import { useOrganization, useUser } from '@clerk/nextjs'

type Section = 'profile' | 'pipeline' | 'team' | 'notifications'

const TIMEZONES = [
  { value: 'Pacific Time (US & Canada)', label: 'Pacific Time (US & Canada)' },
  { value: 'Eastern Time (US & Canada)', label: 'Eastern Time (US & Canada)' },
  { value: 'London (GMT)', label: 'London (GMT)' },
  { value: 'Central European Time', label: 'Central European Time' },
]

const formatQuota = (quota: number | null) => (quota !== null ? quota.toLocaleString('en-US') : '')

export function Settings() {
  const { currentUser, updateProfile, quarterlyQuota, updateQuota } = useCrm()
  const [section, setSection] = useState<Section>('profile')
  const [profileName, setProfileName] = useState(currentUser.name)
  const [profileTimezone, setProfileTimezone] = useState(currentUser.timezone ?? TIMEZONES[0]!.value)
  const [quotaInput, setQuotaInput] = useState(formatQuota(quarterlyQuota))

  const profileDirty =
    profileName.trim() !== currentUser.name || profileTimezone !== (currentUser.timezone ?? TIMEZONES[0]!.value)
  const quotaDirty = quotaInput !== formatQuota(quarterlyQuota)

  const saveProfile = () => {
    const name = profileName.trim()
    if (!name) return
    updateProfile({ name, timezone: profileTimezone })
  }

  const cancelProfile = () => {
    setProfileName(currentUser.name)
    setProfileTimezone(currentUser.timezone ?? TIMEZONES[0]!.value)
  }

  const saveQuota = () => {
    const digits = quotaInput.replace(/[^0-9]/g, '')
    updateQuota(digits ? Number(digits) : null)
  }

  const cancelQuota = () => setQuotaInput(formatQuota(quarterlyQuota))

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
                    <Input value={profileName} onChange={(e) => setProfileName(e.target.value)} />
                  </div>
                  <div>
                    <Label>Role</Label>
                    <Input value={currentUser.role} disabled />
                    <p className="mt-1 text-[11px] text-ink-400">Set in Team, under Settings.</p>
                  </div>
                  <div>
                    <Label>Email</Label>
                    <Input value={currentUser.email} disabled />
                    <p className="mt-1 text-[11px] text-ink-400">Managed by your account provider.</p>
                  </div>
                  <div>
                    <Label>Time zone</Label>
                    <Select
                      value={profileTimezone}
                      onChange={(e) => setProfileTimezone(e.target.value)}
                      className="h-9"
                    >
                      {TIMEZONES.map((tz) => (
                        <option key={tz.value} value={tz.value}>
                          {tz.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
              </div>
              <footer className="flex items-center justify-end gap-2 border-t border-line bg-subtler px-5 py-3">
                <Button variant="ghost" onClick={cancelProfile} disabled={!profileDirty}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={saveProfile}
                  disabled={!profileDirty || profileName.trim() === ''}
                >
                  Save changes
                </Button>
              </footer>
            </Card>

            <Card>
              <CardHeader title="Workspace" subtitle="Applies to all members of this organization" />
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
                  <div className="flex items-center gap-1.5">
                    <div className="relative flex-1">
                      <span className="absolute top-1/2 left-2.5 -translate-y-1/2 text-[13px] text-ink-400">
                        $
                      </span>
                      <Input
                        value={quotaInput}
                        inputMode="numeric"
                        placeholder="e.g. 1,200,000"
                        onChange={(e) => {
                          const digits = e.target.value.replace(/[^0-9]/g, '')
                          setQuotaInput(digits ? Number(digits).toLocaleString('en-US') : '')
                        }}
                        className="tabular pl-6"
                      />
                    </div>
                    {quotaDirty && (
                      <>
                        <IconButton label="Save quota" variant="secondary" onClick={saveQuota}>
                          <Check size={13} />
                        </IconButton>
                        <IconButton label="Cancel" onClick={cancelQuota}>
                          <X size={13} />
                        </IconButton>
                      </>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-ink-400">
                    Drives the "won this quarter" progress shown on the Dashboard.
                  </p>
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
                subtitle="Rename, reorder with the arrows, add, or remove a stage. Probability drives the weighted forecast."
              />
              <StageManager />
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

        {section === 'team' && <TeamSection />}

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

function TeamSection() {
  const { user: clerkUser } = useUser()
  const { persist } = useCrm()
  const { organization, memberships, invitations, isLoaded } = useOrganization({
    memberships: { pageSize: 50 },
    invitations: { status: ['pending'], pageSize: 50 },
  })
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'org:admin' | 'org:member'>('org:member')
  const [inviting, setInviting] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<{ userId: string; name: string } | null>(null)

  const memberList = memberships?.data ?? []
  const invitationList = invitations?.data ?? []
  const totalSeats = memberList.length

  const handleInvite = async () => {
    if (!organization || !inviteEmail.trim()) return
    setInviting(true)
    setInviteError(null)
    try {
      await organization.inviteMember({
        emailAddress: inviteEmail.trim(),
        role: inviteRole,
      })
      setInviteOpen(false)
      setInviteEmail('')
      if (invitations?.revalidate) invitations.revalidate()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to send invitation'
      setInviteError(message)
    } finally {
      setInviting(false)
    }
  }

  // Wired into the same persist()/toast pattern every other mutation in the app uses: on
  // failure, the member list is revalidated back to whatever Clerk actually has (nothing was
  // ever mutated locally — the <Select>'s value comes straight from Clerk's own cache — so this
  // is a defensive resync rather than a true rollback) and the admin sees a clear toast instead
  // of silently assuming the change worked.
  const handleRoleChange = (userId: string, newRole: 'org:admin' | 'org:member') => {
    if (!organization) return
    persist(
      async () => {
        await organization.updateMember({ userId, role: newRole })
        await memberships?.revalidate?.()
      },
      () => memberships?.revalidate?.(),
      undefined,
      "Couldn't change that member's role, please try again.",
    )
  }

  const confirmRemove = () => {
    if (!organization || !removeTarget) return
    const { userId } = removeTarget
    setRemoveTarget(null)
    persist(
      async () => {
        await organization.removeMember(userId)
        await memberships?.revalidate?.()
      },
      () => memberships?.revalidate?.(),
      undefined,
      "Couldn't remove that member, please try again.",
    )
  }

  const handleRevoke = (invitation: { revoke: () => Promise<unknown>; emailAddress: string }) => {
    persist(
      async () => {
        await invitation.revoke()
        await invitations?.revalidate?.()
      },
      () => invitations?.revalidate?.(),
      undefined,
      "Couldn't revoke that invitation, please try again.",
    )
  }

  if (!isLoaded) {
    return (
      <Card className="flex items-center justify-center py-12">
        <Loader2 size={20} className="animate-spin text-ink-400" />
      </Card>
    )
  }

  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader
          title="Team members"
          subtitle={`${totalSeats} ${totalSeats === 1 ? 'member' : 'members'} in this organization`}
          action={
            <Button
              variant="primary"
              size="xs"
              icon={<Plus size={12} />}
              onClick={() => setInviteOpen(true)}
            >
              Invite
            </Button>
          }
        />
        <TableShell className="[&_table]:min-w-[560px]">
          <Thead>
            <Th>Member</Th>
            <Th>Email</Th>
            <Th>Role</Th>
            <Th align="right">Actions</Th>
          </Thead>
          <tbody>
            {memberList.map((membership) => {
              const profile = membership.publicUserData
              const firstName = profile?.firstName ?? ''
              const lastName = profile?.lastName ?? ''
              const identifier = profile?.identifier ?? ''
              const memberId = profile?.userId ?? ''
              const name = [firstName, lastName].filter(Boolean).join(' ') || identifier || 'Unknown'
              const email = identifier
              const isYou = memberId === clerkUser?.id

              return (
                <Tr key={membership.id}>
                  <Td>
                    <div className="flex items-center gap-2.5">
                      <Avatar name={name} size="md" />
                      <span className="text-[13px] font-medium text-ink-900">
                        {name}
                      </span>
                      {isYou && <Badge tone="brand">You</Badge>}
                    </div>
                  </Td>
                  <Td className="text-ink-500">{email}</Td>
                  <Td>
                    <Select
                      value={membership.role}
                      onChange={(e) =>
                        handleRoleChange(
                          memberId,
                          e.target.value as 'org:admin' | 'org:member',
                        )
                      }
                      className="h-7 w-[110px] text-[12px]"
                      disabled={isYou}
                    >
                      <option value="org:admin">Admin</option>
                      <option value="org:member">Member</option>
                    </Select>
                  </Td>
                  <Td align="right">
                    {!isYou && memberId && (
                      <IconButton
                        label={`Remove ${name}`}
                        variant="danger"
                        onClick={() => setRemoveTarget({ userId: memberId, name })}
                      >
                        <UserX size={13} />
                      </IconButton>
                    )}
                  </Td>
                </Tr>
              )
            })}
          </tbody>
        </TableShell>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title="Pending invitations"
          subtitle={`${invitationList.length} outstanding`}
        />
        {invitationList.length === 0 ? (
          <EmptyState
            title="No pending invitations"
            description="Invites you send will show up here until they're accepted or revoked."
          />
        ) : (
          <TableShell>
            <Thead>
              <Th>Email</Th>
              <Th>Role</Th>
              <Th>Sent</Th>
              <Th align="right">Actions</Th>
            </Thead>
            <tbody>
              {invitationList.map((invitation) => (
                <Tr key={invitation.id}>
                  <Td className="text-[13px] font-medium text-ink-900">{invitation.emailAddress}</Td>
                  <Td>
                    <Badge tone="neutral">{invitation.role === 'org:admin' ? 'Admin' : 'Member'}</Badge>
                  </Td>
                  <Td className="text-ink-500">{formatDate(invitation.createdAt.toISOString())}</Td>
                  <Td align="right">
                    <IconButton
                      label={`Revoke invitation to ${invitation.emailAddress}`}
                      variant="danger"
                      onClick={() => handleRevoke(invitation)}
                    >
                      <UserX size={13} />
                    </IconButton>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>

      <Modal
        open={inviteOpen}
        onClose={() => {
          setInviteOpen(false)
          setInviteError(null)
        }}
        width={440}
        title="Invite a team member"
        description="They'll receive an email invitation to join your organization."
        footer={
          <>
            <Button variant="ghost" onClick={() => setInviteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleInvite}
              disabled={!inviteEmail.trim() || inviting}
            >
              {inviting ? 'Sending…' : 'Send invite'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <Label>Email address</Label>
            <Input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="colleague@company.com"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleInvite()
              }}
            />
          </div>
          <div>
            <Label>Role</Label>
            <Select
              value={inviteRole}
              onChange={(e) =>
                setInviteRole(e.target.value as 'org:admin' | 'org:member')
              }
              className="h-9"
            >
              <option value="org:member">Member</option>
              <option value="org:admin">Admin</option>
            </Select>
          </div>
          {inviteError && (
            <p className="text-[12.5px] text-negative">{inviteError}</p>
          )}
        </div>
      </Modal>

      <Modal
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        width={420}
        title="Remove team member"
        description={
          removeTarget
            ? `Remove ${removeTarget.name} from the organization? They'll lose access immediately.`
            : ''
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoveTarget(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmRemove}>
              Remove
            </Button>
          </>
        }
      >
        <></>
      </Modal>
    </>
  )
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
