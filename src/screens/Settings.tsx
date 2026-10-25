'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from '@/lib/router-compat'
import { Check, Plus, Loader2, TriangleAlert, UserX, X } from 'lucide-react'
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
import { TimezoneSelect } from '@/components/common/TimezoneSelect'
import { useCrm } from '@/store/crm'
import { cn, currencySymbol, formatDate } from '@/lib/utils'
import { CURRENCY_CODES, CURRENCY_LABEL } from '@/data/types'
import { resolveBrowserTimezone } from '@lib/timezones'
import { useOrganization, useUser } from '@clerk/nextjs'
import { inviteMemberAction } from '@lib/actions/crm'
import { getOrgRecordCountsAction, type OrgRecordCounts } from '@lib/actions/import'
import { REP_VISIBILITY_ENABLE_CONFIRM, REP_VISIBILITY_DISABLE_CONFIRM } from '@/components/common/repVisibilityConfirmCopy'

type Section = 'profile' | 'pipeline' | 'team' | 'notifications' | 'data'

const formatQuota = (quota: number | null) => (quota !== null ? quota.toLocaleString('en-US') : '')

export function Settings() {
  const {
    currentUser,
    updateProfile,
    quarterlyQuota,
    updateQuota,
    orgCurrency,
    updateCurrency,
    orgTimezone,
    orgTimezoneConfigured,
    updateOrgTimezone,
    orgName,
    notificationPreferences,
    updateNotificationPreference,
  } = useCrm()
  const [params] = useSearchParams()
  const initialSection = params.get('section')
  const [section, setSection] = useState<Section>(
    initialSection === 'pipeline' || initialSection === 'team' || initialSection === 'notifications' || initialSection === 'data'
      ? initialSection
      : 'profile',
  )
  const [profileName, setProfileName] = useState(currentUser.name)
  // Was never set for this owner — pre-fill with the browser's own resolved zone rather than
  // leaving it blank; a banner below still makes clear this is a suggestion to confirm, not
  // already-saved. Never silently assumed to be UTC.
  const profileTimezoneUnset = !currentUser.timezone
  const [profileTimezone, setProfileTimezone] = useState(currentUser.timezone ?? resolveBrowserTimezone())
  const [quotaInput, setQuotaInput] = useState(formatQuota(quarterlyQuota))
  const [currencyInput, setCurrencyInput] = useState(orgCurrency)
  const [confirmCurrencyOpen, setConfirmCurrencyOpen] = useState(false)
  // Pre-fills with the browser's resolved zone only while no admin has ever configured one yet
  // (orgTimezoneConfigured false) — a real, deliberate choice of UTC is never overwritten on
  // reload. Until this is saved once, org-wide figures elsewhere in the app (Dashboard, Reports,
  // the sidebar) fall back to each viewer's own time zone instead of trusting the raw "UTC"
  // default — see effectiveOrgTimezone/resolveOrgTimezone.
  const [orgTimezoneInput, setOrgTimezoneInput] = useState(
    orgTimezoneConfigured ? orgTimezone : resolveBrowserTimezone(),
  )

  const isAdmin = currentUser.role === 'Admin'
  const profileDirty = profileName.trim() !== currentUser.name || profileTimezone !== (currentUser.timezone ?? resolveBrowserTimezone())
  const quotaDirty = quotaInput !== formatQuota(quarterlyQuota)
  const currencyDirty = currencyInput !== orgCurrency
  const orgTimezoneDirty = orgTimezoneInput !== orgTimezone

  const saveProfile = () => {
    const name = profileName.trim()
    if (!name) return
    updateProfile({ name, timezone: profileTimezone })
  }

  const cancelProfile = () => {
    setProfileName(currentUser.name)
    setProfileTimezone(currentUser.timezone ?? resolveBrowserTimezone())
  }

  const saveOrgTimezone = () => updateOrgTimezone(orgTimezoneInput)
  const cancelOrgTimezone = () =>
    setOrgTimezoneInput(orgTimezoneConfigured ? orgTimezone : resolveBrowserTimezone())

  const saveQuota = () => {
    const digits = quotaInput.replace(/[^0-9]/g, '')
    updateQuota(digits ? Number(digits) : null)
  }

  const cancelQuota = () => setQuotaInput(formatQuota(quarterlyQuota))

  const cancelCurrency = () => setCurrencyInput(orgCurrency)
  const confirmCurrency = () => {
    updateCurrency(currencyInput)
    setConfirmCurrencyOpen(false)
  }

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
            // Admin-only, own org only — see PROGRESS.md's CSV-import entry on why this isn't a
            // cross-org platform view (no such role exists in this app).
            ...(isAdmin ? [{ value: 'data' as const, label: 'Data' }] : []),
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
                    <div className="flex items-center gap-2">
                      <Button variant="secondary" size="sm" disabled>
                        Upload photo
                      </Button>
                      <Tag>Coming soon</Tag>
                    </div>
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
                    <TimezoneSelect value={profileTimezone} onChange={setProfileTimezone} />
                    {profileTimezoneUnset && (
                      <p className="mt-1 text-[11px] text-ink-500">
                        Set from your browser — confirm it or pick a different one, then save.
                      </p>
                    )}
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
                  <Input value={orgName} disabled />
                  <p className="mt-1 text-[11px] text-ink-400">
                    Set from your account provider when the workspace was created.
                  </p>
                </div>
                <div>
                  <Label>Default currency</Label>
                  <div className="flex items-center gap-1.5">
                    <Select
                      value={currencyInput}
                      onChange={(e) => setCurrencyInput(e.target.value)}
                      disabled={!isAdmin}
                      className="h-9 flex-1"
                    >
                      {CURRENCY_CODES.map((code) => (
                        <option key={code} value={code}>
                          {CURRENCY_LABEL[code]}
                        </option>
                      ))}
                    </Select>
                    {currencyDirty && (
                      <>
                        <IconButton
                          label="Save currency"
                          variant="secondary"
                          onClick={() => setConfirmCurrencyOpen(true)}
                        >
                          <Check size={13} />
                        </IconButton>
                        <IconButton label="Cancel" onClick={cancelCurrency}>
                          <X size={13} />
                        </IconButton>
                      </>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-ink-400">
                    {isAdmin
                      ? 'Relabels every amount in the app — it does not convert existing values.'
                      : 'Only admins can change the workspace currency.'}
                  </p>
                </div>
                <div>
                  <Label>Workspace time zone</Label>
                  {isAdmin ? (
                    <>
                      <div className="flex items-center gap-1.5">
                        <TimezoneSelect
                          value={orgTimezoneInput}
                          onChange={setOrgTimezoneInput}
                          className="flex-1"
                        />
                        {orgTimezoneDirty && (
                          <>
                            <IconButton label="Save workspace time zone" variant="secondary" onClick={saveOrgTimezone}>
                              <Check size={13} />
                            </IconButton>
                            <IconButton label="Cancel" onClick={cancelOrgTimezone}>
                              <X size={13} />
                            </IconButton>
                          </>
                        )}
                      </div>
                      {!orgTimezoneConfigured && (
                        <p className="mt-1.5 flex items-start gap-1.5 rounded-[6px] bg-subtle px-2 py-1.5 text-[11.5px] text-ink-600">
                          <TriangleAlert size={13} className="mt-px shrink-0 text-ink-400" />
                          Set your workspace time zone — until you do, won-this-month, quota
                          progress, monthly charts, and closing-in-30-days each fall back to
                          whichever time zone the person looking at them happens to be in, not one
                          shared number for the whole team.
                        </p>
                      )}
                      <p className="mt-1 text-[11px] text-ink-400">
                        Used for org-wide numbers: won this month, quota progress, monthly charts,
                        and closing in 30 days. Your own time zone (above) only affects your task
                        due dates.
                      </p>
                    </>
                  ) : (
                    <>
                      <Input value={orgTimezone} disabled />
                      <p className="mt-1 text-[11px] text-ink-400">Only admins can change the workspace time zone.</p>
                    </>
                  )}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <Label>Fiscal year starts</Label>
                    <Tag>Coming soon</Tag>
                  </div>
                  <Select defaultValue="jan" className="h-9" disabled>
                    <option value="jan">January</option>
                    <option value="apr">April</option>
                    <option value="jul">July</option>
                  </Select>
                  <p className="mt-1 text-[11px] text-ink-400">
                    The Dashboard's quarterly quota currently always uses the calendar quarter
                    (Jan/Apr/Jul/Oct) — this would change that once it's built.
                  </p>
                </div>
                <div>
                  <Label>Quarterly team quota</Label>
                  <div className="flex items-center gap-1.5">
                    <div className="relative flex-1">
                      <span className="absolute top-1/2 left-2.5 -translate-y-1/2 text-[13px] text-ink-400">
                        {currencySymbol(orgCurrency)}
                      </span>
                      <Input
                        value={quotaInput}
                        inputMode="numeric"
                        placeholder="e.g. 1,200,000"
                        disabled={!isAdmin}
                        onChange={(e) => {
                          const digits = e.target.value.replace(/[^0-9]/g, '')
                          setQuotaInput(digits ? Number(digits).toLocaleString('en-US') : '')
                        }}
                        className="tabular pl-10"
                      />
                    </div>
                    {isAdmin && quotaDirty && (
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
                    {isAdmin
                      ? 'Drives the "won this quarter" progress shown on the Dashboard.'
                      : 'Only admins can set the quarterly quota.'}
                  </p>
                </div>
                <RepVisibilitySection />
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
              <div className="flex flex-wrap items-center gap-1.5 px-5 py-4">
                {['Inbound', 'Outbound', 'Referral', 'Event', 'Partner', 'Website'].map((s) => (
                  <Tag key={s}>{s}</Tag>
                ))}
                <button
                  type="button"
                  disabled
                  className="inline-flex cursor-not-allowed items-center gap-0.5 rounded-[5px] border border-dashed border-line px-1.5 py-[1px] text-[11.5px] font-medium text-ink-300"
                >
                  <Plus size={10} /> Add source
                </button>
                <Tag>Coming soon</Tag>
              </div>
            </Card>
          </>
        )}

        {section === 'team' && <TeamSection />}

        {section === 'data' && isAdmin && <RecordCountsSection />}

        {section === 'notifications' && (
          <Card>
            <CardHeader title="Notifications" subtitle="Choose what reaches your inbox" />
            <div className="px-5 py-4">
              <div className="mb-4 flex items-center gap-2 rounded-[8px] bg-subtle px-3 py-2">
                <Tag>In-app only</Tag>
                <p className="text-[12px] text-ink-500">
                  These control the bell at the top of the app. Email delivery isn&apos;t built yet.
                </p>
              </div>
              <SectionLabel>Deals & pipeline</SectionLabel>
              <div className="mt-2 divide-y divide-line">
                <Toggle
                  label="Deal stage changes"
                  description="When a deal you own moves between stages"
                  checked={false}
                  onChange={() => {}}
                  disabled
                  comingSoon
                />
                <Toggle
                  label="Record assigned to me"
                  description="Immediately when a lead, contact, deal, or task is assigned to you"
                  checked={notificationPreferences.assigned}
                  onChange={(v) => updateNotificationPreference('assigned', v)}
                />
              </div>

              <SectionLabel className="mt-5">Activity</SectionLabel>
              <div className="mt-2 divide-y divide-line">
                <Toggle
                  label="Mentions and comments"
                  description="When a teammate @mentions you on a record"
                  checked={false}
                  onChange={() => {}}
                  disabled
                  comingSoon
                />
                <Toggle
                  label="Task due or overdue"
                  description="When a task assigned to you is due today or overdue"
                  checked={notificationPreferences.task_due}
                  onChange={(v) => updateNotificationPreference('task_due', v)}
                />
                <Toggle
                  label="Lead follow-up due"
                  description="When a lead you own has a follow-up date due today or overdue"
                  checked={notificationPreferences.lead_follow_up}
                  onChange={(v) => updateNotificationPreference('lead_follow_up', v)}
                />
                <Toggle
                  label="Daily pipeline digest"
                  description="Summary of pipeline movement from the previous day — needs a sending domain"
                  checked={false}
                  onChange={() => {}}
                  disabled
                />
              </div>
            </div>
          </Card>
        )}
      </div>

      {confirmCurrencyOpen && (
        <Modal
          open
          onClose={() => setConfirmCurrencyOpen(false)}
          width={440}
          title="Change workspace currency?"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmCurrencyOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={confirmCurrency}>
                Change currency
              </Button>
            </>
          }
        >
          <p className="text-[13px] leading-5 text-ink-700">
            Switching to {CURRENCY_LABEL[currencyInput as keyof typeof CURRENCY_LABEL] ?? currencyInput} relabels
            every amount already in the app — it does <strong>not</strong> convert existing values. A deal worth{' '}
            {quarterlyQuota ? quarterlyQuota.toLocaleString('en-US') : '50,000'} will still show the same number,
            just under the new currency.
          </p>
        </Modal>
      )}
    </PageShell>
  )
}

