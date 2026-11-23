import type { Sql } from "../auth/store";

/** Retire the old per-finding backlog without deleting delivery history. */
export async function retireSecurityAlerts(sql: Sql, now: number) {
  await sql.query(
    "INSERT INTO ephor_notification_source (id,processed_at) SELECT 'security-event:' || substr(event_key,10),$1 FROM ephor_notification WHERE event_type='security_finding' AND event_key LIKE 'security:%' AND email_status IN ('sent','skipped','uncertain') ON CONFLICT(id) DO NOTHING",
    [now],
  );
  await sql.query(
    "UPDATE ephor_notification SET read_at=COALESCE(read_at,$1) WHERE event_type='security_finding' AND event_key LIKE 'security:%' AND read_at IS NULL",
    [now],
  );
  // An active provider request cannot be recalled. Never retry an expired legacy lease.
  await sql.query(
    "UPDATE ephor_notification SET email_status=CASE WHEN email_status='sending' THEN 'uncertain' ELSE 'cancelled' END,email_config=NULL,lease_owner=NULL,lease_until=0,error='SECURITY_DIGEST_REPLACED' WHERE event_type='security_finding' AND event_key LIKE 'security:%' AND (email_status='queued' OR (email_status='sending' AND lease_until<=$1))",
    [now],
  );
}
