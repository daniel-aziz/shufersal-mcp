# Ownership, crash recovery and installed build

Use the **same configuration and state directory as the running MCP**. Do not create a new ledger to escape a pending operation. The permanent client registration intentionally permits only `open_shufersal`, `search_shufersal`, `get_shufersal_cart`, and `plan_shufersal_replenishment`; these commands do not expand it.

Inspect: `node dist/recover-lock.js --inspect` (read only). With no owner lock it returns `unlocked` and the pending operation IDs; recovery returns `already_unlocked` without changing history. An interrupted recovery marker still blocks even when the owner lock is absent. If the owner is provably dead, run `node dist/recover-lock.js --recover`. A live/reused PID, another host, malformed ownership, unreadable ledger, or interrupted recovery is blocked. An error in a tool does not justify releasing a live worker's lock: disconnect its MCP normally first. Never kill a process or delete lock files merely because it appears stuck.

Older PID-only locks require a human to confirm that the lock originated on this computer. After inspection, run:

```sh
node dist/recover-lock.js --recover --expected-lock-sha256 REVIEWED_HASH --confirm-legacy-local-owner
```

This confirms **ownership provenance**, not any cart outcome. It still requires an absent PID, no browser profile `SingletonLock`, and valid operation history. If the browser lock exists, close and verify its owning browser; do not delete it blindly. If the PID is reused by a living process, recovery remains blocked. An interrupted `owner-recovery.lock` requires investigation of its owner and archive/audit before any manual action; this CLI offers no force-unlock.

Recovery archives the original lock and writes a durable `owner-recovery-ID.json` audit with ledger digest and pending IDs. It never changes operations or resolves uncertain writes. Concurrent recovery is exclusive, acquisitions recheck the recovery marker, and release verifies its exact original ownership record.

`npm run build` generates `dist/build-info.json`: Git commit, dirty state at build time, build timestamp, source digest, compiled digest and stable build ID. MCP initialize reports the build ID suffix; the read-only `shufersal://build` resource reports captured running-build metadata plus current installed metadata and `runningBuildMatchesInstalled`. A rebuild never relabels an already-running process as the new build. This adds no tool or client permission. Dirty metadata is intentional for an uncommitted build; use a clean committed build for final validation. A packaged install without sources reports `sourceMatchesBuild: null` rather than claiming freshness.

After a rebuild, disconnect/reconnect Dot so its process loads the new JavaScript, then inspect initialize/build resource and enumerate `tools/list` in that fresh session. Discovery proves registration, not successful tool behavior. Read-only live checks and isolated mutating integration tests must be recorded separately. The build metadata hook runs only in `npm run build`; `tsc --watch` alone does not create fresh provenance.
