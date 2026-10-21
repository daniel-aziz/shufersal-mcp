# Independent preimplementation baseline: fef067c

Snapshot: source/dist/tests copied before implementation into this directory. No changes to source repository, production registration, credentials, live cart, ledger, or locks. All writes used fixture adapters and temporary ledgers. Real SDK tools/list and tools/call executed through fresh stdio and in-memory MCP transports; local Chromium exercised the real live adapter against localhost.

## Demonstrated failures

1. **Existing cart product availability is bypassed.** `apply_shufersal_cart_targets` takes existing `milk` quantity 2 to 7 and returns `available:true` when exact-product adapter reports `false`, and independently when it reports `null`. Each case dispatches one write. Existing-row identity also loses equivalence metadata absent from the cart. Reproduce `node audit.mjs`; coverage labels `existing cart availability false/null`.
2. **Discovery truncates at 30 without pagination/coverage signal.** Actual MCP `search_shufersal` with a 31-result paginated endpoint returns only 30, strips pagination, and makes only `limit=30` request. Exact barcode input follows the same search endpoint and can return only unrelated suggestions; there is no exact lookup input/tool or continuation input. Reproduce `node browser-mcp.mjs`; request and response transcript in browser-mcp-coverage.json.
3. **Complete empty live cart unsupported.** Local live-adapter fixture with a unique cart container and explicit empty marker returns generic `SITE_CONTRACT_FAILED` after waiting for a product row. Fixture service accepts explicitly complete empty carts and rejects incomplete ones correctly; failure is live parser support. The chosen empty marker is synthetic, so actual production empty markup remains unverified.
4. **Stale ownership prevents all MCP discovery.** Temp `owner.lock` containing nonexistent PID 99999999 causes fresh stdio initialize to fail (`Connection closed`); direct helper reports ACCOUNT_LOCKED. This safely avoids writes but has no automatic safe recovery path. Reproduce `node stdio-extra.mjs` after `node audit.mjs`. Live stale lock untouched.
5. **Build identity absent.** Fresh stdio identifies only `shufersal-mcp-server` version `0.0.1`; no revision/artifact identity in tools inventory. Cannot distinguish changed builds through MCP discovery.
6. **Markdown table retains raw HTML.** Fixture ingredient `<script>alert(1)</script>|Milk` preserves the raw script tag; only pipe is escaped. This is unsafe output encoding relative to PDF free-text checklist; actual renderer execution was not tested.

## Passing evidence

Actual MCP calls verified 12+5=17, stable-ID retry dispatches once, new-row adds, complete-empty versus incomplete fixture cart, durable unresolved operation after session restart, scope-known uncertain SKU permits independent addition, unknown scope blocks all additions, changed approval rejects CART_CHANGED, explicit abandonment prevents replay, concurrent identical calls dispatch once, checkout disabled rejects submission, and missing-operation errors explain failures. Every repository tool (23) was called: authentication safely through unconfigured stdio; checkout/slot handlers only against fixtures.

Existing isolated suites: **53/53 nonbrowser and 5/5 Chromium tests passed**. These additionally exercise exact availability conflicts/wrong SKU/wrong sale unit/account changes, pack equivalence, recovery variants, and mutation readback. They are supporting regression evidence; most call the service/adapter directly rather than MCP and are not mislabeled as independent protocol scenarios.

## Approved registration and limits

Safely parsed only nonsecret config metadata: permanent enabled tools are exactly `open_shufersal`, `search_shufersal`, `get_shufersal_cart`, `plan_shufersal_replenishment`. Repository fixture inventory is 23. The permanent four-tool restriction is intentional, **not a defect**, and remains unchanged. No live session was started.

Description-only task selection used tools/list before implementation reading: read fresh cart, preserve operation ID, use absolute targets for replenishment, prepare/accept explicit recovery. Descriptions adequately guide that sequence; search does not disclose 30-result truncation or explain exact SKU lookup, and set-quantity/slot descriptions omit retry guidance. This verifier is the independent agent itself, not a second nested blind agent.

Reproduction files: inventory.mjs, audit.mjs, scope-mcp.mjs, browser-mcp.mjs, stdio-extra.mjs. Run from this directory; browser fixture requires permission for local Chromium/server. All transcript input/data are synthetic. coverage.json and scope-coverage.json include build, tool, input, expected, actual, before/after, writes and verdict. Browser transcript records fixture request paths and raw MCP responses.
