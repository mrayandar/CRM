'use client'

import { useRef, useState } from 'react'
import { useUser } from '@clerk/nextjs'
import { ImagePlus, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Avatar } from '@/components/ui/Avatar'
import { useCrm } from '@/store/crm'
import { validateAvatarFile } from '@/lib/avatarValidation'

/**
 * Settings -> Profile. Uploads/removes the signed-in user's photo through Clerk's own client SDK
 * (`user.setProfileImage`) — this app never stores or serves the image itself. After Clerk's call
 * succeeds, `syncAvatar()` (src/store/crm.tsx) calls `syncMyAvatarAction`, which re-reads the
 * CURRENT image state from Clerk's Backend API and writes it to `Owner.avatarUrl` — never a URL
 * this component itself constructs or passes along.
 */
export function AvatarUploader() {
  const { currentUser, syncAvatar } = useCrm()
  const { user } = useUser()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const afterClerkCall = async () => {
    const result = await syncAvatar()
    if (!result.ok) setError(result.error)
  }

  const handleFile = async (file: File) => {
    const validationError = validateAvatarFile(file)
    if (validationError) {
      setError(validationError)
      return
    }
    if (!user) return
    setBusy(true)
    setError(null)
    try {
      await user.setProfileImage({ file })
      await afterClerkCall()
    } catch {
      setError("Couldn't upload your photo, please try again.")
    } finally {
      setBusy(false)
    }
  }

  const removePhoto = async () => {
    if (!user) return
    setBusy(true)
    setError(null)
    try {
      await user.setProfileImage({ file: null })
      await afterClerkCall()
    } catch {
      setError("Couldn't remove your photo, please try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-4">
      <Avatar name={currentUser.name} initials={currentUser.initials} avatarUrl={currentUser.avatarUrl} size="xl" />
      <div>
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void handleFile(file)
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            icon={busy ? <Loader2 size={13} className="animate-spin" /> : <ImagePlus size={13} />}
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            Upload photo
          </Button>
          {currentUser.avatarUrl && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void removePhoto()}>
              Remove photo
            </Button>
          )}
        </div>
        <p className="mt-1.5 text-[11.5px] text-ink-400">PNG, JPEG, or WEBP, up to 5 MB.</p>
        {error && <p className="mt-1 text-[11.5px] text-red-600">{error}</p>}
      </div>
    </div>
  )
}
