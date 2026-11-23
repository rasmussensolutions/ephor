import upstream from "../../../../.ephor-upstream.json";
import type { AuthEnvironment } from "../auth/config";
import { AuthError, AuthStore } from "../auth/store";
import { GitHubApp, numericId } from "../services/github-app";
import { object } from "../services/spec";
import type {
  PanelConfig,
  PanelFile,
  PanelJob,
  PanelProgress,
  PanelState,
  PanelStatus,
} from "./types";

const official = "rasmussensolutions/ephor";
const workflow = "update-ephor.yml";
const permissions = {
  contents: "write",
  metadata: "read",
  actions: "write",
  pull_requests: "write",
  checks: "read",
  statuses: "read",
};
const sha = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value))
    throw new AuthError("PANEL_INVALID_VERSION", 409);
  return value;
};
interface Run {
  id: number;
  head_sha: string;
  display_title: string;
  status: string;
  conclusion: string | null;
  html_url: string;
}
interface Pull {
  number: number;
  state: string;
  merged: boolean;
  merge_commit_sha: string | null;
  head: { sha: string; ref: string; repo: { id: number } };
  base: { sha: string; ref: string; repo: { id: number } };
  mergeable: boolean | null;
  mergeable_state: string;
}
export class PanelUpdates {
  readonly github: GitHubApp;
  constructor(
    readonly env: AuthEnvironment,
    request: typeof fetch = fetch,
    readonly running = upstream.commit,
  ) {
    this.github = new GitHubApp(
      env.sql,
      env.secret,
      env.origin,
      request,
      "panel",
    );
  }
  async state(): Promise<PanelState> {
    const [row] = await this.env.sql.query<{ payload: string }>(
      "SELECT payload FROM ephor_panel_update WHERE id=1",
    );
    return JSON.parse(row?.payload ?? "{}");
  }
  // Serialize mutations across Worker isolates / server replicas. Reads never mutate state.
  async change<T>(
    action: (state: PanelState, save: () => Promise<void>) => Promise<T>,
  ) {
    const lease = crypto.randomUUID();
    const acquired = await this.env.sql.query(
      "UPDATE ephor_panel_update SET lease=$1,lease_until=$2 WHERE id=1 AND lease_until<$3 RETURNING id",
      [lease, Date.now() + 120000, Date.now()],
    );
    if (!acquired.length) throw new AuthError("PANEL_UPDATE_BUSY", 409);
    const state = await this.state();
    const save = async () => {
      const rows = await this.env.sql.query(
        "UPDATE ephor_panel_update SET payload=$1,lease_until=$4 WHERE id=1 AND lease=$2 AND lease_until>$3 RETURNING id",
        [JSON.stringify(state), lease, Date.now(), Date.now() + 120000],
      );
      if (!rows.length) throw new AuthError("PANEL_UPDATE_BUSY", 409);
    };
    try {
      return await action(state, save);
    } finally {
      await this.env.sql.query(
        "UPDATE ephor_panel_update SET lease=NULL,lease_until=0 WHERE id=1 AND lease=$1",
        [lease],
      );
    }
  }
  async access(config: PanelConfig) {
    const token = await this.github.token(
      config.installationId,
      config.repositoryId,
      permissions,
    );
    const repo = await this.github.api<{
      id: number;
      full_name: string;
      default_branch: string;
      archived: boolean;
    }>(`/repositories/${config.repositoryId}`, token);
    if (
      String(repo.id) !== config.repositoryId ||
      repo.full_name !== config.repository ||
      repo.default_branch !== config.branch ||
      repo.archived
    )
      throw new AuthError("PANEL_REPOSITORY_CHANGED", 409);
    return { token, path: `/repos/${repo.full_name}` };
  }
  async version(path: string, token: string, ref: string) {
    const file = await this.github.api<{ content: string; encoding: string }>(
      `${path}/contents/.ephor-upstream.json?ref=${encodeURIComponent(ref)}`,
      token,
    );
    if (file.encoding !== "base64" || file.content.length > 4096)
      throw new AuthError("PANEL_INVALID_VERSION", 409);
    return sha(JSON.parse(atob(file.content.replace(/\s/g, ""))).commit);
  }
  async head(path: string, token: string, branch: string) {
    const result = await this.github.api<{ commit: { sha: string } }>(
      `${path}/branches/${encodeURIComponent(branch)}`,
      token,
    );
    return sha(result.commit.sha);
  }
  async latest() {
    const result = await this.github.api<{ workflow_runs: Run[] }>(
      `/repos/${official}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=1`,
    );
    return sha(result.workflow_runs[0]?.head_sha);
  }
  async configure(value: unknown) {
    const b = object(value);
    if (
      !["cloudflare", "railway", "vps", "other"].includes(String(b.host)) ||
      !["git", "manual"].includes(String(b.deployment)) ||
      b.confirmed !== true
    )
      throw new AuthError("PANEL_INVALID_CONFIG");
    return this.change(async (state, save) => {
      if (state.job && !state.job.merged)
        throw new AuthError("PANEL_UPDATE_BUSY", 409);
      const installationId = numericId(b.installationId),
        repositoryId = numericId(b.repositoryId);
      const { repo } = await this.github.repository(
        installationId,
        repositoryId,
      );
      if (repo.full_name.toLowerCase() === official)
        throw new AuthError("PANEL_USE_DEPLOYMENT_COPY", 409);
      const config: PanelConfig = {
        installationId,
        repositoryId,
        repository: repo.full_name,
        branch: repo.default_branch,
        host: b.host as PanelConfig["host"],
        deployment: b.deployment as PanelConfig["deployment"],
      };
      const { token, path } = await this.access(config);
      const version = await this.version(path, token, config.branch);
      // Refuse accidentally selecting an unrelated repository with a copied marker.
      const manifest = await this.github.api<{ content: string }>(
        `${path}/contents/package.json?ref=${encodeURIComponent(config.branch)}`,
        token,
      );
      if (
        JSON.parse(atob(manifest.content.replace(/\s/g, ""))).name !== "ephor"
      )
        throw new AuthError("PANEL_USE_DEPLOYMENT_COPY", 409);
      state.config = config;
      state.repositoryVersion = version;
      delete state.job;
      await save();
      await new AuthStore(this.env.sql).audit(
        "panel.connected",
        config.repository,
      );
    });
  }
  async check() {
    return this.change(async (state, save) => {
      state.latest = await this.latest();
      if (state.config) {
        const { path, token } = await this.access(state.config);
        state.repositoryVersion = await this.version(
          path,
          token,
          state.config.branch,
        );
      }
      state.checkedAt = Date.now();
      await save();
    });
  }
  async prepare() {
    return this.change(async (state, save) => {
      const config = state.config;
      if (!config) throw new AuthError("PANEL_NOT_CONFIGURED", 409);
      if (state.job && !state.job.merged) return;
      if (state.job?.merged && this.running !== state.job.target)
        throw new AuthError("PANEL_DEPLOYMENT_PENDING", 409);
      const { path, token } = await this.access(config);
      const target = await this.latest(),
        base = await this.head(path, token, config.branch);
      const version = await this.version(path, token, base);
      if (version === target) throw new AuthError("PANEL_ALREADY_CURRENT", 409);
      const updater = await this.github.api<{ content: string }>(
        `${path}/contents/.github/workflows/${workflow}?ref=${base}`,
        token,
      );
      if (
        !atob(updater.content.replace(/\s/g, "")).includes(
          "# ephor-panel-protocol: 1",
        )
      )
        throw new AuthError("PANEL_WORKFLOW_UPGRADE", 409);
      const job: PanelJob = {
        id: crypto.randomUUID(),
        target,
        base,
        createdAt: Date.now(),
      };
      state.latest = target;
      state.repositoryVersion = version;
      state.job = job;
      // Persist before dispatch. An ambiguous network result must not silently dispatch twice.
      await save();
      await this.github.api(
        `${path}/actions/workflows/${workflow}/dispatches`,
        token,
        { ref: config.branch, inputs: { panel_request: job.id, target, base } },
      );
      await new AuthStore(this.env.sql).audit("panel.update_prepared", target);
    });
  }
  async prepared(
    config: PanelConfig,
    job: PanelJob,
    path: string,
    token: string,
  ) {
    const head = await this.head(path, token, `ephor-update/${job.target}`);
    const commit = await this.github.api<{ parents: { sha: string }[] }>(
      `${path}/git/commits/${head}`,
      token,
    );
    if (
      commit.parents.length !== 1 ||
      commit.parents[0]?.sha !== job.base ||
      (await this.version(path, token, head)) !== job.target ||
      (await this.head(path, token, config.branch)) !== job.base
    )
      throw new AuthError("PANEL_REVIEW_CHANGED", 409);
    return head;
  }
  async preparation(path: string, token: string, job: PanelJob) {
    const runs = await this.github.api<{ workflow_runs: Run[] }>(
      `${path}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=100`,
      token,
    );
    return runs.workflow_runs.find(
      (r) =>
        r.display_title === `Ephor panel ${job.id}` && r.head_sha === job.base,
    );
  }
  async review() {
    return this.change(async (state, save) => {
      const { config, job } = state;
      if (!config || !job || job.merged)
        throw new AuthError("PANEL_NOT_PREPARED", 409);
      const { path, token } = await this.access(config);
      const run = await this.preparation(path, token, job);
      if (run?.conclusion !== "success")
        throw new AuthError("PANEL_NOT_PREPARED", 409);
      const head = await this.prepared(config, job, path, token);
      const existing = await this.github.api<Pull[]>(
        `${path}/pulls?state=all&head=${encodeURIComponent(`${config.repository.split("/")[0]}:ephor-update/${job.target}`)}&base=${encodeURIComponent(config.branch)}&per_page=100`,
        token,
      );
      let pull = existing.find((p) => p.head.sha === head);
      if (pull && pull.state !== "open")
        throw new AuthError("PANEL_REVIEW_CHANGED", 409);
      // Creating with the App token starts CI without manual GITHUB_TOKEN approval.
      pull ??= await this.github.api<Pull>(`${path}/pulls`, token, {
        title: `Update Ephor to ${job.target.slice(0, 12)}`,
        head: `ephor-update/${job.target}`,
        base: config.branch,
        body: `Updates to https://github.com/${official}/commit/${job.target}. Prepared from ${job.base}. Review migrations and confirm a database recovery point before installing. Deployment mode: ${config.deployment}.`,
      });
      job.head = head;
      job.pull = pull.number;
      await save();
    });
  }
  async pull(config: PanelConfig, job: PanelJob, path: string, token: string) {
    const pull = await this.github.api<Pull>(
      `${path}/pulls/${job.pull}`,
      token,
    );
    if (
      String(pull.head.repo.id) !== config.repositoryId ||
      String(pull.base.repo.id) !== config.repositoryId ||
      pull.head.ref !== `ephor-update/${job.target}` ||
      pull.base.ref !== config.branch ||
      pull.head.sha !== job.head
    )
      throw new AuthError("PANEL_REVIEW_CHANGED", 409);
    return pull;
  }
  async checks(path: string, token: string, head: string) {
    const [ci, checks, statuses] = await Promise.all([
      this.github.api<{ workflow_runs: Run[] }>(
        `${path}/actions/workflows/ci.yml/runs?head_sha=${head}&event=pull_request&per_page=1`,
        token,
      ),
      this.github.api<{
        total_count: number;
        check_runs: { status: string; conclusion: string | null }[];
      }>(
        `${path}/commits/${head}/check-runs?filter=latest&per_page=100`,
        token,
      ),
      this.github.api<{ state: string; total_count: number }>(
        `${path}/commits/${head}/status`,
        token,
      ),
    ]);
    const run = ci.workflow_runs[0];
    return (
      run?.head_sha === head &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      checks.total_count <= 100 &&
      checks.check_runs.every(
        (c) =>
          c.status === "completed" &&
          ["success", "neutral", "skipped"].includes(c.conclusion ?? ""),
      ) &&
      (statuses.total_count === 0 || statuses.state === "success")
    );
  }
  async files(path: string, token: string, pull: number) {
    const files: PanelFile[] = [];
    for (let page = 1; page <= 4; page++) {
      const batch = await this.github.api<PanelFile[]>(
        `${path}/pulls/${pull}/files?per_page=100&page=${page}`,
        token,
      );
      if (page === 4 && batch.length)
        throw new AuthError("PANEL_MANUAL_REVIEW", 409);
      files.push(...batch);
      if (batch.length < 100) break;
    }
    for (const file of files) {
      if (
        [
          "wrangler.jsonc",
          "apps/worker/wrangler.jsonc",
          "deploy/docker/compose.yaml",
          "railway.json",
          "railway.toml",
          "scripts/update-ephor.py",
        ].includes(file.filename) ||
        file.filename.startsWith(".github/workflows/") ||
        (file.filename.startsWith("packages/api/migrations/") &&
          file.status !== "added")
      )
        throw new AuthError("PANEL_MANUAL_REVIEW", 409);
    }
    return files.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch?.slice(0, 20000),
    }));
  }
  async install(value: unknown) {
    const b = object(value);
    return this.change(async (state, save) => {
      const { config, job } = state;
      if (
        !config ||
        !job?.pull ||
        !job.head ||
        b.head !== job.head ||
        b.target !== job.target ||
        b.backupConfirmed !== true
      )
        throw new AuthError("PANEL_REVIEW_CHANGED", 409);
      if (job.merged) return;
      const { path, token } = await this.access(config);
      const pull = await this.pull(config, job, path, token);
      if (pull.merged) {
        job.merged = sha(pull.merge_commit_sha);
        job.mergedAt = Date.now();
        state.repositoryVersion = job.target;
        await save();
        return;
      }
      if (
        pull.state !== "open" ||
        pull.base.sha !== job.base ||
        !pull.mergeable ||
        pull.mergeable_state !== "clean"
      )
        throw new AuthError("PANEL_REVIEW_CHANGED", 409);
      await this.prepared(config, job, path, token);
      await this.files(path, token, job.pull);
      if (!(await this.checks(path, token, job.head)))
        throw new AuthError("PANEL_CHECKS_PENDING", 409);
      await save();
      const result = await this.github.api<{ merged: boolean; sha: string }>(
        `${path}/pulls/${job.pull}/merge`,
        token,
        { sha: job.head, merge_method: "merge" },
        "PUT",
      );
      if (!result.merged) throw new AuthError("PANEL_MERGE_BLOCKED", 409);
      job.merged = sha(result.sha);
      job.mergedAt = Date.now();
      state.repositoryVersion = job.target;
      await save();
      await new AuthStore(this.env.sql).audit(
        "panel.update_merged",
        job.target,
      );
    });
  }
  deploymentProgress(config: PanelConfig, job: PanelJob): PanelProgress {
    const pullUrl = `https://github.com/${config.repository}/pull/${job.pull}`;
    if (this.running === job.target)
      return {
        stage: "updated",
        message: "The new panel version is running.",
        pullUrl,
      };
    const manual = config.deployment === "manual";
    return {
      stage: manual ? "manual" : "deploying",
      message: manual
        ? "Repository updated. Deploy this revision on your host, apply migrations, and restart the panel."
        : Date.now() - (job.mergedAt ?? job.createdAt) > 1800000
          ? "The new version is not serving yet. Check your host’s deployment logs; the repository merge alone does not confirm deployment."
          : "Repository updated. Waiting for your host to deploy and serve the new version…",
      pullUrl,
    };
  }
  async progress(config: PanelConfig, job: PanelJob): Promise<PanelProgress> {
    if (job.merged) return this.deploymentProgress(config, job);
    const { path, token } = await this.access(config);
    if (!job.pull) {
      const run = await this.preparation(path, token, job);
      if (run?.conclusion === "success") {
        await this.prepared(config, job, path, token);
        return {
          stage: "prepared",
          message:
            "The update is prepared. Open the review to start checks and inspect the changes.",
          runUrl: run.html_url,
        };
      }
      if (
        (run?.status === "completed" && run.conclusion !== "success") ||
        (!run && Date.now() - job.createdAt > 180000)
      )
        return {
          stage: "blocked",
          message:
            "Preparation did not finish successfully. Check the workflow for conflicts or configuration changes, then clear this attempt before retrying.",
          runUrl:
            run?.html_url ??
            `https://github.com/${config.repository}/actions/workflows/${workflow}`,
        };
      return {
        stage: "preparing",
        message: "Preparing the update in GitHub…",
        runUrl:
          run?.html_url ??
          `https://github.com/${config.repository}/actions/workflows/${workflow}`,
      };
    }
    const pull = await this.pull(config, job, path, token);
    const pullUrl = `https://github.com/${config.repository}/pull/${job.pull}`;
    if (pull.merged) return this.deploymentProgress(config, job);
    if (
      pull.state !== "open" ||
      pull.base.sha !== job.base ||
      (await this.head(path, token, config.branch)) !== job.base ||
      pull.mergeable === false
    )
      return {
        stage: "blocked",
        message:
          "The update or production branch changed, or GitHub cannot merge it. Review it in GitHub and prepare a new attempt.",
        pullUrl,
      };
    const files = await this.files(path, token, job.pull);
    const ready =
      (await this.checks(path, token, job.head ?? "")) &&
      pull.mergeable === true &&
      pull.mergeable_state === "clean";
    return {
      stage: ready ? "ready" : "checking",
      message: ready
        ? "Checks passed. Review the changes and confirm your database recovery point before installing."
        : "Waiting for checks and repository approval rules. Failed checks or required reviews must be resolved before installing.",
      pullUrl,
      head: job.head,
      files,
    };
  }
  async status(live = false): Promise<PanelStatus> {
    const state = await this.state();
    const result: PanelStatus = {
      ...state,
      running: this.running,
      detectedHost:
        this.env.deployment?.runtime === "cloudflare-worker"
          ? "cloudflare"
          : (this.env.deployment?.host ?? "other"),
    };
    if (live && state.config && state.job) {
      try {
        result.progress = await this.progress(state.config, state.job);
      } catch (e) {
        if (
          e instanceof AuthError &&
          [
            "PANEL_REVIEW_CHANGED",
            "PANEL_MANUAL_REVIEW",
            "PANEL_REPOSITORY_CHANGED",
          ].includes(e.code)
        )
          result.progress = {
            stage: "blocked",
            message:
              "This update needs manual review: the repository, configuration, or reviewed changes no longer match.",
          };
        else throw e;
      }
    }
    return result;
  }
  async reset() {
    return this.change(async (state, save) => {
      delete state.job;
      await save();
      await new AuthStore(this.env.sql).audit("panel.update_cleared");
    });
  }
}
