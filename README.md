# Shufersal MCP

A focused Shufersal tool server, forked from [matipojo/shufersal-mcp](https://github.com/matipojo/shufersal-mcp). Uses Puppeteer and one persistent browser session. Optional local 1Password sign-in is supported. Scheduling, Slack announcements, shopping policies and human approval belong in the calling application.

**Status:** the opt-in `live` adapter has been exercised against Shufersal for session reuse, search, cart reads, history, available windows, and reversible cart changes. Checkout is disabled. Live delivery selection and the final purchase page remain blocked pending their own validation. Current-cart address, selected window and substitutions are returned as `null` until mapped; totals remain marked estimated. Never use these results as a purchase-ready approval summary. See [the checklist](PROGRESS.md).

Set `SHUFERSAL_SITE_MODE=live` to use the observed adapter without a custom profile. The default `profile` mode retains the configurable synthetic/test adapter.

## Install and run

Requires Node.js 24 or newer.

```sh
npm ci --ignore-scripts
npx puppeteer browsers install chrome
npm run build
node dist/index.js
```

The server uses stdio. Stdout is reserved for MCP messages. It never exposes browser console logs, raw browser exceptions, cookies or password fields as resources.

Example MCP client configuration:

```json
{
  "mcpServers": {
    "shufersal": {
      "command": "node",
      "args": ["/absolute/path/to/shufersal-mcp/dist/index.js"],
      "env": {
        "SHUFERSAL_STATE_DIR": "/absolute/private/path/shufersal-account",
        "SHUFERSAL_SITE_PROFILE": "/absolute/private/path/site-profile.local.json"
      }
    }
  }
}
```

Never place credentials in this configuration. Configure `SHUFERSAL_AUTH_ACCOUNT`, `SHUFERSAL_AUTH_VAULT`, `SHUFERSAL_AUTH_ITEM` and optionally `SHUFERSAL_OP_EXECUTABLE` with local 1Password references. The provider signs in to the CLI and reads the item in memory only when the browser session requires it. An unlocked desktop app and its CLI integration are required; Touch ID authorization may be requested. Login challenges require human intervention. `open_shufersal` reports authentication only when a site profile supplies a verified authenticated-page marker; otherwise it reports `null`, not a guessed login state.

## Tools

Every shopping result is JSON text: `{ "ok": true, "result": ... }` or an MCP error with `{ "ok": false, "error": { "code", "message" } }`. Tool annotations distinguish reads and writes.

| Tool | Purpose |
|---|---|
| `authenticate_shufersal` | Reuse the saved browser session or sign in directly through the local 1Password provider |
| `open_shufersal` | Open a shopping page and report profile/authentication status |
| `search_shufersal` | Search through the current browser session; return product IDs, prices and selling methods |
| `get_shufersal_cart` | Read items, quantities, selling units, prices, substitution policy, address, delivery, total and revision |
| `add_to_shufersal_cart` | Add a quantity and verify the resulting quantity |
| `set_shufersal_cart_quantity` | Set an absolute quantity; zero explicitly removes that product |
| `get_shufersal_orders` | Read paginated order history and full details |
| `get_shufersal_order` | Find a specific order number in verified history |
| `get_shufersal_delivery_slots` | Read available windows with explicit timezone offsets |
| `select_shufersal_delivery_slot` | Select a slot and verify it in the cart |
| `prepare_shufersal_checkout` | Read the complete summary and possible duplicate order numbers |
| `submit_shufersal_order` | Submit the unchanged reviewed cart and verify a new matching order number |
| `get_shufersal_operation` | Inspect a saved operation's outcome |
| `reconcile_shufersal_cart` | Read the cart and record a verified postcondition when possible; never repeat the cart mutation |
| `reconcile_shufersal_checkout` | Resolve an uncertain checkout by reading history, without submitting again |
| `plan_shufersal_replenishment` | Plan absolute targets from history and office stock |
| `assess_shufersal_cart_recovery` | Compare an uncertain operation with fresh state |
| `prepare_shufersal_cart_recovery` | Prepare a snapshot and replacement targets for owner approval |
| `accept_shufersal_cart_recovery` | Record explicit approval while preserving uncertain history |
| `resume_shufersal_cart_recovery` | Add only the approved deficit using deterministic operation IDs |
| `get_shufersal_unresolved_items` | List pending identities, targets, scopes and sanitized evidence |
| `apply_shufersal_cart_targets` | Process absolute targets sequentially and report four result categories |
| `create_shopping_list_table` | Format an ingredient list locally |

All mutations require a fresh `expectedRevision` from `get_shufersal_cart` and a caller-generated UUID `operationId`. Reuse the exact same ID and arguments when checking a retry. Successful repeats return the saved result without repeating the write; changing arguments under an existing ID fails.

`submit_shufersal_order` also requires `confirmed: true` and operator configuration `SHUFERSAL_ENABLE_CHECKOUT=true`. The flag is an assertion from the trusted caller, **not authentication or proof of human consent**. The calling app must authorize the actor, obtain human approval, and bind it to the displayed revision. Expose this server only to trusted clients.

## Checkout and recovery

The revision covers the account, every line, quantities, unit/line prices, substitutions, address, delivery window, fee, total, currency and estimated-total status. The browser checks the final checkout summary again before clicking. Any mismatch prevents submission. Estimated totals are currently blocked; a caller-approved spending-cap workflow needs separate design before allowing weight-based checkout.

The service checks pending/confirmed orders for the same account, address and Israel delivery day. Possible duplicates block checkout even if totals differ. Cancelling an order or resolving a legitimate same-day second order is outside these tools.

Operations are recorded before the external write. A lost response, failed verification or crash leaves the operation pending. Known affected SKUs and equivalent packs are blocked; independent items may continue after verified complete reads. Unknown scope, integrity or checkout uncertainty blocks globally. Reads remain available. Never delete the journal to make a retry possible.

For uncertain checkout, call `reconcile_shufersal_checkout` with the original operation ID. It requires exactly one new pending/confirmed order with the same complete cart revision, excluding orders known before submission. If history is empty, delayed, incomplete, mismatched or ambiguous, it stays uncertain. Retry the **read**, not checkout. A successful click or empty cart is not sufficient proof.

For an uncertain cart write, call `reconcile_shufersal_cart`. It compares the target quantity and all other lines against the saved pre-write snapshot. It never adds, removes or changes products. Uncertain delivery writes and older journal records without recovery snapshots still need manual inspection. Preserve the record and original operation ID.

## Browser ownership and security

All MCP shopping operations run sequentially, including reads that navigate the shared page. An exclusive filesystem lock prevents two servers using the same state directory. It is intentionally not stolen after a crash. Confirm that the old process is stopped, inspect pending operations, and only then remove a stale `owner.lock` file. Keep `operations.json` intact.

Use **one state directory per account** and one active worker. A filesystem lock does not coordinate separate computers or unrelated state directories. The calling application must enforce ownership across remote/local runners. Stop the old worker before takeover, and reconcile uncertain operations first.

`SHUFERSAL_BROWSER_URL` can attach Puppeteer to an existing **loopback HTTP** Chrome debugging endpoint, sharing its default context while creating a separate shopping tab. Other automation, including Playwright, must use the same external coordinator; this server cannot lock independent clients or colleagues' browsers. It closes only its own tab and disconnects on shutdown when attached. Do not expose the debugging port publicly.

The dedicated profile and journal live outside the repository by default, under `~/.local/state/shufersal-mcp`. New directories/files use restricted permissions. Use encrypted disk storage; sessions are credentials and must not be uploaded as test artifacts. The journal stores operation fingerprints, status, verification results and order IDs, and pre-write cart snapshots for recovery, never passwords. These snapshots contain shopping/account data and must remain local with the same protection as the browser profile.

| Setting | Default |
|---|---|
| `SHUFERSAL_STATE_DIR` | `~/.local/state/shufersal-mcp` |
| `SHUFERSAL_CONFIG_FILE` | optional local JSON file containing non-secret configuration and vault references; environment overrides it |
| `SHUFERSAL_SITE_MODE` | `profile`; set `live` for the observed Shufersal adapter |
| `SHUFERSAL_SITE_PROFILE` | unset; required in profile mode |
| `SHUFERSAL_HEADLESS` | `false` |
| `SHUFERSAL_BROWSER_URL` | unset; launch dedicated browser |
| `PUPPETEER_EXECUTABLE_PATH` | Puppeteer's installed browser |
| `SHUFERSAL_ENABLE_CHECKOUT` | `false` |

No Slack, scheduling or office delivery preferences are embedded in the server. Replenishment suggestions are available through `plan_shufersal_replenishment`. Tuesday timing, the ₪100 warning and historical quantity checks belong in the private workflow. The server reads substitution policies but does not automatically choose replacements.

## Site profile and live verification

The profile schema is in `src/shopping/site-profile.ts`. `tests/browser/fixture.mjs` shows a complete **synthetic** mapping; its selectors are not Shufersal selectors. Do not copy them into production and assume they work.

A profile maps same-origin page paths, authenticated/ready markers, cart fields, line fields, quantity controls, order rows and pagination, delivery slots and the final checkout control. A field consists of a CSS selector and optionally an attribute name; otherwise text (or an input value) is read. Monetary fields must be unambiguous numbers, optionally with commas and ₪. Currency must be `ILS`; the estimate flag must be explicitly `true` or `false`. Use value-bearing attributes when visible text contains additional content. Slot timestamps must include UTC offsets. All required summary fields must be readable; missing data is an error, not a default zero or guessed value.

Before deployment:

1. Establish read-only access from the intended remote host; if blocked, use an authorized local worker. No cloud access is assumed.
2. Inspect authenticated pages and create a local profile outside Git. Confirm a complete cart, prices, substitution policy, address, total, history pagination and delivery windows against the UI.
   After local configuration, run `npm run auth` or `npm run verify:live`. The live check authenticates and calls only search/cart/history/slot reads, forces checkout off, and prints no account data. This check is deliberately excluded from CI.
3. Run supervised cart/delivery edits with permission. Verify changed quantities and totals, session expiry and concurrent edits. Shufersal's internal add endpoint comes from upstream and may change.
4. Keep checkout disabled until the final summary mapping and approval flow are verified. A real purchase needs separate explicit approval. Test an uncertain response using fixtures, not deliberate production duplicate attempts.

The final page can still change after it is read: Shufersal offers no verified atomic revision check here. Coordinate a no-edit checkout window with other users. The tools provide conservative guards, not an exactly-once guarantee from Shufersal.

## Tests and CI

```sh
npm run lint
npm test
npm run test:browser
# all of the above
npm run check
```

`npm test` builds TypeScript, exercises the service and durable journal, and calls registered tools through the real MCP client/server in-memory transport. Browser tests launch real Chromium against a local synthetic HTTP site. They never connect to Shufersal or use real credentials. Set `PUPPETEER_EXECUTABLE_PATH` if using an already-installed test browser.

GitHub Actions runs lint, build, service/MCP tests, browser fixtures, dependency audit and a package dry-run on Node 24 and 26. No account credentials are required. The upstream project had no CI pipeline; this is new.

## Compatibility changes

- `open_shufersal` no longer requires a fabricated shopping-list prerequisite.
- Cart additions now require `productId`, `sellingMethod`, `quantity`, `expectedRevision` and `operationId` (instead of `product_id` and `qty`). Unsafe legacy writes are not retained.
- Removed `console://logs` and raw console output.
- Removed the general-purpose `read_webpage_content` tool. Reading unrelated recipe sites should use a separate tool, not the authenticated shopping browser.
- Fixed the build entry point to produce `dist/index.js` as advertised.
- Updated the MCP SDK and Puppeteer and removed unused dependencies; the lockfile is committed.

## Local configuration example

Keep this JSON outside Git with owner-only permissions; values below are references, never passwords:

```json
{
  "SHUFERSAL_SITE_MODE": "live",
  "SHUFERSAL_HEADLESS": "true",
  "SHUFERSAL_ENABLE_CHECKOUT": "false",
  "SHUFERSAL_AUTH_ACCOUNT": "your-account.1password.com",
  "SHUFERSAL_AUTH_VAULT": "your-vault-id",
  "SHUFERSAL_AUTH_ITEM": "your-login-item-id"
}
```

Pass `SHUFERSAL_CONFIG_FILE=/absolute/private/path/config.json` in the MCP client environment or when running `npm run auth` / `npm run verify:live`. The same state directory is reused across browser restarts. Credentials are never MCP arguments or tool results. Local 1Password approval, MFA and CAPTCHA cannot be promised away for unattended runs.

The separate opt-in command `npm run verify:cart -- --allow-cart-changes` adds one low-cost test product, verifies idempotency/stale revisions, changes its quantity, removes it, and checks exact original-cart restoration. It forces checkout off. It writes an owner-only recovery baseline outside Git. On an uncertain outcome, it stops and reports the need to inspect/reconcile rather than repeating a mutation. Run only when colleagues are not editing the cart. CI never runs it.


## Replenishment with ChatGPT Dot

Dot owns execution and scheduling; no local scheduler is required. The existing Google Calendar Task remains unchanged. Use this workflow for each grocery cycle:

1. Read `get_shufersal_orders` and select 2–8 representative delivered office orders for the same account. Prefer recent orders when delivery dates are available. Never infer recency from listing order or order numbers. Ask which sample to use if office orders cannot be distinguished. Preserve the chosen sample for the cycle.
2. Call `plan_shufersal_replenishment` with `orderNumbers` and initially empty `stock`. It returns recurring products and missing stock questions. A regular product occurs in at least half the sample and at least two orders; its suggested target is the median quantity across the sample, including absent products as zero. This is a purchase-based suggestion, not a consumption forecast; unusual ordering intervals or bulk purchases need target overrides.
3. Ask one short stock question using product names and units. Map the answer to exact product IDs and selling methods. `remaining` is office stock, separate from items already in the cart. `target` optionally overrides the suggested total supply. Do not treat an omitted product as empty. Set `unlistedStockIsEmpty` only when the user explicitly says all remaining listed stock is empty. Clarify ambiguous brands, package sizes and fractional unit targets.
4. Replan with stock. The added quantity is `max(0, target - remaining - inCart)`. One-off purchases default to zero; a target override can include them. New products use search and the existing guarded cart tools. Resolve active orders before adding anything. `ready` means stock/quantity inputs are complete and no active order was found; it does not certify prices, availability or checkout readiness.
5. Search current products to verify exact IDs, selling methods, availability and prices. Flag prices over ₪100 per unit and unusual quantities/products for review; never silently select a replacement. Historical prices are not used for a current quote.
6. Re-read/replan if the cart has changed. Use `add_to_shufersal_cart` only for positive additions, sequentially. Start with the plan's `cartRevision` and use each successful write's returned revision for the next. Persist the UUID and exact arguments in Dot's cycle state before each call. Never decrease existing quantities or remove team items. On a stale revision, replan against the new cart; on an uncertain outcome, inspect/reconcile the original operation before doing more work. Retrying a completed operation uses its original UUID and arguments.
7. Read the final cart and return the actual items and total with unknown/estimated fields clearly marked. No Slack sends, delivery selection or checkout are part of this step. Final order approval remains separate.

The planning tool is read-only; it does not persist stock updates or purchase history in the repository. Dot must securely retain cycle context and operation IDs across its own restarts. The MCP's protected journal retains cart operation results. A request with unknown products, duplicate stock keys, duplicate order IDs, non-delivered orders or foreign-account orders is rejected.


### Cart quantities when money is unavailable

Live cart reads retain validated product IDs, selling methods, quantities and notes when prices or totals cannot be read unambiguously. Unavailable `unitPrice`, `lineTotal`, `deliveryFee` and `total` values are `null`, never substituted with zero or a calculated cart estimate. The existing `estimated` flag does not make null money values usable. The live adapter waits for product rows, rejects malformed/duplicate rows and fails closed when no product rows can be verified (an empty/loading container is not proof of an empty cart).

Cart-write verification and reconciliation compare quantities and non-monetary contents, account, address and selected delivery. Price refreshes cannot alone prevent reconciliation; changed/missing products, duplicate rows and uncertain outcomes still block it. Approval summaries and submission require all monetary fields to be present, and existing checkout restrictions remain in place. Reconciliation never repeats a write. Keep the existing operation ledger intact.


### Audited operator recovery

`assess_shufersal_cart_recovery` reports a pending operation's original/current/target quantities, latest revision and unrelated quantity changes. It does not change the cart or journal. Equal quantities alone do not prove whether an uncertain write occurred.

When server evidence cannot resolve the history, a local operator can explicitly retire the old intent and accept the current cart using `npm run recover:cart -- --operation <UUID> [--resolution <UUID>]`. Stop the MCP first, use its same private `SHUFERSAL_CONFIG_FILE`, and run this yourself in an interactive terminal. The command records OS operator identity and explicit uncertainty acknowledgements, rechecks the reviewed cart, and saves `resolved_by_operator` with historical outcome `unknown`. This terminal alternative performs no cart write. Dot can instead use the owner-approved MCP flow below. Never have an agent type the confirmation for you. The original operation ID cannot replay the add; other pending operations stay blocked. See [recovery evidence and operator procedure](docs/cart-recovery-proposal.md) for the trust boundary and failure handling.


### Owner-approved recovery in Dot

1. Call `prepare_shufersal_cart_recovery` with the pending `operationId` and `targets: [{productId, sellingMethod, quantity}]`. Quantities are **absolute desired cart quantities**, not amounts to add. It returns a fresh complete cart, `currentRevision`, differences and missing quantities. Missing money remains unavailable; this is not checkout approval.
2. Show the owner the full snapshot and targets. Ask for explicit approval to accept that revision as the baseline, retire the old intent with history still **unknown**, and add only missing quantities. Investigate outstanding requests first. General automation permission does not count as approval of this snapshot.
3. Call `accept_shufersal_cart_recovery` with `operationId`, a new stable UUID `resolutionId`, `expectedRevision: currentRevision`, `reason`, the same `targets`, and `ownerApproval: {confirmed: true, owner: "<owner identity>", approvalReference: "<owner message/reference>", acceptsUnknownOutcome: true, outstandingRequestsInvestigated: true}`. It re-reads twice, checks the ledger and persists `resolved_by_operator` plus the approved targets and snapshot. **It does not modify the cart.** A changed cart requires a new prepare and owner approval. Retry an identical acceptance after response loss using the same resolution ID and payload.
4. For each approved product, read `get_shufersal_cart`, reassess its missing quantity, then call `resume_shufersal_cart_recovery` with the original `operationId`, accepted `resolutionId`, `productId`, `sellingMethod`, and fresh `expectedRevision`. The server computes the deficit itself, checks another fresh cart before writing, adds only a positive deficit, and verifies readback. Excess and unrelated quantities are never reduced. On `CART_CHANGED`, refresh and reassess before continuing.
5. Every product has one deterministic child operation ID per resolution, including zero-deficit decisions. Repeated calls and restarts cannot replay that addition. If a child returns `OUTCOME_UNKNOWN`, use the child ID from the error for a **new** recovery review and explicit approval; never retry the old add. Other pending operations block overlapping writes; unknown scope or checkout uncertainty blocks globally. After a completed attempt, a later removal requires a new shopping intent rather than reusing this approval.

Trust boundary: the local MCP client (Dot) authenticates the owner and obtains approval before calling acceptance. The MCP stores the caller's approval attestation; it cannot independently authenticate a chat message or prove human presence. `mcp_owner` is recorded separately from the terminal's OS identity. Do not expose this stdio server to untrusted clients. No credentials or checkout settings are changed by this flow.

The site has no atomic compare-and-swap for carts: an external colleague or delayed server request can still race the final browser write. Fresh pre-write reads reduce this window; unverified readback leaves a pending operation and blocks overlapping writes, or all writes when scope is unknown. Recovery never claims that the old operation succeeded or failed. Fixture tests never access the real cart.


### Scoped uncertainty and absolute target batches

See [cart workflow contract and incident findings](docs/cart-workflow-contract.md) for the verified add/update contract, exact product metadata, safe scope isolation and remaining metadata limitations. `get_shufersal_unresolved_items` lists pending items separately. `apply_shufersal_cart_targets` processes absolute desired totals sequentially and returns distinct verified/unresolved/unavailable/unattempted groups. Unknown scope or cart integrity still blocks globally; no terminal or uncertain operation is blindly replayed.

Existing recovery tools support replacing a superseded product target or accepting `targets: []` to abandon it. Owner approval still binds the full current snapshot and targets, with historical outcome unknown. Missing or unverified rows never authorize a zero-based addition.

See [Dot deployment and tool discovery](docs/dot-setup.md) for updating the local worker without resetting its session or ledger.

Absent-product writes verify explicit stock on the exact authenticated product page,
not price or search presence. Search responses retain `stock.stockLevelStatus.code`.
Unknown availability still blocks a write; explicit out-of-stock is reported as
unavailable. See [availability verification](docs/cart-workflow-contract.md#account-context-availability-2026-10-21).
