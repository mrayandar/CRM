'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useParams } from '@/lib/router-compat'
import { Building2, Pencil, Trash2, UserPlus, Users, Columns3 } from 'lucide-react'
import { PageShell } from '@/components/layout/PageShell'
import { Card, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge, LEAD_STATUS_TONE, stageTone } from '@/components/ui/Badge'
import { Avatar, CompanyMark } from '@/components/ui/Avatar'
import { EmptyState, KeyValue } from '@/components/ui/Display'
import { Input, Label, Textarea } from '@/components/ui/Field'
import { Modal } from '@/components/ui/Modal'
import { Link, useNavigate } from '@/lib/router-compat'
import { useCrm } from '@/store/crm'
import { LEAD_STATUS_LABEL } from '@/data/types'
import { currency, formatDate, sortBy } from '@/lib/utils'

export function CompanyDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { companies, leads, contacts, deals, stages, ownerById, stageById, updateCompany, deleteCompany } = useCrm()
  const company = companies.find((c) => c.id === id)

  const [editOpen, setEditOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  if (!company) return <NotFound />

  const companyLeads = sortBy(leads.filter((l) => l.companyId === company.id), (l) => l.name)
  const companyContacts = sortBy(contacts.filter((c) => c.companyId === company.id), (c) => c.name)
  const companyDeals = sortBy(deals.filter((d) => d.companyId === company.id), (d) => -d.value)

  const confirmDelete = async () => {
    setDeleting(true)
    setDeleteError(null)
    const result = await deleteCompany(company.id)
    if (result.ok) {
      navigate('/companies')
    } else {
      setDeleteError(result.error)
      setDeleting(false)
    }
  }

  return (
    <PageShell
      back="/companies"
      eyebrow="Company"
      title={company.name}
      subtitle={[company.industry, company.website].filter(Boolean).join(' · ') || undefined}
      actions={
        <>
          <Button variant="secondary" size="sm" icon={<Pencil size={14} />} onClick={() => setEditOpen(true)}>
            Edit
          </Button>
          <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={() => setDeleteOpen(true)}>
            Delete
          </Button>
        </>
      }
    >
      <div className="mx-auto grid max-w-[1440px] items-start gap-4 p-5 lg:grid-cols-[340px_minmax(0,1fr)]">
        {/* ---------------- Profile panel ---------------- */}
        <div className="space-y-4 lg:sticky lg:top-5">
          <Card className="overflow-hidden">
            <div className="flex flex-col items-start gap-3 px-5 pt-5 pb-4">
              <CompanyMark name={company.name} size="lg" />
              <div>
                <h2 className="text-[17px] leading-6 font-semibold tracking-[-0.02em] text-ink-900">
                  {company.name}
                </h2>
                {company.industry && <p className="mt-0.5 text-[12.5px] text-ink-500">{company.industry}</p>}
              </div>
            </div>

            <dl className="border-t border-line px-5 py-3">
              <KeyValue label="Website">
                {company.website ? (
                  <a
                    href={company.website.startsWith('http') ? company.website : `https://${company.website}`}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate text-brand-700 hover:underline"
                  >
                    {company.website}
                  </a>
                ) : (
                  <span className="text-ink-400">—</span>
                )}
              </KeyValue>
              <KeyValue label="Industry">
                <span>{company.industry || <span className="text-ink-400">—</span>}</span>
              </KeyValue>
              <KeyValue label="Created">
                <span>{formatDate(company.createdAt)}</span>
              </KeyValue>
            </dl>

            {company.notes && (
              <div className="border-t border-line px-5 py-3">
                <p className="text-[12px] leading-5 whitespace-pre-wrap text-ink-600">{company.notes}</p>
              </div>
            )}
          </Card>
        </div>

        {/* ---------------- Rollups ---------------- */}
        <div className="space-y-4">
          <Card className="overflow-hidden">
            <CardHeader
              title="Leads"
              subtitle={`${companyLeads.length} ${companyLeads.length === 1 ? 'lead' : 'leads'}`}
            />
            {companyLeads.length === 0 ? (
              <EmptyState icon={<UserPlus size={15} />} title="No leads at this company yet" />
            ) : (
              <ul className="divide-y divide-line">
                {companyLeads.map((lead) => (
                  <li key={lead.id}>
                    <Link
                      to={`/leads/${lead.id}`}
                      className="flex items-center gap-2.5 px-5 py-2.5 hover:bg-subtler"
                    >
                      <Avatar name={lead.name} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-ink-900">{lead.name}</p>
                        <p className="truncate text-[11.5px] text-ink-400">{lead.title}</p>
                      </div>
                      <Badge tone={LEAD_STATUS_TONE[lead.status]}>{LEAD_STATUS_LABEL[lead.status]}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader
              title="Contacts"
              subtitle={`${companyContacts.length} ${companyContacts.length === 1 ? 'contact' : 'contacts'}`}
            />
            {companyContacts.length === 0 ? (
              <EmptyState icon={<Users size={15} />} title="No contacts at this company yet" />
            ) : (
              <ul className="divide-y divide-line">
                {companyContacts.map((contact) => (
                  <li key={contact.id}>
                    <Link
                      to={`/contacts/${contact.id}`}
                      className="flex items-center gap-2.5 px-5 py-2.5 hover:bg-subtler"
                    >
                      <Avatar name={contact.name} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-ink-900">{contact.name}</p>
                        <p className="truncate text-[11.5px] text-ink-400">{contact.title}</p>
                      </div>
                      <span className="shrink-0 text-[11.5px] text-ink-500">{ownerById(contact.ownerId).name}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader
              title="Deals"
              subtitle={`${companyDeals.length} ${companyDeals.length === 1 ? 'deal' : 'deals'}`}
            />
            {companyDeals.length === 0 ? (
              <EmptyState icon={<Columns3 size={15} />} title="No deals at this company yet" />
            ) : (
              <ul className="divide-y divide-line">
                {companyDeals.map((deal) => {
                  const stage = stageById(deal.stageId)
                  return (
                    <li key={deal.id}>
                      <div className="flex items-center gap-2.5 px-5 py-2.5">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium text-ink-900">{deal.name}</p>
                          <p className="truncate text-[11.5px] text-ink-400">{currency(deal.value)}</p>
                        </div>
                        <Badge tone={stageTone(stage, stages.filter((s) => !s.isClosed))}>{stage.label}</Badge>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {editOpen && (
        <EditCompanyModal
          company={company}
          onClose={() => setEditOpen(false)}
          updateCompany={updateCompany}
        />
      )}

      {deleteOpen && (
        <Modal
          open
          onClose={() => {
            setDeleteOpen(false)
            setDeleteError(null)
          }}
          width={420}
          title="Delete company"
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleteOpen(false)} disabled={deleting}>
                Cancel
              </Button>
              <Button variant="danger" onClick={confirmDelete} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Delete'}
              </Button>
            </>
          }
        >
          <p className="text-[13px] leading-5 text-ink-700">
            Delete &quot;{company.name}&quot;? This can&apos;t be undone.
          </p>
          {deleteError && <p className="mt-2 text-[12px] leading-5 text-negative">{deleteError}</p>}
        </Modal>
      )}
    </PageShell>
  )
}

function EditCompanyModal({
  company,
  onClose,
  updateCompany,
}: {
  company: { id: string; name: string; website?: string; industry?: string; notes?: string }
  onClose: () => void
  updateCompany: (id: string, input: { name: string; website?: string; industry?: string; notes?: string }) => void
}) {
  const [name, setName] = useState(company.name)
  const [website, setWebsite] = useState(company.website ?? '')
  const [industry, setIndustry] = useState(company.industry ?? '')
  const [notes, setNotes] = useState(company.notes ?? '')

  useEffect(() => {
    setName(company.name)
    setWebsite(company.website ?? '')
    setIndustry(company.industry ?? '')
    setNotes(company.notes ?? '')
  }, [company])

  const canSubmit = name.trim() !== ''

  const submit = () => {
    if (!canSubmit) return
    updateCompany(company.id, { name, website, industry, notes })
    onClose()
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={480}
      title="Edit company"
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
        <Field label="Company name">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Website">
            <Input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="acme.com" />
          </Field>
          <Field label="Industry">
            <Input value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="Software" />
          </Field>
        </div>
        <Field label="Notes">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes…" />
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

function NotFound() {
  return (
    <PageShell back="/companies" title="Company not found">
      <div className="flex h-full items-center justify-center p-10">
        <EmptyState
          icon={<Building2 size={16} />}
          title="This company doesn't exist"
          description="It may have been deleted, or the link is wrong."
        />
      </div>
    </PageShell>
  )
}
