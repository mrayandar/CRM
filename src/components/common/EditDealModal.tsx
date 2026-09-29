'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Input, Label, Select } from '@/components/ui/Field'
import { Modal } from '@/components/ui/Modal'
import { useCrm } from '@/store/crm'
import type { Deal } from '@/data/types'
import { sortBy } from '@/lib/utils'

export function EditDealModal({ deal, onClose }: { deal: Deal; onClose: () => void }) {
  const { updateDeal, owners, contacts, stages, stageById } = useCrm()

  const sortedContacts = useMemo(() => sortBy(contacts, (c) => c.name.toLowerCase()), [contacts])
  const sortedStages = useMemo(() => sortBy(stages, (s) => s.order), [stages])

  const [name, setName] = useState(deal.name)
  const [value, setValue] = useState(deal.value.toLocaleString('en-US'))
  const [stageId, setStageId] = useState(deal.stageId)
  const [closeDate, setCloseDate] = useState(deal.closeDate.slice(0, 10))
  const [contactId, setContactId] = useState(deal.contactId ?? '')
  const [ownerId, setOwnerId] = useState(deal.ownerId)

  // Re-seed from the deal whenever it changes underneath the modal (e.g. revalidated in the
  // background), not on every render, so it doesn't clobber an in-progress edit.
  useEffect(() => {
    setName(deal.name)
    setValue(deal.value.toLocaleString('en-US'))
    setStageId(deal.stageId)
    setCloseDate(deal.closeDate.slice(0, 10))
    setContactId(deal.contactId ?? '')
    setOwnerId(deal.ownerId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deal.id])

  const numericValue = Number(value.replace(/[^0-9]/g, '')) || 0
  const canSubmit = name.trim() !== '' && numericValue > 0 && closeDate !== ''
  const enteringWon = stageById(stageId).isWon && !stageById(deal.stageId).isWon

  const submit = () => {
    if (!canSubmit) return
    // The <input type=date> only has day precision. If the user never touched it, resubmit the
    // deal's original closeDate exactly as stored (which may carry a precise time — e.g. the moment
    // a previous stage move stamped it) rather than reconstructing a coarser "noon on that day"
    // value that would look like an unintended change. Only a value the user actually edited gets
    // rebuilt from the date-only input, same as every other date field in this app.
    const dateTouched = closeDate !== deal.closeDate.slice(0, 10)
    updateDeal(deal.id, {
      name,
      value: numericValue,
      stageId,
      closeDate: dateTouched ? new Date(`${closeDate}T12:00:00`).toISOString() : deal.closeDate,
      ownerId,
      contactId: contactId || undefined,
    })
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={560}
      title="Edit deal"
      description="Update this opportunity's details."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>
            Save changes
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <Field label="Deal name">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
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
          <Field label="Stage">
            <Select
              value={stageId}
              onChange={(e) => setStageId(e.target.value)}
              className="h-9"
            >
              {sortedStages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Owner">
            <Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className="h-9">
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} · {o.role}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Linked contact">
          <Select value={contactId} onChange={(e) => setContactId(e.target.value)} className="h-9">
            <option value="">No linked contact</option>
            {sortedContacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.company}
              </option>
            ))}
          </Select>
        </Field>

        {enteringWon && (
          <p className="text-[11.5px] leading-4 text-ink-400">
            Moving this deal to {stageById(stageId).label} will set its close date to today.
          </p>
        )}
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
