'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Label, Select } from '@/components/ui/Field'
import { useCrm } from '@/store/crm'
import { exportCsv } from '@/lib/utils'
import { undoImportBatchAction } from '@lib/actions/import'

type EntityType = 'lead' | 'contact'
type ImportField = 'name' | 'email' | 'phone' | 'company' | 'source' | 'status' | 'title' | 'notes' | 'owner'

const FIELD_LABELS: Record<ImportField, string> = {
  name: 'Name', email: 'Email', phone: 'Phone', company: 'Company',
  source: 'Source', status: 'Status', title: 'Title', notes: 'Notes', owner: 'Owner (email)',
}
const LEAD_FIELDS: ImportField[] = ['name', 'email', 'phone', 'company', 'source', 'status', 'notes', 'owner']
const CONTACT_FIELDS: ImportField[] = ['name', 'email', 'phone', 'company', 'title', 'notes', 'owner']

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_ROWS = 2000
const CHUNK_SIZE = 10

type Mapping = Record<number, ImportField | null>
type DuplicateStrategy = 'skip' | 'update' | 'create'

interface ParsedFile {
  headers: string[]
  rows: string[][]
  encodingFallback: 'windows-1252' | null
}

interface ValidatedRow {
  rowNumber: number
  errors: string[]
  fields: Record<string, { raw: string; value: string; defaulted: boolean }>
  resolvedCompany: { id: string | null; name: string; existing: boolean } | null
  resolvedOwner: { id: string; name: string } | { unknownEmail: string } | null
  duplicate: { editable: true; recordId: string; name: string } | { editable: false } | null
}

interface CommitResult {
  rowNumber: number
  outcome: 'created' | 'updated' | 'skipped' | 'failed'
  recordId?: string
  error?: string
  defaultedFields?: Array<'source' | 'status'>
}

type Step = 'upload' | 'mapping' | 'preview' | 'committing' | 'done'

