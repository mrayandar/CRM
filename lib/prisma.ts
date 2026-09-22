import { PrismaClient } from '@prisma/client'

/**
 * Standard Next.js singleton pattern: in dev, Next's module hot-reloading
 * would otherwise create a new PrismaClient (and a new connection pool) on
 * every edit. Stashing the instance on `globalThis` survives HMR reloads.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}
