# Ownership, crash recovery and installed build

Use the **same configuration and state directory as the running MCP**. Do not create a new ledger to escape a pending operation. The permanent client registration intentionally permits only `open_shufersal`, `search_shufersal`, `get_shufersal_cart`, and `plan_shufersal_replenishment`; these commands do not expand it.

MCP initialization, tool discovery and build-resource reads do not acquire the account lock. Every shopping/authentication business operation acquires it through the service queue, keeps it across all reads, writes, verification and journal persistence, and closes its browser before releasing it in cleanup. Idle MCP connections therefore do not block other tasks. Competing active calls return `ACCOUNT_LOCKED`; wait for the current operation to finish, then reassess (reuse the same operation ID and payload for write retries). There is no automatic replay or force-unlock.

Success and ordinary errors both release ownership after verified browser cleanup. Uncertain writes stay pending in the durable ledger and retain their existing scope/replay guards. A browser-cleanup failure returns `BROWSER_CLEANUP_FAILED` and retains ownership: releasing while browser activity might continue is unsafe. SIGINT/SIGTERM/stdin closure drain the active operation and reject queued work. Cancellation or a client timeout alone cannot prove a dispatched write stopped. SIGKILL, power loss and a hung operation cannot reliably execute cleanup; use the audited stale-owner recovery procedure after verifying the owner is dead.

The browser closes between calls and reuses its saved profile on the next call; `open_shufersal` checks access/authentication rather than leaving a window open. A rebuild does not change an already-running legacy process: reconnect it normally to load operation-scoped ownership. No desktop configuration change, tunnel or extra permanent connection is needed.

Inspect: `node dist/recover-lock.js --inspect` (read only). With no owner lock it returns `unlocked` and the pending operation IDs; recovery returns `already_unlocked` without changing history. An interrupted recovery marker still blocks even when the owner lock is absent. If the owner is provably dead, run `node dist/recover-lock.js --recover`. A live/reused PID, another host, malformed ownership, unreadable ledger, or interrupted recovery is blocked. An error in a tool does not justify releasing a live worker's lock: disconnect its MCP normally first. Never kill a process or delete lock files merely because it appears stuck.

Older PID-only locks require a human to confirm that the lock originated on this computer. After inspection, run:

```sh
node dist/recover-lock.js --recover --expected-lock-sha256 REVIEWED_HASH --confirm-legacy-local-owner
```

This confirms **ownership provenance**, not any cart outcome. It still requires an absent PID, no browser profile `SingletonLock`, and valid operation history. If the browser lock exists, close and verify its owning browser; do not delete it blindly. If the PID is reused by a living process, recovery remains blocked. An interrupted `owner-recovery.lock` requires investigation of its owner and archive/audit before any manual action; this CLI offers no force-unlock.

Recovery archives the original lock and writes a durable `owner-recovery-ID.json` audit with ledger digest and pending IDs. It never changes operations or resolves uncertain writes. Concurrent recovery is exclusive, acquisitions recheck the recovery marker, and release verifies its exact original ownership record.

`npm run build` generates `dist/build-info.json`: Git commit, dirty state at build time, build timestamp, source digest, compiled digest and stable build ID. MCP initialize reports the build ID suffix; the read-only `shufersal://build` resource reports captured running-build metadata plus current installed metadata and `runningBuildMatchesInstalled`. A rebuild never relabels an already-running process as the new build. This adds no tool or client permission. Dirty metadata is intentional for an uncommitted build; use a clean committed build for final validation. A packaged install without sources reports `sourceMatchesBuild: null` rather than claiming freshness.

After a rebuild, disconnect/reconnect Dot so its process loads the new JavaScript, then inspect initialize/build resource and enumerate `tools/list` in that fresh session. Discovery proves registration, not successful tool behavior. Read-only live checks and isolated mutating integration tests must be recorded separately. The build metadata hook runs only in `npm run build`; `tsc --watch` alone does not create fresh provenance.
