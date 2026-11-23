import { AuthError, type Sql } from "../auth/store";
import { type ServiceDomains, serviceDomains } from "./spec";

export async function reserveDomains(
  sql: Sql,
  serviceId: string,
  value: unknown,
) {
  const domains = serviceDomains(value),
    names = [domains.primary, ...domains.aliases].filter(
      (s): s is string => !!s,
    );
  for (const name of names) {
    const [existing] = await sql.query<{ service_id: string }>(
      "SELECT service_id FROM ephor_service_domain WHERE hostname=$1",
      [name],
    );
    if (existing && existing.service_id !== serviceId)
      throw new AuthError("DOMAIN_IN_USE", 409);
  }
  // Unique hostname reservation is the concurrency boundary. Never steal a live route.
  for (const name of names) {
    await sql.query(
      "INSERT INTO ephor_service_domain (hostname,service_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [name, serviceId],
    );
    const [row] = await sql.query<{ service_id: string }>(
      "SELECT service_id FROM ephor_service_domain WHERE hostname=$1",
      [name],
    );
    if (row?.service_id !== serviceId)
      throw new AuthError("DOMAIN_IN_USE", 409);
  }
  await sql.query("UPDATE ephor_service SET domain=$1,domains=$2 WHERE id=$3", [
    domains.primary,
    JSON.stringify(domains),
    serviceId,
  ]);
  return domains;
}
export function readDomains(row: {
  domains?: string | null;
  domain: string | null;
}): ServiceDomains {
  return row.domains
    ? serviceDomains(JSON.parse(row.domains))
    : { primary: row.domain, aliases: [], redirect: false };
}
// Resolve through a fixed HTTPS endpoint; never fetch a user-controlled URL from the panel.
export async function dnsRecords(
  hostname: string,
  request: typeof fetch = fetch,
) {
  const records = await Promise.all(
    ["A", "AAAA"].map(async (type) => {
      const response = await request(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
        {
          headers: { Accept: "application/dns-json" },
          redirect: "manual",
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!response.ok) throw new AuthError("DNS_LOOKUP_FAILED", 502);
      const result = (await response.json()) as {
        Status: number;
        Answer?: { type: number; data: string }[];
      };
      if (![0, 3].includes(result.Status))
        throw new AuthError("DNS_LOOKUP_FAILED", 502);
      return (result.Answer ?? [])
        .filter((r) => r.type === 1 || r.type === 28)
        .map((r) => ({ type: r.type === 1 ? "A" : "AAAA", value: r.data }));
    }),
  );
  return records.flat();
}
