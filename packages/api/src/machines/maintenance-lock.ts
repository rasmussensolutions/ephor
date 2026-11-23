import { randomToken, type Sql } from "../auth/store";

// Serialize job claims and maintenance admission on the same row in PostgreSQL
// and D1. Cross-table NOT EXISTS predicates alone can race under PostgreSQL MVCC.
// A crashed request releases the short lease automatically; workers retry polling.
export async function machineClaim<T>(
  sql: Sql,
  machine: string,
  action: () => Promise<T>,
): Promise<T | null> {
  const token = randomToken();
  const now = Date.now();
  const rows = await sql.query(
    "UPDATE ephor_machine SET claim_token=$2,claim_expires=$3 WHERE id=$1 AND state='active' AND claim_expires<=$4 RETURNING id",
    [machine, token, now + 60000, now],
  );
  if (!rows.length) return null;
  try {
    return await action();
  } finally {
    await sql.query(
      "UPDATE ephor_machine SET claim_token=NULL,claim_expires=0 WHERE id=$1 AND claim_token=$2",
      [machine, token],
    );
  }
}
