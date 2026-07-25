# IMGent architecture audit

> Audit date: 2026-07-26
> Scope: product/design documents, all production TypeScript, tests, package graph, and executable
> smoke paths.

## Outcome

The implementation now has one runtime owner, one explicit diagnostic boundary, one fresh schema,
and fewer framework/compatibility layers. The refactor removed 291 production TypeScript lines,
2 direct runtime dependencies, and 47 installed dependency packages while preserving the
workspace boundaries that correspond to real alternate implementations.

Ranked findings use Ponytail's deletion-first labels:

1. `delete:` Health and status requests synchronously triggered platform, account, and model probes; they now return a cached runtime-readiness snapshot, while `doctor` alone invokes `/v3/diagnostics`.
2. `delete:` Legacy migration code preserved pre-release layouts and error translation; current
   schema v7 initializes only an empty data directory and rejects any other version unchanged.
3. `native:` Fastify served two loopback GET endpoints; `node:http` now provides the complete health surface without a framework dependency.
4. `delete:` ICU formatting and message/action parameter types had no current dynamic messages; catalogs are static, brace-free, and no longer depend on `intl-messageformat`.
5. `shrink:` Online and offline administration duplicated identities, groups, status, and database-count SQL; both now call the same read-only query functions.
6. `shrink:` Database opening, schema validation, and media retention obscured the transaction-oriented store; they now live in focused storage modules without adding a repository/interface hierarchy.
7. `shrink:` The executable entry mixed shebang/bootstrap with 800 lines of command construction; `main.ts` is now a five-line entry and `program.ts` owns the existing command surface.
8. `delete:` Redundant profile foreign keys and unique indexes encoded facts already implied by principal/task/space relations; schema v4 removes them and uses foreign-key joins as the source of truth.
9. `performance:` Due-work indexes now match task, outbound, and memory-outbox claim predicates; tests assert SQLite chooses those indexes with `EXPLAIN QUERY PLAN`.
10. `keep:` Adapter and driver workspace packages each have two real implementations and a shared contract, so flattening them would erase a useful compile-time boundary.
11. `keep:` The small driver-local async queues remain duplicated; a shared package or generic concurrency abstraction would cost more coupling than the repeated code.
12. `keep:` The command program remains one module for now; splitting registration into speculative command-context layers would move lines without reducing state or behavior.

## Architecture after refactoring

```text
short-lived CLI
  -> ControlClient -> /v3 control server -> AdminService -> shared admin queries
  -> OfflineAdminService ------------------------------^  (only with ownership lease)

healthz / readyz -> cached runtime readiness
status           -> cached runtime readiness + persistent/runtime facts
doctor           -> explicit diagnostic refresh -> platform/account/model probes

IMGentApplication -> domain services -> IMGentStore
                                  storage/database.ts -> open + schema validation
                                  storage/media.ts    -> media retention
```

The service lifecycle owns the public starting/ready/degraded/stopping states; the application uses
a smaller created/running/closed guard for resource ownership. Runtime readiness uses a
single-flight refresh so startup and maintenance cannot duplicate probes. The status and health
DTOs remain separate: the loopback health surface cannot accidentally inherit management data.

### Post-audit identity and memory extension

The 2026-07-26 extension keeps the same runtime and storage ownership boundaries:

- `AgentTurnInput` now requires one provider-neutral context contract; Codex and Claude Code share
  one formatter instead of duplicating attribution logic.
- Stable short person/conversation references are derived from existing Principal and
  ConversationSpace facts. No raw platform identity is exposed to the Agent and no identity cache
  or second directory was added.
- Hybrid recall and Curator recent-window reads query existing `memory_records` and `tasks`.
  SQLite FTS5 remains authoritative, and strict scope predicates remain in the Memory Service.
- Memory audit uses the existing AdminService/OfflineAdminService split and additive read-only
  Control v3 routes. Online CLI never opens SQLite; offline CLI still takes the ownership lease.
- Schema v7 adds only the two indexes required by the measured Curator recent-window and memory
  audit paths; it adds no compatibility branch, vector store, or public management server.

## Data model and state

Schema v7 treats configuration as the authority for profiles, bots, routes, and static policy.
SQLite stores runtime facts and references stable configuration IDs only where the relation cannot
be derived. Principal, conversation-space, and task relations now determine the profile for group
authorizations, sessions, and approvals.

Claimable work is modeled as persisted state plus `next_attempt_at`; partial indexes contain only
claimable statuses and preserve creation order while retaining due time. Memory search remains FTS5
with generated search text, and the service remains the sole online SQLite owner.

No schema migrator remains. This is intentionally less extensible than a generic migration engine:
the current product accepts destructive pre-release changes, and retaining unexecuted compatibility
code would be a maintenance liability. A future released schema change should add a migration only
when there is actual supported user data to preserve.

## Performance and complexity evidence

| Measure                       |            Before |        After |               Change |
| ----------------------------- | ----------------: | -----------: | -------------------: |
| Production TypeScript         |      12,857 lines | 12,566 lines |                 -291 |
| Direct runtime dependencies   |                 9 |            7 |                   -2 |
| Installed dependency packages | baseline lockfile | baseline -47 |                  -47 |
| CLI executable entry          |         807 lines |      5 lines |                 -802 |
| Schema compatibility paths    |     v1-v6 layouts |      v7 only | legacy paths removed |

The line count excludes generated `dist` declarations. Moving command registration into
`program.ts` is not counted as a line reduction by itself. The dependency-package result is the
pnpm lockfile delta after removing Fastify and `intl-messageformat`.

Latency-sensitive request paths no longer await network or subprocess model probes. On the
validation host, an in-memory schema-v4 fixture with 10,000 queued tasks executed the actual
candidate-selection query 1,000 times in 9.74 ms total (0.0097 ms/query after warm-up). The plan
scanned `tasks_claim_idx`, used `tasks_fifo_idx` for both correlated guards, and used the inbound
primary-key index without a temporary sort. Query-plan regressions are executable assertions rather
than timing gates, which avoids machine-dependent CI failures. Full-suite wall-clock changes are
reported only as smoke evidence, not as an architectural speed claim.

Schema v7 also asserts that Curator recent-window reads use `tasks_recent_context_idx` and default
memory audit pagination uses `memory_audit_idx`; both remain ordinary SQLite indexes and preserve
FTS5 as the only lexical retrieval engine.

## Remaining intentional complexity

- The resident service, dual-mode CLI, and ownership lease are necessary to guarantee one online
  SQLite owner; removing the local control plane would reintroduce cross-process state races.
- QQ and WeChat differ materially in transport, authorization, media, checkpoint, and group
  semantics; a generic transport framework would hide rather than remove those differences.
- Codex app-server and Claude Agent SDK have different wire/session semantics; the shared driver
  contract is the appropriate abstraction level.
- Windows Named Pipe access control needs Windows release smoke. Linux validation proves naming
  and protocol behavior, not the Windows ACL boundary.
- Real Claude model execution remains outside automated validation; mock/contract evidence must not
  be presented as a live Claude smoke.
