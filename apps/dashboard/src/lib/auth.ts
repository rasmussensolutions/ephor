import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({ plugins: [passkeyClient()] });
export interface SessionInfo {
  user: { id: string; name: string };
  session: { id: string; expiresAt: string; freshUntil: string };
  recoveryCodesRemaining: number;
}
const messages: Record<string, string> = {
  DEPLOYMENT_METADATA_CHANGED:
    "Deployment details changed or the host is no longer active. Refresh and try again.",
  INVALID_DEPLOYMENT_METADATA:
    "Enter a provider name and select the deployment details from the available options.",
  WORKER_HAS_NO_HOST_MACHINE:
    "Cloudflare Workers run on provider-managed infrastructure, not one of your machines.",
  INVALID_UPDATE_POLICY:
    "Choose at least one day and valid UTC update and reboot times.",
  PROTECTION_HELPER_UPGRADE_REQUIRED:
    "Repair the protection management helper to enable automatic-update management.",
  UPDATE_POLICY_CONFLICT:
    "The managed update policy changed locally. Review the machine configuration before retrying.",
  PROTECTION_BUILD_REQUIRED:
    "Build the updated daemon bundle before connecting protection management.",
  PROTECTION_HELPER_REQUIRED:
    "Connect the protection management helper and wait for its next report.",
  PROTECTION_UNSUPPORTED:
    "This host is unsupported or has an externally managed CrowdSec installation.",
  PROTECTION_STATE_CHANGED:
    "The machine configuration changed. Refresh and review a new plan.",
  PROTECTION_NOT_READY:
    "Verify that CrowdSec and its SSH journal source are ready before enabling blocking.",
  PROTECTION_TRIAL_EXPIRED:
    "The blocking trial expired. Start a new trial after reviewing connectivity.",
  PROTECTION_JOB_ACTIVE:
    "Another protection job is active. Wait for its result before approving a new one.",
  PROTECTION_PLAN_EXPIRED: "This plan expired. Review the change again.",
  INVALID_PROTECTION_IP:
    "Enter individual IPv4 or IPv6 addresses, without ranges or hostnames.",
  TRUSTED_IP_REQUIRED:
    "Enter at least one trusted administrator IP address before enabling blocking.",
  SECURITY_BUILD_REQUIRED:
    "Publish a current Ephor daemon bundle before enabling security collection. See docs/security.md.",
  SECURITY_COLLECTOR_REQUIRED:
    "Enable the security helper on this machine before requesting a scan.",
  ACTIVE_MACHINE_REQUIRED:
    "Security collection requires an active, enrolled machine.",
  FINDING_NOT_OPEN:
    "This finding has already been resolved or removed. Refresh to see its current status.",
  INVALID_RISK_EXPIRY:
    "Choose a future expiry date within the next year, or leave it empty.",
  INVALID_FINDING_STATUS: "Choose an available finding status.",
  INVALID_SECURITY_RETENTION: "Choose one of the available retention periods.",
  AI_AUTH_FAILED:
    "OpenRouter rejected this API key. Check the key and its permissions in AI settings.",
  AI_CREDITS_REQUIRED:
    "Your OpenRouter account needs credits for this request.",
  AI_RATE_LIMITED:
    "OpenRouter is rate limiting requests. Please try again shortly.",
  AI_MODEL_UNAVAILABLE:
    "This model is unavailable or incompatible with the request. Choose another model in AI settings.",
  AI_PROVIDER_UNAVAILABLE:
    "OpenRouter did not respond successfully. Please try again shortly.",
  AI_EMPTY_RESPONSE:
    "The model returned no answer. Try again or choose a different model.",
  AI_KEY_REQUIRED: "Enter a valid OpenRouter API key.",
  AI_MODEL_INVALID: "Enter a valid model ID.",
  AI_PROVIDER_UNSUPPORTED: "Choose a supported AI provider.",
  AI_SETTINGS_CHANGED:
    "AI settings changed during verification. Reload and try again.",
  AI_NOT_CONNECTED:
    "Connect and verify an AI provider in Settings → Integrations first.",
  AI_BUILD_NOT_FAILED: "Diagnosis is available only for a saved failed build.",
  INVALID_VARIABLE_REFERENCE:
    "Choose a supported service connection. References must fill the entire value.",
  CONNECTION_SOURCE_UNAVAILABLE:
    "This connection is no longer available. Choose a PostgreSQL, Redis or Qdrant catalog service on the same machine.",
  STATEFUL_WORKER_REQUIRED:
    "Upgrade this machine’s deployment worker to support persistent services and database resources.",
  VOLUME_LAYOUT_LOCKED:
    "Volume names and paths cannot change after a deployment is queued. Create a new service and migrate data to change storage layout.",
  INVALID_VOLUMES:
    "Use up to four named volumes with distinct absolute mount paths, outside system directories.",
  INVALID_DATABASE_RESOURCES:
    "Choose valid CPU/memory limits. Redis data memory must be at most 75% of container memory.",
  STATEFUL_ROLLBACK_BLOCKED:
    "Persistent services require explicit data recovery. Restore a backup into a separate service.",
  CONNECTION_WORKER_REQUIRED:
    "Update the deployment worker in machine settings to enable service connections.",
  INVALID_DISPLAY_NAME:
    "Enter a name between 1 and 80 characters, without control characters.",
  INVALID_GROUP_COLOR: "Choose one of the available group colors.",
  SERVICE_GROUP_NOT_FOUND: "Only apps with multiple components have a group.",
  PRESENTATION_CHANGED:
    "Another name changed while you were saving. Try again.",
  VARIABLES_CHANGED:
    "These variables or service settings changed elsewhere. Reload variables before saving again; your draft has been kept.",
  COMPONENT_NOT_FOUND:
    "This component is no longer part of the app. Close the drawer and refresh the map.",
  VARIABLE_NOT_FOUND:
    "This variable no longer exists. Reload the variable list.",
  INVALID_BACKUP_DESTINATION:
    "Check the provider, account ID or region, bucket name, and storage access keys.",
  INVALID_BACKUP_SCHEDULE:
    "Choose a daily, weekly, or manual schedule and an hour from 0 to 23 UTC.",
  BACKUP_WORKER_REQUIRED:
    "Upgrade the deployment worker from machine settings and wait for it to connect.",
  BACKUP_DESTINATION_NOT_READY:
    "Wait for the storage connection check to succeed before enabling backups.",
  BACKUP_DESTINATION_LOCKED:
    "This app’s backup repository is tied to its existing storage destination.",
  BACKUP_ALREADY_RUNNING:
    "A backup operation is already queued or running for this app or destination.",
  BACKUP_APP_NOT_READY:
    "Deploy this catalog app successfully before backing it up.",
  BACKUP_ARCHITECTURE_MISMATCH:
    "Choose a machine with the same CPU architecture as the original server, and wait for both machines to report their architecture.",
  BACKUP_INTERRUPTED:
    "The worker restarted during this operation. No remote backup was published as successful. Check the app’s status, then retry.",
  INVALID_NOTIFICATION_SETTINGS:
    "Check the notification settings and try again.",
  INVALID_NOTIFICATION_EMAIL:
    "Enter valid email addresses, with at most five recipients.",
  INVALID_RESEND_KEY: "Enter a valid Resend API key beginning with re_.",
  NOTIFICATION_EMAIL_NOT_CONFIGURED:
    "Save an API key, sender, and recipients, and enable email before sending a test.",
  BACKUP_STORAGE_FAILED:
    "Storage verification failed. Check the bucket endpoint and jurisdiction, permissions, access keys, network access, and free disk space, then retry.",
  BACKUP_APP_FAILED:
    "The app snapshot could not finish. Check the app’s recovery status and free disk space before retrying.",
  BACKUP_RECIPE_MISMATCH:
    "The installed app’s runtime recipe differs from this worker’s recipe. A compatible worker or reviewed app migration is required before backing up.",
  BACKUP_RESTORE_FAILED:
    "Restore failed. Original data is unchanged. Check the new service, recipe compatibility, storage access, and available disk space.",
  BACKUP_NOT_FOUND: "This completed backup could not be found.",
  IMAGE_PULL_FAILED:
    "Could not download the container image. Check the machine’s internet access and registry credentials or availability.",
  HEALTH_CHECK_FAILED:
    "The app did not become healthy. Check its application logs before retrying.",
  ROUTE_SWITCH_FAILED:
    "HTTPS routing could not be updated. Check the deployment worker and proxy logs.",
  WORKER_INTERRUPTED:
    "The worker restarted during this operation. Check the app’s status before resuming.",
  DEPLOYMENT_FAILED:
    "Deployment failed. Check the deployment worker and application logs before retrying.",
  DOCKER_VERSION_REQUIRED:
    "Catalog apps require Docker Engine 28 or newer. Upgrade Docker on this machine before deploying.",
  CATALOG_DOMAIN_REQUIRED: "Enter a root domain or subdomain for this app.",
  DATABASE_MUST_BE_PRIVATE:
    "Database ports stay private. Connect using an SSH tunnel.",
  CATALOG_WORKER_REQUIRED:
    "Upgrade this machine’s deployment worker from machine settings.",
  CATALOG_CONFIG_LOCKED:
    "Catalog images and data settings are locked to the reviewed template.",
  CATALOG_ROLLBACK_BLOCKED:
    "Use a recovery point to restore a stateful app. Image rollback cannot restore its data.",
  CATALOG_RECOVERY_REQUIRED:
    "The operation failed. Data is retained. Check Setup & data before resuming the app.",
  BACKUP_LIMIT:
    "This app has 20 recovery points. Delete an unneeded recovery point before restarting or backing up.",
  BACKUP_FAILED:
    "The recovery point could not be completed. Check free disk space and the worker. Incomplete snapshots are never offered for restore.",
  INVALID_PROJECT_NAME: "Enter a project name between 1 and 80 characters.",
  PROJECT_NOT_FOUND: "This project no longer exists.",
  PROJECT_OR_SERVICE_NOT_FOUND:
    "The project or service no longer exists. Refresh and try again.",
  SERVICE_ALREADY_IN_PROJECT:
    "This service already belongs to another project. Remove it there first.",
  DNS_LOOKUP_FAILED:
    "Could not check public DNS right now. Check the records with your DNS provider and try again.",
  GITHUB_ACCESS_OR_RATE_LIMIT:
    "GitHub denied access or reached its API limit. Check App permissions, or wait before retrying.",
  BUILD_WORKER_REQUIRED:
    "Enable or upgrade the deployment worker on both the build and destination machines, and wait for them to connect.",
  BUILD_ARCHITECTURE_MISMATCH:
    "The build machine and destination must have the same CPU architecture.",
  BUILD_REGISTRY_REQUIRED:
    "Configure a build registry in Settings → Integrations, or build on the destination machine.",
  INVALID_BUILD_REGISTRY:
    "Enter a registry namespace and separate push and pull credentials.",
  INVALID_BUILD_SETTINGS:
    "Build limits must be 512–32768 MiB and 0.25–16 CPU cores.",
  INVALID_BUILD_PATH:
    "Use a relative project/Dockerfile path within the repository, without .. or .git.",
  GITHUB_NOT_CONNECTED: "Connect GitHub in Settings → Integrations first.",
  GITHUB_RECONNECT_REQUIRED:
    "Reconnect this repository through the GitHub App.",
  GITHUB_STATE_EXPIRED:
    "This GitHub connection attempt expired. Start connecting again.",
  GITHUB_INSTALLATION_UNAVAILABLE:
    "Grant this Ephor GitHub App access to the repository, then reconnect it.",
  GITHUB_ACCESS_FAILED:
    "GitHub access failed. Check the App installation and repository access, then deploy again.",
  GITHUB_REPOSITORY_IDENTITY_CHANGED:
    "This repository was renamed or transferred. Reconnect it before deploying.",
  BUILD_NOT_ACTIVE: "This build has already finished or been cancelled.",
  BUILD_FAILED:
    "The build failed. Check its logs below, adjust build settings if needed, and deploy again.",
  BUILD_INTERRUPTED:
    "The build worker restarted before finishing. The running service was kept; deploy again.",
  BUILD_TIMED_OUT:
    "The build timed out. Check its logs and build resources before retrying.",
  BUILD_TOOLS_REQUIRED:
    "Run the deployment worker setup/upgrade command on the build machine to install the required tools.",
  INSUFFICIENT_CAPACITY:
    "Not enough free memory or disk space on this machine. Free resources or choose a larger machine, leaving headroom above the app or build budget.",
  FETCH_FAILED:
    "Could not fetch the commit from GitHub. Check repository access and the machine's connection.",
  MACHINE_ARCHITECTURE_REQUIRED:
    "Wait for this machine to report its architecture before connecting a repository.",
  SERVICE_BUILD_REQUIRED:
    "This panel needs a daemon build with service deployment support. See docs/services.md.",
  SERVICE_WORKER_REQUIRED:
    "Enable the deployment worker on this machine and wait for it to connect.",
  DEPLOYMENT_ALREADY_RUNNING:
    "This service already has a queued or running deployment.",
  DOMAIN_IN_USE: "That domain is already assigned to another service.",
  INVALID_IMAGE:
    "Use a full image reference including registry and tag or SHA-256 digest.",
  INVALID_DOMAIN:
    "Enter a public domain name without a URL scheme, port, or path.",
  INVALID_SERVICE_LIMITS:
    "Check the container port, health path, memory, and CPU limits.",
  INVALID_ENVIRONMENT:
    "Environment values must be strings, with valid variable names and a total size below 12 KB.",
  INVALID_REGISTRY:
    "Provide a registry username and read token for the image registry.",
  INVALID_REPOSITORY: "Use owner/repository and a valid branch name.",
  GITHUB_REPOSITORY_UNAVAILABLE:
    "Could not read this repository. Check that the GitHub App has access and the selected branch still exists.",
  AUTO_DEPLOY_DISABLED_OR_STALE:
    "Automatic deployments are paused or this build has been superseded.",
  ROLLBACK_UNAVAILABLE:
    "That deployment has no successful image available for rollback.",
  DEPLOYMENT_NOT_QUEUED:
    "The worker already claimed this deployment. It cannot be cancelled safely.",
  NO_VERIFIED_RELEASE:
    "No verified release is available. Check the panel's release configuration.",
  UPDATER_BOOTSTRAP_REQUIRED:
    "Enable the updater on this VPS and wait for it to connect before updating.",
  NO_COMPATIBLE_UPDATE:
    "There is no newer compatible daemon release for this machine.",
  UPDATE_ALREADY_RUNNING: "An update is already in progress on this machine.",
  INVALID_MACHINE_NAME: "Enter a machine name between 1 and 80 characters.",
  INVALID_PROVIDER: "Enter a provider name between 1 and 60 characters.",
  DAEMON_NOT_AVAILABLE:
    "Build and bundle the Linux daemon on your panel deployment first. See docs/machines.md.",
  HTTPS_REQUIRED:
    "Connecting a VPS requires a publicly reachable HTTPS panel URL. Localhost is only reachable on your own computer.",
  MACHINE_LIMIT: "This deployment has reached its machine limit.",
  ENROLLMENT_NOT_PENDING:
    "This machine is no longer awaiting enrollment. Refresh the machine list to see its current status.",
  INVALID_OR_EXPIRED_CODE: "That code is invalid, expired, or already used.",
  SETUP_OR_RECOVERY_REQUIRED:
    "Your setup session expired. Request a new code from your deployment administrator.",
  LAST_PASSKEY: "Add another passkey before removing your last one.",
  REAUTH_REQUIRED: "Verify your identity with a passkey, then try again.",
  TOO_MANY_ATTEMPTS: "Too many attempts. Wait a minute, then try again.",
  PASSKEY_LIMIT: "You can register up to ten passkeys.",
  PANEL_INVALID_VERSION:
    "This repository has no valid recorded Ephor version. Follow the panel update setup guide.",
  PANEL_INVALID_CONFIG:
    "Choose your host and deployment method, then confirm the setup.",
  PANEL_UPDATE_BUSY:
    "Another update operation is in progress. Wait for it to finish or clear the current attempt.",
  PANEL_REPOSITORY_CHANGED:
    "The repository identity or production branch changed. Reconnect panel updates.",
  PANEL_USE_DEPLOYMENT_COPY:
    "Select your own Ephor deployment repository, not the official source repository.",
  PANEL_NOT_CONFIGURED: "Connect your panel deployment repository first.",
  PANEL_DEPLOYMENT_PENDING:
    "The previous update is not running yet. Check your host’s deployment before preparing another update.",
  PANEL_ALREADY_CURRENT:
    "Your repository already contains the latest tested version. Check deployment status if the panel is older.",
  PANEL_WORKFLOW_UPGRADE:
    "Your repository needs the latest Update Ephor workflow. Follow the older-installation instructions in the panel update guide.",
  PANEL_NOT_PREPARED:
    "The update is still being prepared or preparation failed. Check the workflow status.",
  PANEL_REVIEW_CHANGED:
    "The reviewed changes or production branch changed. Clear this attempt and prepare a new update. Repository rules may also require review in GitHub.",
  PANEL_MANUAL_REVIEW:
    "This update changes protected configuration or is too large for automatic review. Review it in GitHub.",
  PANEL_CHECKS_PENDING: "The update checks have not all passed yet.",
  PANEL_MERGE_BLOCKED:
    "GitHub blocked the merge. Resolve required checks or reviews, then retry.",
  UNAUTHORIZED: "Your session has ended. Please sign in again.",
};
export function errorMessage(code: string) {
  return (
    messages[code] ?? "The request could not be completed. Please try again."
  );
}
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    if (
      response.status === 401 &&
      (path.startsWith("/security") ||
        path.startsWith("/machines") ||
        path.startsWith("/services") ||
        path.startsWith("/integrations") ||
        path.startsWith("/panel") ||
        path.startsWith("/backups") ||
        path === "/session")
    ) {
      if (!location.pathname.match(/^\/(login|setup|recover)$/))
        location.replace("/login");
    }
    throw new Error(errorMessage(data.code));
  }
  return data as T;
}
export async function signIn() {
  const result = await authClient.signIn.passkey();
  if (result.error)
    throw new Error(
      result.error.message ?? "Passkey verification was cancelled or failed.",
    );
}
export async function addPasskey(name: string, createSession = false) {
  const result = await authClient.passkey.addPasskey({ name, createSession });
  if (result.error)
    throw new Error(
      result.error.message ?? "Passkey creation was cancelled or failed.",
    );
}
