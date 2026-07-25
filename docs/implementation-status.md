# IMGent implementation status

> Snapshot: 2026-07-25
> Runtime baseline: Node.js 24.18.0+
> Release channel: Changesets `alpha`; initial public line `0.2.0-alpha.x`

IMGent is implemented as one publishable package and one `imgent` executable. `imgent start`
is the resident service; every other invocation is a short-lived CLI. The resident service is
the sole online owner of SQLite, credentials, adapters, drivers, queues, and the immutable skill
snapshot.

The repository keeps the package boundaries that have real alternate implementations:

- `packages/im-adapters`: QQ and WeChat iLink.
- `packages/agent-drivers`: Codex and Claude Code.
- `packages/contracts`: the types and stable error descriptors shared across those packages.
- `src`: composition, CLI/control/health surfaces, domain services, storage, backup, and runtime.

There is no dynamic plugin market, remote control API, daemon binary, hot reload, cloud memory,
or vector database.

## Release posture

The public package is intentionally an alpha rather than a stable release. Documentation installs
`imgent@alpha` and states that compatibility and production readiness are not guaranteed.
Changesets owns version calculation through `.changeset/pre.json`; versions are not edited
manually.

The publish workflow tests the source and packed artifact before publication. After publication it
reconciles npm dist-tags so the prerelease channel points to the exact published version, removes
`latest` only when it points to a prerelease, and installs the exact registry version through the
same package smoke. A future stable release requires explicitly exiting Changesets prerelease mode.

## Current architecture

- The control plane is HTTP/JSON protocol v3 over a protected Unix socket or user-scoped Windows
  Named Pipe. All routes use `/v3`; incompatible clients fail explicitly.
- `/healthz`, `/readyz`, `status`, and the readiness control route only project a cached runtime
  snapshot. They never perform vendor network, account, or model probes on the request path.
- `doctor` is the explicit diagnostic boundary. Online it calls `POST /v3/diagnostics`; offline it
  runs the restricted environment checks without constructing adapters.
- Runtime readiness is refreshed during startup and maintenance with single-flight coordination.
  Diagnostic checks have a separate depth and timeout.
- The health server uses Node's `node:http`; no web framework is present.
- Online admin reads share the same query functions as the restricted offline admin service.
- `src/cli/main.ts` is only the executable entry; command construction lives in
  `src/cli/program.ts`. A new command-registration abstraction was deliberately not added.

The service lifecycle explicitly owns `starting`, `ready`, `degraded`, `stopping`, and `stopped`;
the application separately guards resource ownership with `created`, `running`, and `closed`.
Shutdown remains idempotent, and endpoint cleanup happens on partial startup failure.

## Persistence and compatibility

The current SQLite schema version is 5.

- Only an empty data directory can create schema v5.
- Any existing non-v5 database fails with `STORAGE_SCHEMA_UNSUPPORTED` and remains unchanged.
- There is no v1-v4 migration chain or pre-migration backup path.
- Redundant `agent_profile_id` columns were removed where the profile follows from a referenced
  principal, task, or conversation space.
- Duplicate unique indexes were removed. Due-work indexes match task, outbound, and memory outbox
  claim predicates.
- Database open/schema validation and media cleanup are separate storage modules; the store keeps
  transaction-oriented domain operations.
- Schema v5 adds persistent schedule definitions and runs, and separates a task's IM conversation,
  execution-serialization key, and optional Agent session key.

## Scheduled Agent tasks

- `imgent conversation list` discovers stable delivery targets and eligible Principals.
- `imgent schedule` supports one-shot RFC 3339 times and five-field cron expressions with IANA
  timezones, plus list/update/pause/resume/remove/run/reset-context/history.
- The resident `SchedulePlanner` atomically advances a due definition and creates at most one task
  per `scheduleId + scheduledFor`. Missed recurring work coalesces to one catch-up; overlap is
  skipped and counted instead of building a replay backlog.
- `fresh` turns are ephemeral and never load or save a vendor session. `series` turns use a
  schedule-only session key; neither mode reuses the target conversation's ordinary session.
- Scheduled turns can recall permitted IMGent memory but do not enter automatic curation.
- Results, approvals, and questions omit reply context and use proactive delivery. The existing
  Adapter capability contract rejects unsupported targets before work is accepted; QQ supports
  this path and current WeChat iLink does not.
- Scheduling is a host/runtime feature. No built-in skill was added.

Backup format is `imgent-backup/v2`. Restore validates its manifest and checksums; backup v1 is
rejected. Archives contain IMGent configuration, local encrypted platform credentials, the SQLite
snapshot, and user skills, but never external Codex or Claude authentication directories.

These are intentional breaking changes. There is no compatibility alias or automatic conversion
for old databases, backup archives, or control DTOs.

## Errors and localization

Stable `DOMAIN_SUBJECT_REASON` error codes and `IMGentError` remain the protocol contract. Error
descriptors never expose cause, stack, SQL, local paths, message content, tokens, reply context, or
raw vendor responses.

The `zh-CN` and `en-US` catalogs now contain static audited messages. Unused dynamic message/action
parameter plumbing and the ICU runtime dependency were removed. Catalog validation checks exact key
parity and rejects template braces.

## Validation coverage

The automated suite covers:

- strict configuration and capability routing;
- schema v5 creation, legacy-schema rejection without mutation, foreign keys, FTS5, and query plans;
- schedule timing, proactive capability rejection, fresh/series session isolation, run history,
  and proactive outbound envelopes;
- atomic inbound/task/outbound flows, FIFO, retry safety, cancellation, and dead letters;
- pairing, identity binding, group authorization, approval ownership, and idempotency;
- skill validation, profile filtering, immutable startup snapshots, and read-only materialization;
- memory scope isolation, Chinese/mixed FTS5, curation retry, and retention;
- QQ/WeChat payload and runtime-readiness behavior;
- Codex/Claude protocol contracts, including the runtime-versus-diagnostic readiness split;
- cached health/readiness responses and explicit diagnostic refresh;
- control protocol/instance mismatch, no offline fallback, endpoint permissions, ownership leases,
  configuration drift, lifecycle cleanup, and two-process service/CLI behavior;
- backup v2 checksum, permissions, online/offline ownership, restore, and v1 rejection.

The package verification builds the npm tarball in an empty installation and checks the executable
surface. A real local Codex app-server smoke validates initialize, login status, a new thread, a
turn, and final output.

Windows Named Pipe ACL and Windows Service identity remain platform release gates and are not
proven by Linux CI. Claude Code is covered by build and mock/contract tests; a real Claude model
call is not part of the automated evidence.

The ranked architecture findings and measured simplifications are recorded in
[architecture-audit.md](architecture-audit.md).
