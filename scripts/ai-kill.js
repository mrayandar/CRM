// The ONLY way to flip the database AI-assist kill flag (platform_settings.ai_kill_switch) —
// deliberately not a route or Server Action, so no session, org membership, or admin role can
// ever change it; see lib/ai/killSwitch.ts and PlatformSetting's schema doc comment. Run locally,
// against whatever DATABASE_URL .env points at.
//
// Exempt from the DB_ROLE=dev guard planned for launch (see PROGRESS.md's pre-launch checklist) —
// that guard exists to stop a script from accidentally running against production; this script's
// entire purpose is to be the one thing that CAN reach production, on purpose, for one command.
//
// Usage (dev, against whatever DATABASE_URL .env already points at):
//   node scripts/ai-kill.js status
//   node scripts/ai-kill.js on
//   node scripts/ai-kill.js off
//
// Usage (production, for exactly one command — see PROGRESS.md for the full procedure):
//   DATABASE_URL="<production connection string, pasted inline, never saved to .env>" node scripts/ai-kill.js on
require('dotenv').config()

const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const KEY = 'ai_kill_switch'

function maskedDbHost() {
  try {
    return new URL(process.env.DATABASE_URL || '').hostname || '(no host in DATABASE_URL)'
  } catch {
    return '(DATABASE_URL is missing or unparseable)'
  }
}

async function main() {
  const command = process.argv[2]
  if (!['status', 'on', 'off'].includes(command)) {
    console.error('Usage: node scripts/ai-kill.js <status|on|off>')
    console.error('For production: DATABASE_URL="<prod connection string>" node scripts/ai-kill.js <status|on|off>')
    process.exit(1)
  }

  // Printed first and always — before the flag changes, and never the full connection string
  // (which carries a password) — so running this against the wrong database is visible
  // immediately, not discovered after the fact.
  console.log(`Database host: ${maskedDbHost()}`)

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
