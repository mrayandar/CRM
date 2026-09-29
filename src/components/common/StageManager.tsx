'use client'

import { useState } from 'react'
import { ArrowDown, ArrowUp, Check, Plus, Trash2, X } from 'lucide-react'
import { Badge, StatusDot, stageTone } from '@/components/ui/Badge'
import { IconButton } from '@/components/ui/Button'
import { Input } from '@/components/ui/Field'
import { useCrm } from '@/store/crm'
import { sortBy } from '@/lib/utils'

/**
 * Rename, reorder (up/down), add, and safe-delete pipeline stages. Used both inline in Settings →
 * Pipeline and inside the Pipeline page's "Customize stages" modal — one implementation, so the
 * two entry points can never drift apart.
 */
export function StageManager() {
  const { stages, addStage, renameStage, moveStage, deleteStage } = useCrm()
  const sorted = sortBy(stages, (s) => s.order)
  const openStages = sorted.filter((s) => !s.isClosed)

  const [newLabel, setNewLabel] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingLabel, setEditingLabel] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<{ id: string; message: string } | null>(null)

  const startEdit = (id: string, label: string) => {
    setEditingId(id)
    setEditingLabel(label)
  }

  const commitEdit = () => {
    if (!editingId) return
    const label = editingLabel.trim()
    if (label) renameStage(editingId, label)
    setEditingId(null)
  }

  const submitAdd = () => {
    const label = newLabel.trim()
    if (!label) return
    addStage(label)
    setNewLabel('')
  }

  const confirmDelete = async (id: string) => {
    setDeleteError(null)
    const result = await deleteStage(id)
    if (!result.ok) {
      setDeleteError({ id, message: result.error })
      setConfirmDeleteId(null)
      return
    }
    setConfirmDeleteId(null)
  }

  return (
    <div>
      <ul className="divide-y divide-line">
        {sorted.map((stage) => {
          const openIndex = openStages.findIndex((s) => s.id === stage.id)
          const isOpen = !stage.isClosed
          return (
            <li key={stage.id} className="group flex items-center gap-3 px-5 py-3">
              {isOpen ? (
                <div className="flex shrink-0 flex-col">
                  <IconButton
                    label={`Move ${stage.label} up`}
                    className="size-5"
                    disabled={openIndex <= 0}
                    onClick={() => moveStage(stage.id, 'up')}
                  >
                    <ArrowUp size={11} />
                  </IconButton>
                  <IconButton
                    label={`Move ${stage.label} down`}
                    className="size-5"
                    disabled={openIndex === -1 || openIndex >= openStages.length - 1}
                    onClick={() => moveStage(stage.id, 'down')}
                  >
                    <ArrowDown size={11} />
                  </IconButton>
                </div>
              ) : (
                <div className="w-5 shrink-0" />
              )}

              <StatusDot tone={stageTone(stage, openStages)} />

              {editingId === stage.id ? (
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <Input
                    autoFocus
                    value={editingLabel}
                    onChange={(e) => setEditingLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitEdit()
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                    className="h-7 text-[13px]"
                  />
                  <IconButton label="Save name" className="size-6" onClick={commitEdit}>
                    <Check size={12} />
                  </IconButton>
                  <IconButton label="Cancel" className="size-6" onClick={() => setEditingId(null)}>
                    <X size={12} />
                  </IconButton>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => startEdit(stage.id, stage.label)}
                  className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-ink-800 hover:text-ink-900"
                  title="Click to rename"
                >
                  {stage.label}
                </button>
              )}

              {stage.isClosed && (
                <Badge tone={stage.isWon ? 'positive' : 'negative'}>
                  {stage.isWon ? 'Won' : 'Lost'}
                </Badge>
              )}

              <span className="tabular w-12 shrink-0 text-right text-[12.5px] text-ink-500">
                {stage.probability}%
              </span>

              {isOpen && confirmDeleteId === stage.id ? (
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="text-[11.5px] text-ink-500">Delete?</span>
                  <IconButton label="Confirm delete" variant="danger" className="size-6" onClick={() => confirmDelete(stage.id)}>
                    <Check size={12} />
                  </IconButton>
                  <IconButton label="Cancel delete" className="size-6" onClick={() => setConfirmDeleteId(null)}>
                    <X size={12} />
                  </IconButton>
                </div>
              ) : (
                isOpen && (
                  <IconButton
                    label={`Delete ${stage.label}`}
                    variant="ghost"
                    className="size-6 shrink-0 opacity-0 group-hover:opacity-100"
                    onClick={() => {
                      setDeleteError(null)
                      setConfirmDeleteId(stage.id)
                    }}
                  >
                    <Trash2 size={12} />
                  </IconButton>
                )
              )}

              {deleteError?.id === stage.id && (
                <p className="w-full basis-full pl-8 text-[11.5px] text-negative">{deleteError.message}</p>
              )}
            </li>
          )
        })}
      </ul>

      <div className="flex items-center gap-2 border-t border-line px-5 py-3">
        <Input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitAdd()
          }}
          placeholder="New stage name…"
          className="h-8 flex-1"
        />
        <IconButton label="Add stage" variant="secondary" onClick={submitAdd} disabled={!newLabel.trim()}>
          <Plus size={14} />
        </IconButton>
      </div>
    </div>
  )
}
