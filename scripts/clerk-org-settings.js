// Reads (and optionally updates) the Clerk instance's organization settings.
//   node scripts/clerk-org-settings.js            -> read current settings
//   node scripts/clerk-org-settings.js --disable-force-selection
//
// `force_organization_selection` makes Clerk mint a `choose-organization`
// session task that must be resolved through Clerk's own task UI. This app
// enforces org membership itself in resolveAuth() + /create-org, so the task
// is a redundant second gate. See PROGRESS.md for why it had to go.
require('dotenv').config()

const KEY = process.env.CLERK_SECRET_KEY
if (!KEY) {
  console.error('CLERK_SECRET_KEY is not set')
  process.exit(1)
}

const BASE = 'https://api.clerk.com/v1/instance/organization_settings'

async function main() {
  const disable = process.argv.includes('--disable-force-selection')

  if (disable) {
    const res = await fetch(BASE, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ force_organization_selection: false }),
    })
    const text = await res.text()
    console.log('PATCH status:', res.status)
    console.log(text)
    return
  }

  const res = await fetch(BASE, {
    headers: { Authorization: `Bearer ${KEY}` },
  })
  const text = await res.text()
  console.log('GET status:', res.status)
  console.log(text)
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
