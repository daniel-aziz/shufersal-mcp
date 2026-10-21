# Independent ownership and build verification

Candidate 9230633aefe5ea66d8f36c2ba4e8b7c615fbd2bc / e11984cf2bd6c106bfad592b2effa27f615c749e667c4fc0444ae69362d92618

All state synthetic in dedicated temporary directory. No shared build or production state changed.

|Scenario|Expected|Verdict|
|---|---|---|
|unlocked CLI|unlocked then already_unlocked, pending preserved|PASS|
|live owner refuses recovery and duplicate acquisition|OWNER_ALIVE and ACCOUNT_LOCKED|PASS|
|killed child recovery archives lock preserving pending ledger|absent process and audited recovery|PASS|
|foreign host|OWNER_UNVERIFIED and unchanged owner|PASS|
|reused PID|OWNER_ALIVE and unchanged owner|PASS|
|malformed|OWNER_UNVERIFIED and unchanged owner|PASS|
|legacy unapproved|OWNER_UNVERIFIED and unchanged owner|PASS|
|legacy reviewed fingerprint and provenance confirmation|wrong fingerprint refused, correct fingerprint recovers|PASS|
|legacy dangling browser lock|BROWSER_OWNERSHIP_UNVERIFIED|PASS|
|interrupted recovery without owner|recovery_blocked, RECOVERY_LOCKED, acquisition blocked|PASS|
|release after owner replacement|OWNERSHIP_CHANGED, replacement retained|PASS|
|concurrent acquisitions|exactly one owner|PASS|
|concurrent CLI recovery|one archive, others blocked or already unlocked|PASS|
|fresh MCP discovery, build resource, actual safe tool calls|exact candidate identity; complete discovery; safe tool response|PASS|
|running identity versus changed installed copy and reconnect|old running identity retained; mismatch shown; reconnect loads new build|PASS|

See matrix.json for commands, environment, results, and before/after SHA-256 evidence.

Additional valid cart/search/plan calls PASS: cart and plan return sanitized SITE_PROFILE_REQUIRED guards; search succeeds via public catalog fallback with one product. No live account/cart correctness is claimed.

Supporting suite: TMPDIR set to verifier directory; node --test tests/ownership-build.test.mjs: 6 passed, 0 failed.

Sandbox-only initial recovery returned OWNER_UNVERIFIED because ps was denied. The same isolated command with approved process-inspection access passed.
