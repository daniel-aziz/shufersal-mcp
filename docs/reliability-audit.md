# Reliability audit and verification boundary

## Requirements reconciled from Write MCP Plan (14 October 2026)

The supplied seven-page plan requires shared service-level business actions, agent description/input tests before changes and after pilot failures, retry idempotency, explicit outcomes and actionable errors, safe text rendering, server-derived identity/defaults, separate review/commit actions for irreversible work, untrusted-content handling, gated rollout, saved scenarios and independent execution of the whole workflow. Its diagrams explicitly separate the blind agent from implementation and judging.

For this standalone repository, `ShoppingService` and the journal are the shared business layer; the existing real MCP transport tests and Chromium localhost fixtures replace Novella's PGlite/DAL harness. There is no tRPC router or Novella feature-flag system to reuse here. Existing owner-approved recovery and disabled live checkout remain the gates. No automatic approval, write permission expansion, Playwright migration, or production purchase pilot is included.

The permanent client allows only `open_shufersal`, `search_shufersal`, `get_shufersal_cart`, and `plan_shufersal_replenishment`. The repository has 23 tools for isolated integration testing. A test harness exposing these tools on temporary fixture state does not grant production permission. Required production expansion must be reviewed separately.

## Baseline independently executed

A clean-context verifier copied build `fef067c` before changes, enumerated fresh MCP tools/list, and called all 23 repository tools via tools/call. The existing 53 service tests and five browser fixtures passed, yet independent scenarios reproduced: existing-cart availability bypass, autocomplete truncation/stripped coverage, unsupported empty cart parsing, stale-lock discovery failure, absent build identity, and raw HTML in shopping-list output.

The baseline separately confirmed the current existing-row 12+5=17 and new-row quantity paths, same-ID idempotency, scoped independent continuation, global blocking for unknown scope, durable restart, concurrent identical calls, changed recovery approval rejection and abandoned target protection. These passing behaviors must be retained, not rewritten based on old pilot reports.

## Verification protocol

Final verification uses fresh agents separate from implementation, real MCP handlers and controlled adapter responses. Every exposed tool must have sanitized inputs, expected/actual results, build identity, environment, before/after state and PASS/FAIL/BLOCKED evidence. Chromium fixtures exercise the actual adapters, but do not establish production write correctness.

Required scenarios include stock unavailable/unknown/conflict, exact SKU/unit mismatch, pack overlap, explicit empty vs incomplete reads, pre-dispatch timeout, lost response after application, crash/restart, stale locks and concurrent ownership claims, retries, concurrent target/unrelated edits, changed snapshots, abandoned targets, and independent items continuing after isolated uncertainty. Product text and formatting include injection/markup cases. Descriptions are retested as agent-facing inputs.

Live purchases, delivery reservations, credential/permission changes, ledger deletion and cart writes are prohibited in this audit. Live cases needing those actions are BLOCKED, never silently counted as passed. Saved profile ownership must be verified before any live browser use. Legacy locks require an explicit supported recovery decision; tests do not remove them just to obtain coverage.

## Operational guides

- [Lock inspection, audited recovery and build identity](ownership-build.md)
- [Adapter identity, completeness and remaining live-contract limits](adapter-reliability.md)
- [Scoped operation queue and recovery](cart-workflow-contract.md)

Passing fixture tests cannot prove live server quantity semantics or atomic concurrency. Keep owner confirmation for recovery and checkout disabled until their separate live validation is authorized. Reconnect clients after a rebuild and inspect the build resource rather than assuming a running process loaded new code.
