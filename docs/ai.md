# AI integration

In **Settings → Integrations → AI provider**, connect an OpenRouter API key and choose a default model. The initial default is `~anthropic/claude-sonnet-latest`. The model picker loads OpenRouter’s text models and also accepts model IDs manually.

**Connect & verify** (or **Save & verify**) makes a small completion request to the selected model. Verification is billed by OpenRouter. Only a successful response saves the connection. Existing keys can be kept by leaving the key field blank. Credential changes and disconnecting require the same fresh passkey authentication as other integrations. Keys are encrypted in `ephor_integration` using the existing integration secret storage; read responses never include a key.

For a failed repository build, **Diagnose** appears in the first-deployment log toolbar and the historical build inspector when the integration is verified. Clicking sends that attempt’s saved build logs and selected configuration to OpenRouter. The answer appears in a dialog with the responding model. Closing and reopening the dialog reuses its answer during that mounted view; refreshing the page does not persist the answer.

The API loads the build by service and build ID and requires a failed status. It uses the encrypted configuration and source snapshot of that attempt, rather than browser-supplied logs. Context includes repository/branch/commit, build context and Dockerfile, resource limits, architecture, build phase/error, and recent logs. It excludes environment values and registry credentials, and redacts known historical/current secret values and common credential patterns from logs and replies. This is best-effort redaction: avoid writing sensitive data to application logs. Logs are untrusted data in the system prompt. The model has no tools and cannot apply changes.

Requests are limited to five verifications and five diagnoses per minute per panel. Requests have a timeout; diagnosis output is capped. Provider credentials, credits, model, and temporary provider errors have distinct UI messages. A failed verification preserves the saved connection, and an in-flight verification cannot undo a disconnect. No requests are made automatically to diagnose builds.

Endpoints (all owner-authenticated):

- `GET /api/integrations/ai` — connection status, model, verification time
- `GET /api/integrations/ai/models` — text model IDs
- `POST /api/integrations/ai/connect` — verify and save `{ provider: "openrouter", apiKey, model }`
- `POST /api/integrations/ai/disconnect` — remove the saved credential
- `POST /api/services/:id/diagnose-build` — diagnose `{ buildId }`

The connection is reusable for future panel AI features. This version supports OpenRouter and failed build diagnosis; general chat, deployment-error diagnosis, automatic fixes, and persistent diagnosis history are not implemented.

Provider references: [chat completions](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion), [models](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties), [Claude Sonnet Latest](https://openrouter.ai/~anthropic/claude-sonnet-latest).
