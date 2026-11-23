# Update your Ephor panel

## Update from inside Ephor

The **Updates** page can prepare, review, and merge updates to your own GitHub
repository. It works with public and private deployment copies, including copies
with unrelated Git history. It selects the latest official `main` commit that
passed CI; it does not automatically install untested changes.

### Connect once

1. Open **Updates → Connect GitHub**. Create the suggested **Ephor Updates** App,
   then install it with access to **only your panel deployment repository**.
   This connection is separate from the read-only App used to build applications.
   No manually copied keys, personal tokens, or Cloudflare/Railway API tokens are
   needed. GitHub consent screens are part of this one-time setup.
2. Return to Ephor and click **Finish connecting**. Select your GitHub account,
   deployment repository, hosting provider, and deployment method.
3. Confirm that the repository's default branch is your production branch and
   that the deployment arrangement below matches your installation, then save.
   Your host is suggested when detected, but hosting a Worker or Railway service
   alone does not prove Git deployments are configured.
4. Enable GitHub Actions in the repository and permit the updater's requested
   workflow permissions. Organization policies can require administrator approval.

The Updates App requests Contents, Actions, and Pull requests write access plus
Checks and Commit statuses read access. Its private key is encrypted in Ephor's
existing integration store. Short-lived operation tokens are scoped to the chosen
repository; they never reach the browser or GitHub Actions. Service builds continue
using read-only tokens from the separate service App. The updater workflow keeps
using its repository's temporary `GITHUB_TOKEN` to prepare a branch; Ephor creates
the pull request with its App token so checks can run without workflow-created-PR
approval prompts. Repository protection rules and required human reviews still apply.

### Hosting arrangements

| Hosting                                                                           | Choose                        | What happens after installation                                                                                                                                          |
| --------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cloudflare Workers + D1 with Workers Builds                                       | My host deploys GitHub pushes | A merge starts the configured build and deploy command, including D1 migrations. Disable preview builds against production data.                                         |
| Railway connected to GitHub                                                       | My host deploys GitHub pushes | A merge triggers autodeploy. Configure `bun apps/server/dist/auth.js migrate` as the pre-deploy command and retain PostgreSQL and the existing secrets.                  |
| VPS / Docker with an existing Git deployment pipeline                             | My host deploys GitHub pushes | Your pipeline builds the new code/image, applies migrations, and restarts the panel. Only the production branch should deploy.                                           |
| VPS / Docker, CLI-deployed Worker, Railway image deployment, or other manual host | I deploy updates manually     | Ephor updates the repository; deployment is an explicit operator step. The UI says **Merge update for manual deployment** and does not claim that the panel has updated. |

For a conventional VPS, merging a GitHub pull request cannot restart a process or
replace a container by itself. Configure a deployment pipeline once to get routine
updates entirely from the panel, or retain manual deployment. Ephor does not mount
the Docker socket, accept arbitrary deployment shell commands, or execute a local
`git pull` inside a running Worker/container. Split frontend/API deployments must
deploy both from the same source revision; the version check confirms the API's
bundled upstream version, and the browser must reload the updated frontend.

### Install an update

1. Click **Check for updates**, then **Prepare update**.
2. After preparation finishes, click **Review update**. Ephor opens the update PR
   through its App, starts repository checks, and displays the changed files and
   available diffs. Review database migrations and any files whose diff is not
   available in the panel using the GitHub link.
3. Wait for checks to pass, confirm a usable database backup/recovery point, and
   click **Install update** (or **Merge update for manual deployment**). Confirm
   the operation with your passkey.
4. Watch deployment status in Ephor. A merged repository is distinct from a
   running update: **Updated** appears only when this API is serving the target
   upstream version. Reload the panel afterward to load the new dashboard.

The update locks its official target, production base, and reviewed head. Changed
branches, failed checks, repository approval rules, conflicts, protected hosting
configuration, or edits to existing migrations stop installation. There is no
automatic bypass of branch protections. The GitHub links expose preparation logs
and any required manual review. If the new version does not appear, check your
host's deployment logs; a code rollback does not reverse database migrations.

**Clear attempt** forgets local progress only. It does not cancel workflows,
close PRs, delete branches, or roll back deployments. Resolve those in GitHub or
your host before retrying. Disconnecting the Updates App likewise leaves already
started external work running. The hosting repository remains independent of the
official repository until you explicitly install an update.