export function ImportWizard({
  entityType,
  open,
  onClose,
}: {
  entityType: EntityType
  open: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const { currentUser } = useCrm()
  const isAdmin = currentUser.role === 'Admin'
  const fields = entityType === 'lead' ? LEAD_FIELDS : CONTACT_FIELDS
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [step, setStep] = useState<Step>('upload')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [parsed, setParsed] = useState<ParsedFile | null>(null)
  const [mapping, setMapping] = useState<Mapping>({})
  const [validated, setValidated] = useState<ValidatedRow[] | null>(null)
  const [duplicateStrategy, setDuplicateStrategy] = useState<DuplicateStrategy>('skip')
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [results, setResults] = useState<CommitResult[]>([])
  const [batchId, setBatchId] = useState<string | null>(null)
  const [undoResult, setUndoResult] = useState<{ removed: number; kept: number } | string | null>(null)

  function reset() {
    setStep('upload')
    setError(null)
    setParsed(null)
    setMapping({})
    setValidated(null)
    setDuplicateStrategy('skip')
    setProgress({ done: 0, total: 0 })
    setResults([])
    setBatchId(null)
    setUndoResult(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function handleClose() {
    reset()
    onClose()
    if (step === 'done') router.refresh()
  }

  async function handleFile(file: File) {
    setError(null)
    if (file.size > MAX_FILE_BYTES) {
      setError('File exceeds the 2MB limit.')
      return
    }
    setBusy(true)
    try {
      const form = new FormData()
      form.append('entityType', entityType)
      form.append('file', file)
      const response = await fetch('/api/import/parse', { method: 'POST', body: form })
      const body = await response.json()
      if (!response.ok) {
        setError(body.error ?? 'Could not read this file.')
        return
      }
      if (body.rows.length === 0) {
        setError('This file has no data rows.')
        return
      }
      setParsed({ headers: body.headers, rows: body.rows, encodingFallback: body.encodingFallback })
      setMapping(body.suggestedMapping)
      setStep('mapping')
    } catch {
      setError('Could not reach the server. Try again.')
    } finally {
      setBusy(false)
    }
  }

  async function runValidate() {
    if (!parsed) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/import/validate', {
        method: 'POST',
        body: JSON.stringify({ entityType, rows: parsed.rows, mapping }),
      })
      const body = await response.json()
      if (!response.ok) {
        setError(body.error ?? 'Could not validate this file.')
        return
      }
      setValidated(body.rows)
      setStep('preview')
    } catch {
      setError('Could not reach the server. Try again.')
    } finally {
      setBusy(false)
    }
  }

  async function runCommit() {
    if (!parsed || !validated) return
    setBusy(true)
    setError(null)
    setStep('committing')
    try {
      const batchResponse = await fetch('/api/import/batches', {
        method: 'POST',
        body: JSON.stringify({ entityType, totalRows: parsed.rows.length }),
      })
      const batchBody = await batchResponse.json()
      if (!batchResponse.ok) {
        setError(batchBody.error ?? 'Could not start this import.')
        setStep('preview')
        return
      }
      const newBatchId = batchBody.batchId as string
      setBatchId(newBatchId)

      const rowInputs = parsed.rows.map((cells, i) => ({ rowNumber: i + 1, id: crypto.randomUUID(), cells }))
      const allResults: CommitResult[] = []
      for (let i = 0; i < rowInputs.length; i += CHUNK_SIZE) {
        const chunk = rowInputs.slice(i, i + CHUNK_SIZE)
        const isFinalChunk = i + CHUNK_SIZE >= rowInputs.length
        const response = await fetch('/api/import/commit', {
          method: 'POST',
          body: JSON.stringify({ batchId: newBatchId, entityType, mapping, duplicateStrategy, rows: chunk, isFinalChunk }),
        })
        const body = await response.json()
        if (!response.ok) {
          setError(body.error ?? 'Import stopped partway through — see results below for what completed.')
          break
        }
        allResults.push(...body.results)
        setProgress({ done: allResults.length, total: rowInputs.length })
        setResults([...allResults])
      }
      setStep('done')
    } catch {
      setError('Could not reach the server partway through — see results below for what completed.')
      setStep('done')
    } finally {
      setBusy(false)
    }
  }

  function downloadErrorReport() {
    if (!parsed) return
    const failedOrSkipped = results.filter((r) => r.outcome === 'failed' || r.outcome === 'skipped')
    exportCsv(
      `${entityType}-import-report.csv`,
      failedOrSkipped.map((r) => ({
        row: r.rowNumber,
        outcome: r.outcome,
        reason: r.error ?? '',
        ...Object.fromEntries(parsed.headers.map((h, i) => [h, parsed.rows[r.rowNumber - 1]?.[i] ?? ''])),
      })),
    )
  }

  async function handleUndo() {
    if (!batchId) return
    setBusy(true)
    try {
      const result = await undoImportBatchAction(batchId)
      if ('ok' in result && result.ok) setUndoResult({ removed: result.removed, kept: result.kept })
      else setUndoResult('error' in result ? result.error : 'forbidden')
    } finally {
      setBusy(false)
    }
  }

  const summary = results.reduce(
    (acc, r) => {
      acc[r.outcome]++
      return acc
    },
    { created: 0, updated: 0, skipped: 0, failed: 0 },
  )

  return (
    <Modal open={open} onClose={busy ? () => {} : handleClose} width={640} title={`Import ${entityType === 'lead' ? 'leads' : 'contacts'}`}>
      {error && <p className="mb-3 text-[12.5px] text-negative">{error}</p>}

      {step === 'upload' && (
        <div className="space-y-3">
          <p className="text-[13px] text-ink-600">
            Upload a CSV file — up to {MAX_ROWS.toLocaleString()} rows and 2MB. UTF-8, semicolon-delimited, and
            quoted multi-line fields are all handled automatically.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void handleFile(file)
            }}
            className="block w-full text-[13px]"
          />
        </div>
      )}

      {step === 'mapping' && parsed && (
        <div className="space-y-3">
          {parsed.encodingFallback && (
            <p className="rounded-control border border-line-strong bg-subtle p-2.5 text-[12px] text-ink-600">
              This file wasn&apos;t valid UTF-8 — read as Windows-1252 (common for Excel exports). Check names with
              accented characters look right.
            </p>
          )}
          <p className="text-[13px] text-ink-600">Map each column to a field, or leave it unmapped to ignore it.</p>
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {parsed.headers.map((header, index) => (
              <div key={index} className="grid grid-cols-2 items-center gap-2">
                <Label htmlFor={`mapping-${index}`}>{header}</Label>
                <Select
                  id={`mapping-${index}`}
                  value={mapping[index] ?? ''}
                  onChange={(e) =>
                    setMapping((m) => ({ ...m, [index]: (e.target.value || null) as ImportField | null }))
                  }
                >
                  <option value="">Don&apos;t import</option>
                  {fields
                    .filter((f) => f !== 'owner' || isAdmin)
                    .map((f) => (
                      <option key={f} value={f}>
                        {FIELD_LABELS[f]}
                      </option>
                    ))}
                </Select>
              </div>
            ))}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setStep('upload')} disabled={busy}>
              Back
            </Button>
            <Button variant="primary" onClick={runValidate} disabled={busy}>
              {busy ? 'Checking…' : 'Preview'}
            </Button>
          </div>
        </div>
      )}

      {step === 'preview' && validated && (
        <div className="space-y-3">
          {(() => {
            const withErrors = validated.filter((r) => r.errors.length > 0).length
            const duplicatesEditable = validated.filter((r) => r.duplicate?.editable).length
            const duplicatesHidden = validated.filter((r) => r.duplicate && !r.duplicate.editable).length
            const newCompanies = new Set(
              validated.filter((r) => r.resolvedCompany && !r.resolvedCompany.existing).map((r) => r.resolvedCompany!.name),
            ).size
            return (
              <p className="text-[13px] text-ink-600">
                {validated.length} rows · {withErrors} with errors · {duplicatesEditable} match an existing record ·{' '}
                {duplicatesHidden} skipped (already exists, outside your visibility) · {newCompanies} new companies.
              </p>
            )
          })()}

          <div>
            <Label htmlFor="duplicate-strategy">Duplicate emails</Label>
            <Select
              id="duplicate-strategy"
              value={duplicateStrategy}
              onChange={(e) => setDuplicateStrategy(e.target.value as DuplicateStrategy)}
            >
              <option value="skip">Skip (default) — leave the existing record untouched</option>
              <option value="update">Update — refresh the existing record&apos;s fields</option>
              <option value="create">Create anyway — allow a second record with this email</option>
            </Select>
          </div>

          <div className="max-h-65 overflow-auto rounded-control border border-line-strong">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-subtle">
                <tr>
                  <th className="px-2 py-1.5 text-left">Row</th>
                  <th className="px-2 py-1.5 text-left">Name</th>
                  <th className="px-2 py-1.5 text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {validated.slice(0, 50).map((r) => (
                  <tr key={r.rowNumber} className="border-t border-line">
                    <td className="px-2 py-1.5">{r.rowNumber}</td>
                    <td className="px-2 py-1.5">{r.fields.name?.value}</td>
                    <td className="px-2 py-1.5">
                      {r.errors.length > 0 ? (
                        <span className="text-negative">{r.errors.join('; ')}</span>
                      ) : r.duplicate && !r.duplicate.editable ? (
                        <span className="text-ink-500">Will be skipped (already exists)</span>
                      ) : r.duplicate?.editable ? (
                        <span className="text-ink-500">Matches &quot;{r.duplicate.name}&quot;</span>
                      ) : (
                        <span className="text-positive">Ready</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {validated.length > 50 && (
            <p className="text-[12px] text-ink-500">Showing the first 50 of {validated.length} rows.</p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setStep('mapping')} disabled={busy}>
              Back
            </Button>
            <Button variant="primary" onClick={runCommit} disabled={busy}>
              Confirm import
            </Button>
          </div>
        </div>
      )}

      {step === 'committing' && (
        <div className="space-y-3">
          <p className="text-[13px] text-ink-600">
            Importing {progress.done} of {progress.total}…
          </p>
          <div className="h-2 w-full overflow-hidden rounded-full bg-subtle">
            <div
              className="h-full bg-brand-600 transition-[width]"
              style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
            />
          </div>
          <p className="text-[12px] text-ink-500">This can take a while for larger files — keep this tab open.</p>
        </div>
      )}

      {step === 'done' && (
        <div className="space-y-3">
          <p className="text-[13px] text-ink-900">
            {summary.created} created · {summary.updated} updated · {summary.skipped} skipped · {summary.failed} failed.
          </p>
          {(summary.failed > 0 || summary.skipped > 0) && (
            <Button variant="secondary" size="sm" onClick={downloadErrorReport}>
              Download report
            </Button>
          )}
          {isAdmin && batchId && !undoResult && (
            <Button variant="secondary" size="sm" onClick={handleUndo} disabled={busy}>
              Undo this import
            </Button>
          )}
          {undoResult && (
            <p className="text-[12.5px] text-ink-600">
              {typeof undoResult === 'string' ? undoResult : `Removed ${undoResult.removed}, kept ${undoResult.kept}.`}
            </p>
          )}
          <div className="flex justify-end pt-2">
            <Button variant="primary" onClick={handleClose}>
              Done
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
