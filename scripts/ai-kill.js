// The ONLY way to flip the database AI-assist kill flag (platform_settings.ai_kill_switch) —
// deliberately not a route or Server Action, so no session, org membership, or admin role can
// ever change it; see lib/ai/killSwitch.ts and PlatformSetting's schema doc comment. Run locally,
// against whatever DATABASE_URL .env points at.
//
// Usage:
//   node scripts/ai-kill.js status
//   node scripts/ai-kill.js on
//   node scripts/ai-kill.js off
require('dotenv').config()

const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const KEY = 'ai_kill_switch'

async function main() {
  const command = process.argv[2]
  if (!['status', 'on', 'off'].includes(command)) {
    console.error('Usage: node scripts/ai-kill.js <status|on|off>')
    process.exit(1)
  }

  if (command === 'status') {
    const row = await prisma.platformSetting.findUnique({ where: { key: KEY } })
    console.log(`AI assist kill switch: ${row?.value === 'true' ? 'ON (blocking all AI-assist requests)' : 'off'}`)
    return
  }

  const value = command === 'on' ? 'true' : 'false'
  await prisma.platformSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value },
    update: { value },
  })
  console.log(`AI assist kill switch set to: ${command === 'on' ? 'ON (blocking all AI-assist requests)' : 'off'}`)
}

main()
  .catch(async (err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
