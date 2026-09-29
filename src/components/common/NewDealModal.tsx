'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Input, Label, Select } from '@/components/ui/Field'
import { Modal } from '@/components/ui/Modal'
import { useCrm } from '@/store/crm'
import { sortBy } from '@/lib/utils'

export function NewDealModal({
  onClose,
  defaultContactId,
  defaultStageId,
}: {
  onClose: () => void
  defaultContactId?: string
  /** Pre-selects this stage (e.g. from a Pipeline column's "+"); defaults to the first open stage. */
  defaultStageId?: string
}) {
  const { addDeal, owners, contacts, currentUser, stages, stageById } = useCrm()

  const sortedContacts = useMemo(() => sortBy(contacts, (c) => c.name.toLowerCase()), [contacts])
  const initialContact = contacts.find((c) => c.id === defaultContactId)
  const sortedStages = useMemo(() => sortBy(stages, (s) => s.order), [stages])
  const openStages = sortedStages.filter((s) => !s.isClosed)

  const [stageId, setStageId] = useState(defaultStageId ?? openStages[0]?.id ?? sortedStages[0]!.id)
  // Won/Lost aren't normally offered for a new deal, but a column's "+" can pre-select one.
  const stageOptions = defaultStageId && stageById(defaultStageId).isClosed
    ? [...openStages, stageById(defaultStageId)]
    : openStages
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [closeDate, setCloseDate] = useState(() => {
    const d = new Date()
    if (!stageById(stageId).isWon) d.setDate(d.getDate() + 30)
    return d.toISOString().slice(0, 10)
  })
  const [contactId, setContactId] = useState(initialContact?.id ?? '')
  const [company, setCompany] = useState(initialContact?.company ?? '')
  const [companyEdited, setCompanyEdited] = useState(false)
  const [ownerId, setOwnerId] = useState(currentUser.id)

  const numericValue = Number(value.replace(/[^0-9]/g, '')) || 0
  const canSubmit =
    name.trim() !== '' && numericValue > 0 && company.trim() !== '' && closeDate !== ''

  const onContactChange = (id: string) => {
    setContactId(id)
    const contact = contacts.find((c) => c.id === id)
    if (contact && !companyEdited) setCompany(contact.company)
  }

  const submit = () => {
    if (!canSubmit) return
    addDeal({
      name,
      company,
      value: numericValue,
      stageId,
      closeDate: new Date(`${closeDate}T12:00:00`).toISOString(),
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
      title="New deal"
      description="Add an opportunity to your pipeline."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>
            Create deal
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
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme — Annual platform license"
            autoFocus
          />
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
                placeholder="25,000"
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
              {stageOptions.map((s) => (
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
          <Select value={contactId} onChange={(e) => onContactChange(e.target.value)} className="h-9">
            <option value="">No linked contact</option>
            {sortedContacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.company}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Company">
          <Input
            value={company}
            onChange={(e) => {
              setCompany(e.target.value)
              setCompanyEdited(true)
            }}
            placeholder="Acme Inc."
          />
        </Field>
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
