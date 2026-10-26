'use client'

import { useEffect, useRef, useState } from 'react'
import { Sparkles, RefreshCw, Copy as CopyIcon, Loader2 } from 'lucide-react'
import { Card, CardHeader } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { Textarea } from '@/components/ui/Field'
import { useCrm } from '@/store/crm'
import {
  callAiAssist,
  type AiAssistCapability,
  type AiAssistSubjectType,
  type AiAssistUiState,
} from '@/lib/aiAssistClient'

const DEV_PROVIDER_BADGE = 'Development AI (free tier): use test data only'

const CAPABILITIES: Array<{ value: AiAssistCapability; label: string; editable: boolean }> = [
  { value: 'draft_email', label: 'Draft follow-up email', editable: true },
  { value: 'summarize', label: 'Summarize activity', editable: false },
  { value: 'next_step', label: 'Suggest next step', editable: false },
]

/**
 * Settings -> Team's `aiAssistAvailable` flag (org enabled, allowlisted, both kill switches off,
 * a usable provider in this environment) gates whether this is even rendered — RecordDetail.tsx
 * doesn't render this component at all when it's false, same as the user-facing spec: "the card
 * isn't rendered at all," not rendered-and-disabled.
 *
 * Every button only ever sends `{ capability, subjectType, subjectId }` — never any field of the
 * record itself (the server does its own scoped by-id read and builds the prompt there). Only one
 * request in flight at a time (buttons disabled while `state.status === 'loading'`), no automatic
 * retries, and closing the modal aborts whatever's in flight via the AbortController ref.
 */
export function AiAssistCard({ subjectType, subjectId }: { subjectType: AiAssistSubjectType; subjectId: string }) {
  const { aiAssistProviderKind } = useCrm()
  const [open, setOpen] = useState<AiAssistCapability | null>(null)
  const [state, setState] = useState<AiAssistUiState>({ status: 'idle' })
  const [draft, setDraft] = useState('')
  const controllerRef = useRef<AbortController | null>(null)

  const run = (capability: AiAssistCapability) => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setState({ status: 'loading' })
    callAiAssist(capability, subjectType, subjectId, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setState(result)
      if (result.status === 'success') setDraft(result.text)
    })
  }

  const openCapability = (capability: AiAssistCapability) => {
    setOpen(capability)
    setDraft('')
    run(capability)
  }

  const close = () => {
    controllerRef.current?.abort()
    setOpen(null)
    setState({ status: 'idle' })
    setDraft('')
  }

  // Abort any in-flight request if the component itself unmounts (e.g. navigating away) while a
  // request is still in flight — nothing to update after that, so no state is touched here.
  useEffect(() => () => controllerRef.current?.abort(), [])

  const active = CAPABILITIES.find((c) => c.value === open)

  return (
    <>
      <Card>
        <CardHeader title="AI assist" subtitle="Draft a follow-up, or get a quick summary and next step" />
        <div className="flex flex-col gap-1.5 p-3">
          {aiAssistProviderKind === 'dev' && <Badge tone="warning">{DEV_PROVIDER_BADGE}</Badge>}
          {CAPABILITIES.map((c) => (
            <Button key={c.value} variant="secondary" size="sm" icon={<Sparkles size={13} />} className="justify-start" onClick={() => openCapability(c.value)}>
              {c.label}
            </Button>
          ))}
        </div>
      </Card>

      {active && (
        <Modal
          open
          title={active.label}
          onClose={close}
          width={560}
          footer={<AiAssistModalFooter state={state} draft={draft} onRegenerate={() => run(active.value)} onClose={close} />}
        >
          <AiAssistModalBody state={state} draft={draft} editable={active.editable} onDraftChange={setDraft} providerKind={aiAssistProviderKind} />
        </Modal>
      )}
    </>
  )
}

function AiAssistModalBody({
  state,
  draft,
  editable,
  onDraftChange,
  providerKind,
}: {
  state: AiAssistUiState
  draft: string
  editable: boolean
  onDraftChange: (value: string) => void
  providerKind: 'dev' | 'production' | null
}) {
  if (state.status === 'loading') {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-[12.5px] text-ink-500">
        <Loader2 size={16} className="animate-spin text-ink-400" />
        Generating…
      </div>
    )
  }

  if (state.status === 'cap_reached' || state.status === 'unavailable') {
    return <p className="py-6 text-center text-[12.5px] text-ink-500">{state.message}</p>
  }

  if (state.status === 'network_error') {
    return <p className="py-6 text-center text-[12.5px] text-ink-500">Couldn&apos;t reach AI assist — check your connection and try again.</p>
  }

  // 'success' (and the brief 'idle' frame before the first call resolves)
  const effectiveKind = state.status === 'success' ? state.providerKind : providerKind
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="info">AI-generated draft: review before using</Badge>
        {effectiveKind === 'dev' && <Badge tone="warning">{DEV_PROVIDER_BADGE}</Badge>}
      </div>
      <Textarea
        value={draft}
        onChange={(e) => editable && onDraftChange(e.target.value)}
        readOnly={!editable}
        className="min-h-[160px]"
      />
    </div>
  )
}

function AiAssistModalFooter({
  state,
  draft,
  onRegenerate,
  onClose,
}: {
  state: AiAssistUiState
  draft: string
  onRegenerate: () => void
  onClose: () => void
}) {
  const canAct = state.status === 'success'
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        icon={<CopyIcon size={13} />}
        disabled={!canAct}
        onClick={() => {
          if (canAct) void navigator.clipboard.writeText(draft)
        }}
      >
        Copy
      </Button>
      <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} disabled={state.status === 'loading'} onClick={onRegenerate}>
        Regenerate
      </Button>
      <Button variant="primary" size="sm" onClick={onClose}>
        Close
      </Button>
    </>
  )
}
