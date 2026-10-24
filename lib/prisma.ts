import { Prisma, PrismaClient } from '@prisma/client'

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

/**
 * A cold Neon connection (the pooler spinning a compute back up after a scale-to-zero idle
 * period) can take longer than Prisma's 5s default `maxWait`/`timeout` for an interactive
 * `$transaction` — this raises both to a budget that fits comfortably inside a Vercel serverless
 * function's own execution limit, rather than tuning it away implicitly per call site.
 */
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 }

/**
 * Error codes meaning "this never ran to completion" — the connection was never established, was
 * lost mid-flight, or the pool never handed one over at all. None of these can mean "the write
 * committed but the acknowledgment was lost": Postgres aborts an in-flight transaction the moment
 * its connection drops, so there is nothing partially applied to retry into. See
 * https://www.prisma.io/docs/orm/reference/error-reference for each code.
 */
const TRANSIENT_CONNECTION_ERROR_CODES = new Set([
  'P1001', // Can't reach database server
  'P1002', // Database server was reached but timed out
  'P1008', // Operations timed out
  'P1017', // Server has closed the connection
  'P2024', // Timed out fetching a new connection from the pool
])

function isTransientConnectionError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientInitializationError) return true
  return err instanceof Prisma.PrismaClientKnownRequestError && TRANSIENT_CONNECTION_ERROR_CODES.has(err.code)
}

/**
 * Retries `run` exactly once, only for a connection-level failure (see
 * `isTransientConnectionError`) — never for a real validation/business error, which retrying
 * would never fix. Safe for a plain read (no side effect to double up) and, per
 * `withTransaction`'s own doc comment, for a write wrapped in an interactive transaction too.
 */
export async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (!isTransientConnectionError(err)) throw err
    return await run()
  }
}

/**
 * The one place every interactive transaction in lib/data/*.ts should go through, instead of
 * calling `prisma.$transaction` directly — gives every one of them the same explicit
 * maxWait/timeout (see `TRANSACTION_OPTIONS`) and the same one-retry-on-transient-connection-error
 * (see `withRetry`).
 *
 * Retrying a whole transaction this way is safe even for a create, not just an "obviously
 * idempotent" update: a transient connection error means Postgres aborted the transaction before
 * it committed (see `isTransientConnectionError`'s doc comment), so there is no risk of the retry
 * duplicating a write that already landed. The one remaining edge — the write actually committed
 * and only the *acknowledgment* was lost, vanishingly rare but not provably impossible — is
 * already covered for every create in this codebase: they all take a client-generated id (see
 * `assertClientId` in lib/actions/*.ts) and go through `guardAgainstIdCollision`, so a retried
 * create that collides with its own already-committed row surfaces as that same handled "Could
 * not create record" error instead of a silent duplicate.
 */
export function withTransaction<T>(
  run: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return withRetry(() => prisma.$transaction(run, TRANSACTION_OPTIONS))
}
