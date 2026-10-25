import type { Db } from '../db/sqlite.js'
export type AuditEvent =
  | 'agent.registered' | 'agent.profile_updated' | 'agent.policy_changed'
  | 'token.created' | 'token.revoked' | 'auth.failed'
  | 'message.sent'
  | 'task.created' | 'task.accepted' | 'task.rejected' | 'task.result' | 'task.cancelled' | 'task.timeout' | 'task.expired'
  | 'task.policy_violation' | 'task.reviewed' | 'ratelimit.exceeded'
  | 'task.budget_agreed' | 'task.budget_settled' | 'task.budget_voided'
  | 'webhook.failed'
  | 'market.admin_delisting' | 'market.select' | 'market.accept_bid' | 'market.buy'
  | 'market.deliver' | 'market.accept' | 'market.cancel'
  | 'market.listing_expired' | 'market.bid_expired' | 'market.auto_accept'
  | 'identity.claimed' | 'identity.bound' | 'identity.rotated' | 'identity.claim_failed'
  | 'file.uploaded' | 'file.downloaded' | 'file.upload_aborted' | 'file.upload_failed'
  | 'group.created' | 'group.renamed' | 'group.member_added' | 'group.member_removed' | 'group.dissolved' | 'group.message_sent'
  | 'regcode.applied' | 'regcode.verified' | 'regcode.issued' | 'regcode.mail_failed' | 'regcode.revoked'

export function audit(db: Db, actor: string, event: AuditEvent, detail: Record<string, unknown>): void {
  db.prepare('INSERT INTO audit_log (actor, event, detail, created_at) VALUES (?,?,?,?)')
    .run(actor, event, JSON.stringify(detail), new Date().toISOString())
}
