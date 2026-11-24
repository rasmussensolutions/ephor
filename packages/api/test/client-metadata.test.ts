import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { randomToken } from "../src/auth/store";
import {
  clientId,
  fetchClientMetadata,
  resolveClient,
} from "../src/mcp/client-metadata";
import { enrolled, fixture, origin } from "./helpers";

const url = "https://chatgpt.com/oauth/client.json";
const document = {
  client_id: url,
  client_name: "ChatGPT",
  redirect_uris: ["http://127.0.0.1:9988/callback"],
  token_endpoint_auth_method: "private_key_jwt",
  token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
};
test("CIMD validates identity, metadata, authentication methods, and exact redirect URIs", async () => {
  const { sql } = await fixture();
  let requests = 0;
  const load = async () => {
    requests++;
    return { body: document, maxAge: 300 };
  };
  const client = await resolveClient(sql, url, load);
  expect(client?.name).toBe("ChatGPT");
  expect(JSON.parse(client?.redirects ?? "[]")).toEqual(document.redirect_uris);
  await resolveClient(sql, url, load);
  expect(requests).toBe(1);
  for (const body of [
    { ...document, client_id: "https://evil.example/client.json" },
    { ...document, client_name: "" },
    { ...document, redirect_uris: ["javascript:alert(1)"] },
    { ...document, token_endpoint_auth_methods_supported: ["private_key_jwt"] },
  ]) {
    await sql.query("UPDATE ephor_mcp_client SET metadata_expires_at=0");
    await expect(
      resolveClient(sql, url, async () => ({ body, maxAge: 300 })),
    ).rejects.toThrow("INVALID_CLIENT_METADATA");
  }
  for (const value of [
    "http://example.com/client.json",
    "https://localhost/client.json",
    "https://127.0.0.1/client.json",
    "https://[::1]/client.json",
    "https://example.com/",
    "https://u:p@example.com/client.json",
    "https://example.com:8443/client.json",
    "https://example.com/client.json#x",
  ])
    expect(clientId.safeParse(value).success).toBe(false);
});
test("metadata transport rejects private DNS, redirects, wrong content types and oversized bodies", async () => {
  let requests = 0;
  const response = (body: string, status = 200, type = "application/json") =>
    (async (_url: string | URL | Request, options?: RequestInit) => {
      requests++;
      expect(options?.redirect).toBe("manual");
      expect(new Headers(options?.headers).has("Cookie")).toBe(false);
      expect(new Headers(options?.headers).has("Authorization")).toBe(false);
      return new Response(body, { status, headers: { "Content-Type": type } });
    }) as typeof fetch;
  const publicDns = async () => [{ type: "A", value: "1.1.1.1" }];
  await expect(
    fetchClientMetadata(
      url,
      true,
      async () => [{ type: "A", value: "127.0.0.1" }],
      response("{}"),
    ),
  ).rejects.toThrow();
  expect(requests).toBe(0);
  for (const request of [
    response("{}", 302),
    response("{}", 200, "text/html"),
    response("x".repeat(32769)),
  ])
    await expect(
      fetchClientMetadata(url, true, publicDns, request),
    ).rejects.toThrow();
  expect(
    (
      await fetchClientMetadata(
        url,
        true,
        publicDns,
        response(JSON.stringify(document)),
      )
    ).body,
  ).toEqual(document);
});
test("CIMD authorization completes consent, PKCE, issuer identification and refresh with URL client IDs", async () => {
  const f = await enrolled();
  await resolveClient(f.sql, url, async () => ({
    body: document,
    maxAge: 300,
  }));
  const metadata = await (
    await f.app.request(`${origin}/.well-known/oauth-authorization-server`)
  ).json();
  expect(metadata.client_id_metadata_document_supported).toBe(true);
  expect(metadata.authorization_response_iss_parameter_supported).toBe(true);
  const verifier = randomToken();
  const query = new URLSearchParams({
    client_id: url,
    redirect_uri: document.redirect_uris[0] ?? "",
    response_type: "code",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "cimd-state",
    resource: `${origin}/mcp`,
  });
  const redirect = await f.app.request(`${origin}/oauth/authorize?${query}`);
  expect(redirect.status).toBe(302);
  const id = new URL(redirect.headers.get("location") ?? "").searchParams.get(
    "authorization",
  );
  const consent = await f.browser.request("/mcp/authorize", {
    id,
    approve: true,
    name: "ChatGPT",
    policy: {},
    days: 30,
  });
  expect(consent.status).toBe(200);
  const callback = new URL((await consent.json()).redirect);
  expect(callback.searchParams.get("iss")).toBe(origin);
  const token = async (body: Record<string, string>) =>
    f.app.request(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: url,
        resource: `${origin}/mcp`,
        ...body,
      }),
    });
  const exchange = await token({
    grant_type: "authorization_code",
    code: callback.searchParams.get("code") ?? "",
    code_verifier: verifier,
    redirect_uri: document.redirect_uris[0] ?? "",
  });
  expect(exchange.status).toBe(200);
  const credentials = await exchange.json();
  expect(
    (
      await token({
        grant_type: "refresh_token",
        refresh_token: credentials.refresh_token,
      })
    ).status,
  ).toBe(200);
  query.set("redirect_uri", "https://evil.example/callback");
  expect(
    (await f.app.request(`${origin}/oauth/authorize?${query}`)).status,
  ).toBe(400);
});