/**
 * Settings -> Workspace, admin-only. The switch itself: "Everyone sees all records" (ALL) vs.
 * "Reps see only their own" (OWN) — see lib/scope.ts for what OWN mode actually restricts.
 * Self-contained (owns its own confirm-modal state) rather than threaded through Settings()'s
 * top-level state, since nothing else in that component needs to know about it.
 */
function RepVisibilitySection() {
  const { currentUser, owners, repVisibility, repVisibilityChangedBy, repVisibilityChangedAt, updateRepVisibility } = useCrm()
  const isAdmin = currentUser.role === 'Admin'
  const [confirmTarget, setConfirmTarget] = useState<'ALL' | 'OWN' | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const copy = confirmTarget === 'OWN' ? REP_VISIBILITY_ENABLE_CONFIRM : REP_VISIBILITY_DISABLE_CONFIRM
  // Not ownerById() — that falls back to currentUser for an unknown id, which would misattribute
  // a change made by someone since removed from the org to whoever's viewing this page now.
  const changedByOwner = repVisibilityChangedBy ? owners.find((o) => o.id === repVisibilityChangedBy) : undefined

  const closeConfirm = () => {
    if (saving) return
    setConfirmTarget(null)
    setError(null)
  }

  const confirm = async () => {
    if (!confirmTarget) return
    setSaving(true)
    setError(null)
    const result = await updateRepVisibility(confirmTarget)
    setSaving(false)
    if (result.ok) {
      setConfirmTarget(null)
    } else {
      setError(result.error)
    }
  }

  return (
    <div>
      <Label>Record visibility</Label>
      {isAdmin ? (
        <Segmented
          value={repVisibility}
          onChange={(next) => {
            if (next !== repVisibility) setConfirmTarget(next)
          }}
          options={[
            { value: 'ALL', label: 'Everyone sees all records' },
            { value: 'OWN', label: 'Reps see only their own' },
          ]}
        />
      ) : (
        <Input value={repVisibility === 'OWN' ? 'Reps see only their own' : 'Everyone sees all records'} disabled />
      )}
      <p className="mt-1 text-[11px] text-ink-400">
        {isAdmin
          ? 'Members with "Reps see only their own" selected can only see leads, contacts, deals, and tasks they own or are assigned.'
          : 'Only admins can change record visibility.'}
        {repVisibilityChangedAt && (
          <>
            {' '}
            Changed by {changedByOwner?.name ?? 'a former member'} on {formatDate(repVisibilityChangedAt)}.
          </>
        )}
      </p>

      {confirmTarget && (
        <Modal
          open
          onClose={closeConfirm}
          width={460}
          title={copy.title}
          footer={
            <>
              <Button variant="ghost" onClick={closeConfirm} disabled={saving}>
                Cancel
              </Button>
              <Button variant="primary" onClick={confirm} disabled={saving}>
                {saving ? 'Saving…' : copy.confirmLabel}
              </Button>
            </>
          }
        >
          <p className="text-[13px] leading-5 text-ink-700">{copy.body}</p>
          {error && <p className="mt-2 text-[12.5px] text-negative">{error}</p>}
        </Modal>
      )}
    </div>
  )
}