### Older installations

Install the version that adds the Updates page once using the existing GitHub
workflow or your normal deployment process, including its database migrations.
Also copy the current `.github/workflows/update-ephor.yml` and
`scripts/update-ephor.py` from the official repository into your deployment copy
using GitHub's file editor. The workflow must contain `# ephor-panel-protocol: 1`.
Automation files are deliberately preserved by ordinary updates, so upgrading the
panel code alone does not upgrade an old updater workflow. Review future updater
and workflow changes separately. Keep your existing `.ephor-upstream.json` value;
never substitute a guessed upstream base.

## Alternative: update through GitHub in your browser

Your deployment repository is an independent copy. Updating the official Ephor
repository does not update your panel until you choose to merge an update.
This workflow works in public or private GitHub repositories without a personal
access token, a Cloudflare API token, or a local checkout.

## One-time setup

In your deployment repository, open **Settings → Actions → General**:

- Enable GitHub Actions if necessary and allow the actions used by this repository.
- Under **Workflow permissions**, enable **Allow GitHub Actions to create and
  approve pull requests**. The workflow requests its own limited permissions;
  you do not need to make every workflow writable.
- An organization policy may require your organization administrator to enable this.

Keep **Cloudflare preview builds disabled**. The update branch is for review;
only merging into your configured production branch should deploy it. The GitHub
repository's default branch must be that same production branch.

New deployment copies include the updater. If you deployed before it was added,
use GitHub's file editor to copy these files from the official Ephor repository
into the same paths on your default branch:

- `.github/workflows/update-ephor.yml`
- `scripts/update-ephor.py`
- `.ephor-upstream.json`
- `.github/workflows/ci.yml` (uses standard GitHub runners in deployment copies)
- `scripts/tests/test_update_ephor.py`

The supplied starting version applies to the original browser-deployment template
at `f5bc4e25a1e4660d3eedc0b0793cb0f3d8224213`. If your copy was created from a
different version and does not already have the version file, set its `commit`
to the exact official commit your copy was based on. Do not guess this value or
replace an existing version file with the template's value.

## Install an update

1. In **Actions → Update Ephor**, click **Run workflow** on the default branch.
2. Open the pull request linked in the completed run's summary.
3. Review the changes, especially any new database migrations. Confirm you have
   a usable D1 recovery point or database export before proceeding.
4. If GitHub asks you to **Approve workflows to run**, approve the checks. Wait
   for them to pass, then merge the pull request in GitHub.
5. Watch the Cloudflare deployment finish, then open the panel and sign in.

The workflow selects the newest official `main` commit whose complete CI run
succeeded. A newer commit still being tested is not selected. The pull request
links the exact source commit. This is a tested-commit channel, not a promise that
every selected commit is a separately published release.

The owner account, machines and other stored data remain in the same D1 database.
Existing Worker secrets stay in Cloudflare. Keep `BETTER_AUTH_SECRET` unchanged;
owner setup is not repeated. Cloudflare applies new migrations during deployment.
The update workflow itself never connects to D1 or deploys a Worker.

## What is preserved and when updates stop

The updater uses the recorded official version as the base for a three-way merge,
including when Cloudflare created your copy with unrelated Git history. Local
files and compatible code edits are retained; upstream file deletions are applied
only when they do not conflict with local changes.

Both Wrangler configuration files remain byte-for-byte unchanged, including the
Worker name, database IDs, origin, custom routes and other settings. If the official
version changes these configuration files, automatic updating stops and requires
a manual configuration migration. Conflicting local code changes also stop the
update without changing your production branch.

Existing migration files cannot be changed or deleted by an automatic update.
New migrations still require review: preserving the database binding does not
make arbitrary schema changes reversible. Reverting the code does not roll back
a database migration; use D1 recovery/export procedures if necessary.

GitHub workflow files and the updater script itself are preserved. Updates to
those files require separate browser review and copying from the official repo;
the updater does not request the extra access needed to rewrite workflows.

An already-open update is linked instead of overwritten. If pull-request creation
is blocked, the run summary explains how to enable it or open the prepared branch
as a pull request manually. A previously closed update branch is left intact;
reopen its pull request or review it through the compare link in the run summary.
Private repositories use their own GitHub Actions allowance and organization policies.

Panel updates are separate from the unified component updates on each machine’s Maintenance tab.
