// Re-syncs data that mirrors Clerk: Organization.name and Owner.role.
//   node scripts/resync-from-clerk.js           -> dry run: lists mismatches, changes nothing
//   node scripts/resync-from-clerk.js --apply   -> writes the corrections
//
// Clerk is the source of truth. Owner.role is a display string ("Admin" / "Member"); rows created by
// the old on-demand sync in resolveAuth() were always "Member" regardless of the real Clerk role, and
// out-of-order webhook redeliveries could leave a stale organization name. The role mapping below
// mirrors ownerRoleFromClerk() in lib/roles.ts (Clerk sends "org:admin" / "org:member").
require('dotenv').config()
const { PrismaClient } = require('@prisma/client')

const KEY = process.env.CLERK_SECRET_KEY
if (!KEY) {
  console.error('CLERK_SECRET_KEY is not set')
  process.exit(1)
}
const APPLY = process.argv.includes('--apply')
const prisma = new PrismaClient()
const H = { Authorization: `Bearer ${KEY}` }

const ownerRole = (clerkRole) => (clerkRole === 'org:admin' || clerkRole === 'admin' ? 'Admin' : 'Member')

async function clerkGet(path) {
  const res = await fetch(`https://api.clerk.com/v1${path}`, { headers: H })
  if (!res.ok) throw new Error(`Clerk ${res.status}: ${(await res.text()).slice(0, 120)}`)
  return res.json()
}

async function clerkMemberships(clerkOrgId) {
  const out = []
  for (let offset = 0; ; offset += 100) {
    const page = await clerkGet(`/organizations/${clerkOrgId}/memberships?limit=100&offset=${offset}`)
    out.push(...page.data)
    if (out.length >= page.total_count || page.data.length === 0) break
  }
  return out
}

async function main() {
  console.log(APPLY ? 'MODE: APPLY (writing corrections)\n' : 'MODE: dry run (pass --apply to write)\n')
  const orgs = await prisma.organization.findMany({ orderBy: { createdAt: 'asc' } })
  let mismatches = 0
  let fixed = 0

  for (const org of orgs) {
    console.log(`Organization ${org.clerkOrgId}`)
    let clerkOrg
    let members
    try {
      clerkOrg = await clerkGet(`/organizations/${org.clerkOrgId}`)
      members = await clerkMemberships(org.clerkOrgId)
    } catch (err) {
      console.log(`  skipped — could not read from Clerk: ${err.message}\n`)
      continue
    }

    if (clerkOrg.name === org.name) {
      console.log(`  name  ok ("${org.name}")`)
    } else {
      mismatches++
      console.log(`  name  MISMATCH: neon "${org.name}" -> clerk "${clerkOrg.name}"`)
      if (APPLY) {
        await prisma.organization.update({ where: { id: org.id }, data: { name: clerkOrg.name } })
        fixed++
      }
    }

    const roleByUser = new Map(members.map((m) => [m.public_user_data.user_id, m.role]))
    const owners = await prisma.owner.findMany({ where: { orgId: org.id }, orderBy: { createdAt: 'asc' } })
    for (const o of owners) {
      if (!o.clerkUserId) {
        console.log(`  ${o.email.padEnd(40)} ${o.role.padEnd(7)} skipped (no clerkUserId)`)
        continue
      }
      const clerkRole = roleByUser.get(o.clerkUserId)
      if (!clerkRole) {
        console.log(`  ${o.email.padEnd(40)} ${o.role.padEnd(7)} skipped (no longer a Clerk member of this org)`)
        continue
      }
      const want = ownerRole(clerkRole)
      if (want === o.role) {
        console.log(`  ${o.email.padEnd(40)} ${o.role.padEnd(7)} ok (clerk ${clerkRole})`)
        continue
      }
      mismatches++
      console.log(`  ${o.email.padEnd(40)} ${o.role.padEnd(7)} MISMATCH: clerk ${clerkRole} -> should be ${want}`)
      if (APPLY) {
        // Scoped by orgId as well as id, like every other write in the data layer.
        await prisma.owner.updateMany({ where: { id: o.id, orgId: org.id }, data: { role: want } })
        fixed++
      }
    }
    console.log('')
  }
  console.log(`${mismatches} mismatch(es) found${APPLY ? `, ${fixed} corrected` : ' (no changes made)'}.`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
