# Update your Cloudflare panel in the browser

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

Panel updates are separate from the signed daemon updates on the Machines page.
