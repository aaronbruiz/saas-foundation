import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import { rawDb, type Db } from './client.ts'
import { billingAccessGate, userDeletion } from './schema/account.ts'
import { account, member, organization, session, user, verification } from './schema/auth.ts'
import { holdsOwnerRole, listOwners } from './tenancy.ts'
import { ownTransaction } from './tenant-transaction.ts'

const hasPgError = (error: unknown, code: string, constraint?: string) => {
  for (let e = error; e instanceof Object; e = (e as { cause?: unknown }).cause) {
    const found = e as { code?: unknown; constraint?: unknown }
    if (found.code === code && (constraint === undefined || found.constraint === constraint))
      return true
  }
  return false
}

/** The `refuse_deleted_user` trigger's refusal (ADR-0044), through any wrapper's `cause`. */
export const isDeletedAccountViolation = (error: unknown) =>
  hasPgError(error, '23514', 'user_not_deleted')

/** The gate's row can't be written once its user is gone: a refusal, not a fault. */
const GATE_USER_FK = 'billing_access_gate_user_id_user_id_fk'

/** The caller's organizations, for the sole-owner check and the leaves (owned first). */
export async function membershipsOfUser(db: Db, userId: string) {
  const rows = await rawDb(db)
    .select({
      organizationId: member.organizationId,
      name: organization.name,
      role: member.role,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, userId))
  const ownedIds = rows.filter((r) => holdsOwnerRole(r.role)).map((r) => r.organizationId)
  const owners = ownedIds.length
    ? await rawDb(db)
        .select({ organizationId: member.organizationId, role: member.role })
        .from(member)
        .where(inArray(member.organizationId, ownedIds))
    : []
  const ownerCount = (id: string) =>
    owners.filter((o) => o.organizationId === id && holdsOwnerRole(o.role)).length
  return rows
    .map((r) => ({
      organizationId: r.organizationId,
      name: r.name,
      isOwner: holdsOwnerRole(r.role),
      isSoleOwner: holdsOwnerRole(r.role) && ownerCount(r.organizationId) === 1,
    }))
    .sort((a, b) => Number(b.isOwner) - Number(a.isOwner))
}

/**
 * Closes the user's billing access for this deletion attempt (ADR-0044): only with nothing in
 * flight, and exclusive to the attempt, so one can't reopen behind another that's still leaving.
 */
export async function closeBillingAccess(db: Db, userId: string, token: string): Promise<boolean> {
  const gate = billingAccessGate
  const rows = await rawDb(db)
    .insert(gate)
    .values({ userId, closedBy: token })
    .onConflictDoUpdate({
      target: gate.userId,
      set: { closedBy: token },
      where: and(eq(gate.writesInFlight, 0), isNull(gate.closedBy), isNull(gate.deactivatedAt)),
    })
    .returning({ userId: gate.userId })
  return rows.length > 0
}

/** A deletion that stopped reopens the gate, only while it still holds it. */
export async function reopenBillingAccess(db: Db, userId: string, token: string): Promise<void> {
  const gate = billingAccessGate
  await rawDb(db)
    .update(gate)
    .set({ closedBy: null })
    .where(and(eq(gate.userId, userId), eq(gate.closedBy, token), isNull(gate.deactivatedAt)))
}

async function startMemberWrite(db: Db, userId: string): Promise<boolean> {
  const gate = billingAccessGate
  try {
    const rows = await rawDb(db)
      .insert(gate)
      .values({ userId, writesInFlight: 1 })
      .onConflictDoUpdate({
        target: gate.userId,
        set: { writesInFlight: sql`${gate.writesInFlight} + 1` },
        where: and(isNull(gate.closedBy), isNull(gate.deactivatedAt)),
      })
      .returning({ userId: gate.userId })
    return rows.length > 0
  } catch (e) {
    if (hasPgError(e, '23503', GATE_USER_FK)) return false
    throw e
  }
}

async function finishMemberWrite(db: Db, userId: string): Promise<void> {
  const gate = billingAccessGate
  await rawDb(db)
    .update(gate)
    .set({ writesInFlight: sql`${gate.writesInFlight} - 1` })
    .where(and(eq(gate.userId, userId), gt(gate.writesInFlight, 0)))
}

/**
 * Runs `write`, which may put this user into the billing provider, counted on their gate and only
 * if they're still an owner of the organization once counted: authorization from before the gate
 * counts for nothing (ADR-0044). `{ sent: false }`: closed or no longer an owner, nothing was sent.
 * A write whose outcome `outcomeUnknown` says can't be known stays counted, and blocks deleting
 * the account until an operator resolves it.
 */
export async function gatedMemberWrite<T>(
  db: Db,
  orgId: string,
  userId: string,
  write: () => Promise<T>,
  outcomeUnknown: (e: unknown) => boolean,
): Promise<{ sent: true; value: T } | { sent: false }> {
  if (!(await startMemberWrite(db, userId))) return { sent: false }
  const stillOwner = (await listOwners(db, orgId)).some((o) => o.userId === userId)
  if (!stillOwner) {
    await finishMemberWrite(db, userId)
    return { sent: false }
  }
  let value: T
  try {
    value = await write()
  } catch (e) {
    if (!outcomeUnknown(e)) await finishMemberWrite(db, userId)
    throw e
  }
  await finishMemberWrite(db, userId)
  return { sent: true, value }
}

export type DeactivationOutcome = 'deactivated' | 'member-remains' | 'gate-not-held' | 'conflict'

/**
 * Deactivates the account in one transaction (ADR-0044). The user row's lock comes first, and the
 * ledger's row last, so this transaction's own writes pass `refuse_deleted_user`. A deadlock against
 * an in-flight write aborts it whole: `conflict`, and a retry finishes it.
 */
export async function deactivateAccount(
  db: Db,
  userId: string,
  token: string,
): Promise<DeactivationOutcome> {
  try {
    return await ownTransaction<DeactivationOutcome>(db, async (tx) => {
      await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for('update')
      const [remaining] = await tx
        .select({ id: member.id })
        .from(member)
        .where(eq(member.userId, userId))
        .limit(1)
      if (remaining) return 'member-remains'
      const gate = billingAccessGate
      const closed = await tx
        .update(gate)
        .set({ deactivatedAt: sql`now()` })
        .where(
          and(
            eq(gate.userId, userId),
            eq(gate.closedBy, token),
            eq(gate.writesInFlight, 0),
            isNull(gate.deactivatedAt),
          ),
        )
        .returning({ userId: gate.userId })
      if (closed.length === 0) return 'gate-not-held'
      await tx
        .update(user)
        .set({ email: `${userId}@deleted.invalid` })
        .where(eq(user.id, userId))
      await tx
        .update(account)
        .set({ password: null, accessToken: null, refreshToken: null, idToken: null })
        .where(eq(account.userId, userId))
      await tx.delete(session).where(eq(session.userId, userId))
      await tx.delete(verification).where(eq(verification.value, userId))
      await tx.insert(userDeletion).values({ userId })
      return 'deactivated'
    })
  } catch (e) {
    if (hasPgError(e, '40P01')) return 'conflict'
    throw e
  }
}
