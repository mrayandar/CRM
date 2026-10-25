// Read-only, cross-org record counts for the app operator — the thing the Settings → Data tab
// can't show, since that's deliberately per-org-admin, own-org-only (no platform-operator role
// exists in this app's Clerk/DB model; see PROGRESS.md's CSV-import entry). Run locally, against
// whatever DATABASE_URL .env points at — never exposed as a route or action.
//
// Usage: node scripts/org-counts.js [--sort=leads|contacts|deals|tasks|activities|companies]
require('dotenv').config()

const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const CAP = { leads: 5000, contacts: 5000 } // mirrors lib/data/import.ts's PER_ORG_RECORD_CAP

async function main() {
  const sortArg = process.argv.find((a) => a.startsWith('--sort='))
  const sortKey = sortArg ? sortArg.split('=')[1] : 'leads'

  const orgs = await prisma.organization.findMany({ orderBy: { name: 'asc' } })

  const rows = await Promise.all(
    orgs.map(async (org) => {
      const [leads, contacts, deals, tasks, activities, companies] = await Promise.all([
        prisma.lead.count({ where: { orgId: org.id } }),
        prisma.contact.count({ where: { orgId: org.id } }),
        prisma.deal.count({ where: { orgId: org.id } }),
        prisma.task.count({ where: { orgId: org.id } }),
        prisma.activity.count({ where: { orgId: org.id } }),
        prisma.company.count({ where: { orgId: org.id } }),
      ])
      // `id` is the internal Organization.id (cuid) — what AI_ASSIST_ALLOWED_ORG_IDS takes, NOT
      // clerkOrgId. See lib/ai/allowlist.ts.
      return { org: org.name, id: org.id, clerkOrgId: org.clerkOrgId, leads, contacts, deals, tasks, activities, companies }
    }),
  )

  rows.sort((a, b) => (b[sortKey] ?? 0) - (a[sortKey] ?? 0))

  const flagged = rows.filter((r) => r.leads > CAP.leads * 0.8 || r.contacts > CAP.contacts * 0.8)
  if (flagged.length > 0) {
    console.log(`\n⚠ ${flagged.length} org(s) above 80% of the ${CAP.leads.toLocaleString()}-record import cap:`)
    for (const r of flagged) console.log(`  - ${r.org}: ${r.leads} leads, ${r.contacts} contacts`)
  }

  console.log('')
  console.table(rows)

  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error(err)
  await prisma.$disconnect()
  process.exit(1)
})
