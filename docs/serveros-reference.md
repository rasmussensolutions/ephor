# ServerOS product reference

Reviewed 15 November 2026. Use ServerOS as a reference for how Ephor's flows fit together, while keeping Ephor's own implementation and permissions model.

| Area         | ServerOS behavior                                                                                                                                                                                                                    | Direction for Ephor                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Enrollment   | One expiring command connects a Linux/systemd machine, then users can deploy or manage services. [Quickstart](https://docs.serveros.com/guides/quickstart)                                                                           | One command prepares monitoring and deployments; machine settings handles recovery.                                                        |
| Integrations | GitHub is connected from Settings → General, with access limited to selected repositories. [Deploy your code](https://docs.serveros.com/guides/deploy-your-code)                                                                     | Keep GitHub and the optional remote build registry in Settings → Integrations.                                                             |
| Deployment   | A repository or zip becomes a build, a running instance, a health check, and finally a traffic switch. An unhealthy replacement leaves the old version serving. [Deployment flow](https://docs.serveros.com/guides/deploy-your-code) | Preserve Ephor's existing build and health-check flow; make progress and failure recovery clearer before adding more deployment inputs.    |
| Activity     | Records people and automatic events, retains former members' names, and supports actor, category, time, and machine filters plus CSV export. [Activity](https://docs.serveros.com/guides/activity)                                   | Ephor now records panel mutations with actor snapshots. Automatic lifecycle events and export are follow-up opportunities.                 |
| Operations   | Projects group services, staging copies environments, and workflows join scheduled or triggered steps. Teams have roles and permissions. [Official panel overview](https://github.com/serveroshq/panel)                              | These are future product areas, not part of the enrollment/settings change. Prioritize a dependable deploy → observe → recover loop first. |

## Architecture distinction

ServerOS documents a root daemon, machine-generated private key and panel-issued certificate, machine policies, and a `doctor` command. [Daemon installation](https://docs.serveros.com/guides/installing-the-daemon)

Ephor keeps an unprivileged monitoring agent and a separate root-owned deployment worker. The user can still have one enrollment command without combining those privileges. Each component gets its own credential. This change follows that approach.

The ServerOS installation guide does not establish whether Docker/build tools are installed during enrollment or later when deploying. Ephor explicitly installs its required deployment tools during enrollment on Ubuntu/Debian, checks existing installations, and reports deployment readiness separately from monitoring. Automatic dependency installation follows [Docker's official apt setup](https://docs.docker.com/engine/install/ubuntu/).

## Suggested next work

1. Improve the deployment progress view around fetch, build, start, health check, and traffic switch, with a clear remedy when a step fails.
2. Add machine/worker diagnostics and automatic lifecycle events to Activity.
3. Build project-level app/database relationships and environment copying.
4. Add multi-user roles and authorization when team access is introduced; actor names are already captured in Activity.
