import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { Hono } from "hono";
import { type AuthEnvironment, createAuth, requireOwner } from "./config";
import { AuthError, AuthStore, OWNER_ID } from "./store";

/** A separate, session-bound ceremony: verification never issues a login session. */
export function reauthenticationRoutes(app: Hono, env: AuthEnvironment) {
  const store = new AuthStore(env.sql);
  app.post("/api/security/reauth/options", async (c) => {
    const session = await requireOwner(
      createAuth(env, c.req.raw.headers),
      store,
      c.req.raw.headers,
    );
    await store.limit(`reauth:${session.session.id}`, 15);
    const { state } = await store.read();
    const options = await generateAuthenticationOptions({
      rpID: new URL(env.origin).hostname,
      userVerification: "required",
      allowCredentials: state.credentials.map((id) => ({ id })),
    });
    await env.sql.query(
      "INSERT INTO ephor_session_verification(session_id,challenge,expires_at,verified_at) VALUES($1,$2,$3,0) ON CONFLICT(session_id) DO UPDATE SET challenge=$2,expires_at=$3",
      [session.session.id, options.challenge, Date.now() + 300_000],
    );
    return c.json(options);
  });
  app.post("/api/security/reauth/verify", async (c) => {
    const session = await requireOwner(
      createAuth(env, c.req.raw.headers),
      store,
      c.req.raw.headers,
    );
    await store.limit(`reauth:${session.session.id}`, 15);
    // Consume before verification, including failed assertions. A challenge cannot
    // be moved to another browser session or replayed in concurrent requests.
    const [challenge] = await env.sql.query<{ challenge: string }>(
      "UPDATE ephor_session_verification SET expires_at=0 WHERE session_id=$1 AND expires_at>$2 RETURNING challenge",
      [session.session.id, Date.now()],
    );
    if (!challenge) throw new AuthError("REAUTH_REQUIRED", 403);
    const body = await c.req.json<{ response: AuthenticationResponseJSON }>();
    const response = body?.response;
    const { state } = await store.read();
    if (!response || !state.credentials.includes(response.id))
      throw new AuthError("UNAUTHORIZED", 401);
    const [key] = await env.sql.query<{
      id: string;
      credentialID: string;
      publicKey: string;
      counter: number;
    }>(
      'SELECT id,"credentialID","publicKey",counter FROM passkey WHERE "credentialID"=$1 AND "userId"=$2',
      [response.id, OWNER_ID],
    );
    if (!key) throw new AuthError("UNAUTHORIZED", 401);
    try {
      const result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: env.origin,
        expectedRPID: new URL(env.origin).hostname,
        credential: {
          id: key.credentialID,
          publicKey: Uint8Array.from(atob(key.publicKey), (byte) =>
            byte.charCodeAt(0),
          ),
          counter: Number(key.counter),
        },
        requireUserVerification: true,
      });
      if (!result.verified) throw new Error("Verification failed");
      const updated = await env.sql.query(
        "UPDATE passkey SET counter=$1 WHERE id=$2 AND counter=$3 RETURNING id",
        [result.authenticationInfo.newCounter, key.id, key.counter],
      );
      if (!updated.length) throw new Error("Credential changed");
    } catch {
      await store.audit("session.verification_rejected", session.session.id);
      throw new AuthError("PASSKEY_VERIFICATION_FAILED", 403);
    }
    // Check revocation and recovery again after the cryptographic work.
    await requireOwner(
      createAuth(env, c.req.raw.headers),
      store,
      c.req.raw.headers,
    );
    if (!(await store.read()).state.credentials.includes(response.id))
      throw new AuthError("UNAUTHORIZED", 401);
    await env.sql.query(
      "UPDATE ephor_session_verification SET verified_at=$1 WHERE session_id=$2",
      [Date.now(), session.session.id],
    );
    await store.audit("session.verified", session.session.id);
    return c.json({ ok: true });
  });
}
