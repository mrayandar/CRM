const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
p.lead
  .findMany({ select: { id: true, name: true, status: true }, take: 5 })
  .then((leads) => console.log(JSON.stringify(leads, null, 2)))
  .catch((e) => console.error(e.message))
  .finally(() => p.$disconnect())
