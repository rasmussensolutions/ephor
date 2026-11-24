import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { z } from "zod";
import { AuthError, type Sql } from "../auth/store";
import { dnsRecords } from "../services/domains";
import { publicProbeAddress } from "../services/https-check";

export function metadataUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.port ||
    url.pathname === "/" ||
    isIP(url.hostname) ||
    url.hostname.includes(":") ||
    !url.hostname.includes(".")
  )
    throw new AuthError("INVALID_CLIENT_METADATA");
  return url;
}
export const clientId = z
  .string()
  .max(2048)
  .refine((value) => {
    if (z.string().uuid().safeParse(value).success) return true;
    try {
      metadataUrl(value);
      return true;
    } catch {
      return false;
    }
  });
export function validRedirect(value: string) {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
const metadata = z.object({
  client_id: z.string(),
  client_name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .refine((v) => !/\p{Cc}/u.test(v)),
  redirect_uris: z
    .array(z.string().max(2048).refine(validRedirect))
    .min(1)
    .max(20),
  token_endpoint_auth_method: z.string().optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

function cacheAge(cache: string, age: string) {
  return /no-store|no-cache/i.test(cache)
    ? 0
    : Math.max(
        0,
        Math.min(
          3600,
          Number(/max-age=(\d+)/i.exec(cache)?.[1] ?? 300) - (Number(age) || 0),
        ),
      );
}

/** Resolve once, reject mixed private/public DNS, and pin the HTTPS connection.
 * Redirects are never followed; no ambient cookies, authorization or proxy are used.
 */
export async function fetchClientMetadata(
  value: string,
  worker = false,
  resolve = dnsRecords,
  request: typeof fetch = fetch,
): Promise<{ body: unknown; maxAge: number }> {
  const url = metadataUrl(value);
  const records = await resolve(url.hostname);
  if (
    !records.length ||
    records.some((record) => !publicProbeAddress(record.value))
  )
    throw new AuthError("INVALID_CLIENT_METADATA");
  // Workers HTTPS is implemented on fetch and cannot pin TLS servername to an
  // IP. Use its public Internet transport (never a VPC/service binding). Node
  // and Bun instead pin the validated address to protect the panel host's LAN.
  // Workers fetch has no ambient cookie jar; pass only the explicit Accept header.
  if (worker) {
    const response = await request(value, {
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
      headers: { Accept: "application/json" },
    });
    if (
      response.status !== 200 ||
      !/^application\/(?:[\w.-]+\+)?json\b/i.test(
        response.headers.get("content-type") ?? "",
      ) ||
      !response.body
    )
      throw new AuthError("INVALID_CLIENT_METADATA");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        size += chunk.length;
        if (size > 32768) throw new AuthError("INVALID_CLIENT_METADATA");
        chunks.push(chunk);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return {
      body: JSON.parse(new TextDecoder().decode(bytes)),
      maxAge: cacheAge(
        response.headers.get("cache-control") ?? "",
        response.headers.get("age") ?? "0",
      ),
    };
  }
  const address =
    records.find((r) => isIP(r.value) === 4)?.value ?? records[0]?.value;
  if (!address) throw new AuthError("INVALID_CLIENT_METADATA");
  return new Promise((resolve, reject) => {
    const fail = () => new AuthError("INVALID_CLIENT_METADATA");
    const req = httpsRequest(
      {
        hostname: address,
        family: isIP(address),
        servername: url.hostname,
        port: 443,
        path: url.pathname,
        method: "GET",
        agent: false,
        rejectUnauthorized: true,
        headers: {
          Host: url.hostname,
          Accept: "application/json",
          "Accept-Encoding": "identity",
        },
      },
      (res) => {
        if (
          res.statusCode !== 200 ||
          !/^application\/(?:[\w.-]+\+)?json\b/i.test(
            String(res.headers["content-type"]),
          )
        ) {
          res.destroy();
          reject(fail());
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 32768) {
            req.destroy(fail());
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const cache = String(res.headers["cache-control"] ?? "");
            const maxAge = cacheAge(cache, String(res.headers.age ?? "0"));
            resolve({
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
              maxAge,
            });
          } catch {
            reject(fail());
          }
        });
      },
    );
    const timer = setTimeout(() => req.destroy(fail()), 5000);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end();
  });
}

export async function resolveClient(
  sql: Sql,
  value: string,
  load = fetchClientMetadata,
) {
  const [existing] = await sql.query<{
    name: string;
    redirects: string;
    metadata_expires_at: number;
  }>(
    "SELECT name,redirects,metadata_expires_at FROM ephor_mcp_client WHERE id=$1",
    [value],
  );
  if (!value.startsWith("https:")) return existing;
  metadataUrl(value);
  if (existing && Number(existing.metadata_expires_at) > Date.now())
    return existing;
  const fetched = await load(value);
  const parsed = metadata.safeParse(fetched.body);
  if (!parsed.success) throw new AuthError("INVALID_CLIENT_METADATA");
  const document = parsed.data;
  const methods = document.token_endpoint_auth_methods_supported ?? [
    document.token_endpoint_auth_method ?? "none",
  ];
  if (
    document.client_id !== value ||
    !methods.includes("none") ||
    (document.grant_types &&
      !document.grant_types.includes("authorization_code")) ||
    (document.response_types && !document.response_types.includes("code"))
  )
    throw new AuthError("INVALID_CLIENT_METADATA");
  const redirects = JSON.stringify(document.redirect_uris);
  const expires = Date.now() + fetched.maxAge * 1000;
  await sql.query(
    "INSERT INTO ephor_mcp_client(id,name,redirects,created_at,metadata_expires_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET name=$2,redirects=$3,metadata_expires_at=$5",
    [value, document.client_name, redirects, Date.now(), expires],
  );
  return {
    name: document.client_name,
    redirects,
    metadata_expires_at: expires,
  };
}
