import { AiIntegration } from "../../../packages/api/src/ai/store";
import type { Sql } from "../../../packages/api/src/auth/store";
import { Notifications } from "../../../packages/api/src/notifications/store";
import { defaultPreferences } from "../../../packages/api/src/notifications/types";
import { PanelUpdates } from "../../../packages/api/src/panel/updates";
import { dnsRecords } from "../../../packages/api/src/services/domains";
import { githubSource } from "../../../packages/api/src/services/github";
import { GitHubApp } from "../../../packages/api/src/services/github-app";

// Test-only entrypoint. Native fetch runs inside workerd; the host intercepts
// outbound requests, so no GitHub Apps, AI requests or emails are created.
export default {
  async fetch(request: Request, env: { DB: D1Database }) {
    const sql: Sql = {
      async query<T extends Record<string, unknown>>(
        query: string,
        values: unknown[] = [],
      ) {
        const ordered: unknown[] = [];
        const statement = query.replace(/\$(\d+)/g, (_, index: string) => {
          ordered.push(values[Number(index) - 1]);
          return "?";
        });
        return (
          await env.DB.prepare(statement)
            .bind(...ordered)
            .all<T>()
        ).results;
      },
    };
    const secret = "worker-test-secret".repeat(4);
    const origin = "https://ephor.example.com";
    const scenario = new URL(request.url).pathname.slice(1);
    try {
      if (scenario === "ai")
        return Response.json(await new AiIntegration(sql, secret).models());
      if (scenario === "dns")
        return Response.json(await dnsRecords("example.com"));
      if (scenario === "legacy")
        return Response.json(
          await githubSource({
            type: "github",
            repository: "fixture/web",
            branch: "main",
          }),
        );
      if (scenario === "email") {
        const notifications = new Notifications(sql, secret, origin);
        await notifications.save({
          enabled: true,
          apiKey: "re_fixture_key",
          from: "alerts@example.com",
          recipients: ["owner@example.com"],
          preferences: defaultPreferences(),
        });
        const { id } = await notifications.test({ channel: "email" });
        await notifications.deliver();
        return Response.json(
          (
            await sql.query(
              "SELECT email_status,error FROM ephor_notification WHERE id=$1",
              [id],
            )
          )[0],
        );
      }
      const github =
        scenario === "panel"
          ? new PanelUpdates({ sql, secret, origin, database: env.DB }).github
          : new GitHubApp(sql, secret, origin);
      if (scenario === "redirect")
        return Response.json(await github.api("/redirect", "fixture-token"));
      const flow = await github.start();
      const install = await github.finish({
        kind: "register",
        state: flow.state,
        code: scenario,
      });
      if (!("state" in install)) throw Error("Missing installation state");
      await github.finish({
        kind: "install",
        state: install.state,
        installationId: scenario === "panel" ? "100" : "99",
      });
      await github.token(scenario === "panel" ? "100" : "99");
      let replayRejected = false;
      try {
        await github.finish({
          kind: "register",
          state: flow.state,
          code: scenario,
        });
      } catch {
        replayRejected = true;
      }
      return Response.json({ status: await github.status(), replayRejected });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        { status: 500 },
      );
    }
  },
};