const RECORD_LABELS: Record<keyof OrgRecordCounts, string> = {
  leads: 'Leads', contacts: 'Contacts', deals: 'Deals', tasks: 'Tasks', activities: 'Activities', companies: 'Companies',
}

/** Admin-only, own org only — lets an admin see their own org approaching the per-import record
 *  cap (lib/data/import.ts's PER_ORG_RECORD_CAP) before it becomes a surprise mid-import. */
function RecordCountsSection() {
  const [counts, setCounts] = useState<OrgRecordCounts | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getOrgRecordCountsAction().then((result) => {
      if ('ok' in result && result.ok) setCounts(result.counts)
      else setError("Couldn't load record counts.")
    })
  }, [])

  return (
    <Card>
      <CardHeader title="Record counts" subtitle="This workspace's current totals" />
      <div className="p-4">
        {error && <p className="text-[12.5px] text-negative">{error}</p>}
        {!counts && !error && <p className="text-[13px] text-ink-500">Loading…</p>}
        {counts && (
          <TableShell>
            <Thead>
              <Tr>
                <Th>Entity</Th>
                <Th align="right">Count</Th>
              </Tr>
            </Thead>
            <tbody>
              {(Object.keys(RECORD_LABELS) as Array<keyof OrgRecordCounts>).map((key) => (
                <Tr key={key}>
                  <Td>{RECORD_LABELS[key]}</Td>
                  <Td align="right">{counts[key].toLocaleString('en-US')}</Td>
                </Tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </div>
    </Card>
  )
}

function TeamSection() {
  const { user: clerkUser } = useUser()
  const { persist, currentUser } = useCrm()
  // Invite/role-change/remove/revoke are all admin-only — Clerk itself also rejects these for a
  // Member (see PROGRESS.md's Stage 1c follow-up for what that live-browser check confirmed), but
  // a Member should never see controls that would just fail, so they're hidden here too.
  const isAdmin = currentUser.role === 'Admin'
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

  // Goes through a server action (inviteMemberAction) rather than the client SDK's
  // organization.inviteMember() — that client method has no redirectUrl parameter, so without
  // this the invitation's "Accept invitation" link falls back to Clerk's own hosted Account
  // Portal instead of this app's sign-up page. See the comment on inviteMemberAction itself.
  const handleInvite = async () => {
    if (!inviteEmail.trim()) return
    setInviting(true)
    setInviteError(null)
    try {
      const result = await inviteMemberAction({
        emailAddress: inviteEmail.trim(),
        role: inviteRole,
      })
      if (!result.ok) {
        setInviteError('Only admins can invite teammates.')
        return
      }
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
            isAdmin ? (
              <Button
                variant="primary"
                size="xs"
                icon={<Plus size={12} />}
                onClick={() => setInviteOpen(true)}
              >
                Invite
              </Button>
            ) : undefined
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
                    {isAdmin ? (
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
                    ) : (
                      <Badge tone="neutral">{membership.role === 'org:admin' ? 'Admin' : 'Member'}</Badge>
                    )}
                  </Td>
                  <Td align="right">
                    {isAdmin && !isYou && memberId && (
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
                    {isAdmin && (
                      <IconButton
                        label={`Revoke invitation to ${invitation.emailAddress}`}
                        variant="danger"
                        onClick={() => handleRevoke(invitation)}
                      >
                        <UserX size={13} />
                      </IconButton>
                    )}
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
  disabled = false,
  comingSoon = false,
}: {
  label: string
  description: string
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
  /** Same as `disabled`, plus a trailing "Coming soon" label — for a planned-but-unbuilt kind
   *  (Deal stage changes, Mentions and comments), as opposed to a built, live preference. */
  comingSoon?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className={cn('flex items-center gap-1.5 text-[13px] font-medium', disabled ? 'text-ink-400' : 'text-ink-800')}>
          {label}
          {comingSoon && (
            <span className="rounded-[4px] bg-subtle px-1.5 py-[1px] text-[10px] font-medium text-ink-400">
              Coming soon
            </span>
          )}
        </p>
        <p className="mt-0.5 text-[12px] leading-4 text-ink-500">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={disabled ? undefined : () => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-[18px] w-[32px] shrink-0 rounded-full border transition-colors duration-150',
          disabled
            ? 'cursor-not-allowed border-line bg-subtle'
            : checked
              ? 'border-brand-600 bg-brand-600'
              : 'border-line-strong bg-subtle',
        )}
      >
        <span
          className={cn(
            'absolute top-[2px] size-[12px] rounded-full shadow-hairline transition-[left] duration-150',
            disabled ? 'bg-ink-200' : 'bg-white',
            checked ? 'left-[17px]' : 'left-[2px]',
          )}
        />
      </button>
    </div>
  )
}
