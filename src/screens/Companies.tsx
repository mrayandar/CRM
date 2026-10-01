'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from '@/lib/router-compat'
import { Building2, Plus } from 'lucide-react'
import { PageShell } from '@/components/layout/PageShell'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { CompanyMark } from '@/components/ui/Avatar'
import { Input, Label, SearchInput, Textarea } from '@/components/ui/Field'
import { Modal } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/Display'
import { Td, TableShell, Th, Thead, Tr } from '@/components/ui/Table'
import { useCrm } from '@/store/crm'
import { sortBy } from '@/lib/utils'

export function Companies() {
  const navigate = useNavigate()
  const { companies, leads, contacts, deals } = useCrm()
  const [query, setQuery] = useState('')
  const [newCompanyOpen, setNewCompanyOpen] = useState(false)

  const countsFor = (companyId: string) => ({
    leads: leads.filter((l) => l.companyId === companyId).length,
    contacts: contacts.filter((c) => c.companyId === companyId).length,
    deals: deals.filter((d) => d.companyId === companyId).length,
  })

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows = companies.map((c) => ({ company: c, ...countsFor(c.id) }))
    if (!q) return rows
    return rows.filter(({ company }) =>
      `${company.name} ${company.industry ?? ''} ${company.website ?? ''}`.toLowerCase().includes(q),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companies, leads, contacts, deals, query])

  const sorted = sortBy(filtered, ({ company }) => company.name.toLowerCase())

  return (
    <PageShell
      title="Companies"
      subtitle={`${companies.length} ${companies.length === 1 ? 'company' : 'companies'}`}
      actions={
        <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setNewCompanyOpen(true)}>
          New company
        </Button>
      }
      toolbar={
        <SearchInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search companies by name, industry, website…"
          className="w-full sm:w-[320px]"
        />
      }
    >
      <div className="mx-auto max-w-[1440px] p-5">
        <Card className="overflow-hidden">
          {sorted.length === 0 ? (
            <EmptyState
              icon={<Building2 size={16} />}
              title={companies.length === 0 ? 'No companies yet' : 'No companies match this search'}
              description={
                companies.length === 0
                  ? 'Companies are created automatically when you add one to a Lead, Contact, or Deal — or create one directly here.'
                  : 'Try a different search term.'
              }
            />
          ) : (
            <TableShell>
              <Thead>
                <Th>Company</Th>
                <Th>Industry</Th>
                <Th>Website</Th>
                <Th align="right">Leads</Th>
                <Th align="right">Contacts</Th>
                <Th align="right">Deals</Th>
              </Thead>
              <tbody>
                {sorted.map(({ company, leads: leadCount, contacts: contactCount, deals: dealCount }) => (
                  <Tr key={company.id} onClick={() => navigate(`/companies/${company.id}`)}>
                    <Td>
                      <div className="flex items-center gap-2.5">
                        <CompanyMark name={company.name} />
                        <span className="truncate text-[13px] font-medium text-ink-900">{company.name}</span>
                      </div>
                    </Td>
                    <Td>
                      <span className="text-ink-600">{company.industry || '—'}</span>
                    </Td>
                    <Td>
                      <span className="truncate text-ink-600">{company.website || '—'}</span>
                    </Td>
                    <Td align="right">
                      <span className="tabular">{leadCount}</span>
                    </Td>
                    <Td align="right">
                      <span className="tabular">{contactCount}</span>
                    </Td>
                    <Td align="right">
                      <span className="tabular">{dealCount}</span>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </TableShell>
          )}
        </Card>
      </div>

      {newCompanyOpen && (
        <NewCompanyModal onClose={() => setNewCompanyOpen(false)} onCreated={(id) => navigate(`/companies/${id}`)} />
      )}
    </PageShell>
  )
}

function NewCompanyModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { addCompany } = useCrm()
  const [name, setName] = useState('')
  const [website, setWebsite] = useState('')
  const [industry, setIndustry] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSubmit = name.trim() !== '' && !saving

  const submit = async () => {
    if (!canSubmit) return
    setSaving(true)
    setError(null)
    try {
      const company = await addCompany({ name, website, industry, notes })
      onCreated(company.id)
      onClose()
    } catch {
      setError('Could not save the company. Please try again.')
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={saving ? () => {} : onClose}
      width={480}
      title="New company"
      description="Add a company directly, independent of any Lead, Contact, or Deal."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>
            {saving ? 'Creating…' : 'Create company'}
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
        <Field label="Company name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Inc." autoFocus />
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
