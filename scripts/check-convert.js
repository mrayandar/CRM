const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
async function main() {
  const contacts = await p.contact.findMany({ select: { id: true, name: true, originLeadId: true }, take: 5 })
  console.log('contacts:', JSON.stringify(contacts, null, 2))
  const deals = await p.deal.findMany({ select: { id: true, name: true, stage: true, value: true }, take: 5 })
  console.log('deals:', JSON.stringify(deals, null, 2))
}
main().catch(e => console.error(e.message)).finally(() => p.$disconnect())
