'use client'

import { useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { Input, Label } from '@/components/ui/Field'
import { Popover, MenuItem } from '@/components/ui/Menu'
import { useCrm } from '@/store/crm'

/**
 * Inline create-or-select company field, shared by the Lead/Contact/Deal create and edit forms.
 * Typing filters the org's existing companies; picking one selects it, and typing a name with no
 * exact (case-insensitive) match offers "Create '<name>'" — which creates the company and selects
 * it in one step, following the same optimistic-create-then-persist pattern as the rest of the
 * store (see addCompany in src/store/crm.tsx).
 */
export function CompanyPicker({
  companyId,
  onChange,
  label = 'Company',
  placeholder = 'Search or create a company…',
}: {
  companyId: string
  onChange: (companyId: string, name: string) => void
  label?: string
  placeholder?: string
}) {
  const { companies, companyById, addCompany } = useCrm()
  const selected = companyById(companyId)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return companies
    return companies.filter((c) => c.name.toLowerCase().includes(q))
  }, [companies, query])

  const exactMatch = companies.some((c) => c.name.toLowerCase() === query.trim().toLowerCase())

  const select = (id: string, name: string, close: () => void) => {
    onChange(id, name)
    setQuery('')
    close()
  }

  const createAndSelect = async (close: () => void) => {
    const name = query.trim()
    if (!name || creating) return
    setCreating(true)
    try {
      const company = await addCompany({ name })
      onChange(company.id, company.name)
      setQuery('')
      close()
    } finally {
      setCreating(false)
    }
  }

  return (
    <div>
      <Label>{label}</Label>
      <Popover
        width={280}
        trigger={({ toggle }) => (
          <button type="button" onClick={toggle} className="block w-full text-left">
            <Input value={selected?.name ?? ''} readOnly placeholder={placeholder} className="cursor-pointer" />
          </button>
        )}
      >
        {({ close }) => (
          <div className="space-y-1">
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search companies…"
              className="h-8"
            />
            <div className="max-h-52 overflow-y-auto">
              {matches.length === 0 && (
                <p className="px-2 py-1.5 text-[12px] text-ink-400">No matching companies.</p>
              )}
              {matches.map((c) => (
                <MenuItem key={c.id} selected={c.id === companyId} onClick={() => select(c.id, c.name, close)}>
                  {c.name}
                </MenuItem>
              ))}
            </div>
            {query.trim() !== '' && !exactMatch && (
              <MenuItem icon={<Plus size={13} />} onClick={() => createAndSelect(close)}>
                {creating ? 'Creating…' : `Create "${query.trim()}"`}
              </MenuItem>
            )}
          </div>
        )}
      </Popover>
    </div>
  )
}
