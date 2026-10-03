import path from 'node:path'
import { PrismaClient } from '@prisma/client'

// The DB location is a project-relative invariant: <project root>/db/custom.db.
// Ignore the platform-injected DATABASE_URL (workspace root) entirely.
const databaseUrl = `file:${path.join(process.cwd(), 'db', 'custom.db')}`

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasourceUrl: databaseUrl,
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
