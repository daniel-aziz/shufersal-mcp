# Shufersal MCP

A focused Shufersal tool server, forked from [matipojo/shufersal-mcp](https://github.com/matipojo/shufersal-mcp). Uses Puppeteer and one persistent browser session. Authentication providers, scheduling, Slack announcements, shopping policies and human approval belong in the calling application.

**Status:** tool contracts, retry protection and a synthetic browser integration are tested. The new cart/history/delivery/checkout DOM mappings have **not been validated against live Shufersal**. No production site profile is shipped. Without a verified profile, opening the site and upstream-style search are available; the new shopping operations fail with `SITE_PROFILE_REQUIRED`. Checkout is disabled by default. Do not describe fixture tests as proof that production ordering works.

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

Never place credentials in this configuration. Sign in through the dedicated browser or an external credential-injection integration. Login challenges require human intervention. `open_shufersal` reports authentication only when a site profile supplies a verified authenticated-page marker; otherwise it reports `null`, not a guessed login state.

## Tools

Every shopping result is JSON text: `{ "ok": true, "result": ... }` or an MCP error with `{ "ok": false, "error": { "code", "message" } }`. Tool annotations distinguish reads and writes.

| Tool | Purpose |
|---|---|
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
| `reconcile_shufersal_checkout` | Resolve an uncertain checkout by reading history, without submitting again |
| `create_shopping_list_table` | Format an ingredient list locally |

All mutations require a fresh `expectedRevision` from `get_shufersal_cart` and a caller-generated UUID `operationId`. Reuse the exact same ID and arguments when checking a retry. Successful repeats return the saved result without repeating the write; changing arguments under an existing ID fails.

`submit_shufersal_order` also requires `confirmed: true` and operator configuration `SHUFERSAL_ENABLE_CHECKOUT=true`. The flag is an assertion from the trusted caller, **not authentication or proof of human consent**. The calling app must authorize the actor, obtain human approval, and bind it to the displayed revision. Expose this server only to trusted clients.

## Checkout and recovery

The revision covers the account, every line, quantities, unit/line prices, substitutions, address, delivery window, fee, total, currency and estimated-total status. The browser checks the final checkout summary again before clicking. Any mismatch prevents submission. Estimated totals are currently blocked; a caller-approved spending-cap workflow needs separate design before allowing weight-based checkout.

The service checks pending/confirmed orders for the same account, address and Israel delivery day. Possible duplicates block checkout even if totals differ. Cancelling an order or resolving a legitimate same-day second order is outside these tools.

Operations are recorded before the external write. A lost response, failed verification or crash leaves the operation pending and blocks new writes. Reads remain available. Never delete the journal to make a retry possible.

For uncertain checkout, call `reconcile_shufersal_checkout` with the original operation ID. It requires exactly one new pending/confirmed order with the same complete cart revision, excluding orders known before submission. If history is empty, delayed, incomplete, mismatched or ambiguous, it stays uncertain. Retry the **read**, not checkout. A successful click or empty cart is not sufficient proof.

For uncertain cart or delivery writes, inspect the saved operation and the actual site state. Automatic reconciliation for these writes is not yet supplied: an operator must resolve the pending record offline only after verifying the outcome. Preserve the record and original operation ID. Do not repeat an additive write blindly.

## Browser ownership and security

All MCP shopping operations run sequentially, including reads that navigate the shared page. An exclusive filesystem lock prevents two servers using the same state directory. It is intentionally not stolen after a crash. Confirm that the old process is stopped, inspect pending operations, and only then remove a stale `owner.lock` file. Keep `operations.json` intact.

Use **one state directory per account** and one active worker. A filesystem lock does not coordinate separate computers or unrelated state directories. The calling application must enforce ownership across remote/local runners. Stop the old worker before takeover, and reconcile uncertain operations first.

`SHUFERSAL_BROWSER_URL` can attach Puppeteer to an existing **loopback HTTP** Chrome debugging endpoint, sharing its default context while creating a separate shopping tab. Other automation, including Playwright, must use the same external coordinator; this server cannot lock independent clients or colleagues' browsers. It closes only its own tab and disconnects on shutdown when attached. Do not expose the debugging port publicly.

The dedicated profile and journal live outside the repository by default, under `~/.local/state/shufersal-mcp`. New directories/files use restricted permissions. Use encrypted disk storage; sessions are credentials and must not be uploaded as test artifacts. The journal stores operation fingerprints, status, verification results and order IDs, not passwords or complete cart snapshots.

| Setting | Default |
|---|---|
| `SHUFERSAL_STATE_DIR` | `~/.local/state/shufersal-mcp` |
| `SHUFERSAL_SITE_PROFILE` | unset; verified site mappings required for shopping operations |
| `SHUFERSAL_HEADLESS` | `false` |
| `SHUFERSAL_BROWSER_URL` | unset; launch dedicated browser |
| `PUPPETEER_EXECUTABLE_PATH` | Puppeteer's installed browser |
| `SHUFERSAL_ENABLE_CHECKOUT` | `false` |

No Slack, 1Password, order cadence, unusual-purchase rules or office delivery preferences are embedded in the server. Tuesday timing, the ₪100 warning and historical quantity checks belong in the private workflow. The server reads substitution policies but does not automatically choose replacements.

## Site profile and live verification

The profile schema is in `src/shopping/site-profile.ts`. `tests/browser/fixture.mjs` shows a complete **synthetic** mapping; its selectors are not Shufersal selectors. Do not copy them into production and assume they work.

A profile maps same-origin page paths, authenticated/ready markers, cart fields, line fields, quantity controls, order rows and pagination, delivery slots and the final checkout control. A field consists of a CSS selector and optionally an attribute name; otherwise text (or an input value) is read. Monetary fields must be unambiguous numbers, optionally with commas and ₪. Currency must be `ILS`; the estimate flag must be explicitly `true` or `false`. Use value-bearing attributes when visible text contains additional content. Slot timestamps must include UTC offsets. All required summary fields must be readable; missing data is an error, not a default zero or guessed value.

Before deployment:

1. Establish read-only access from the intended remote host; if blocked, use an authorized local worker. No cloud access is assumed.
2. Inspect authenticated pages and create a local profile outside Git. Confirm a complete cart, prices, substitution policy, address, total, history pagination and delivery windows against the UI.
   After authentication and profile setup, run `node scripts/verify-live.mjs`. It calls only open/cart/history/slot reads, forces checkout off, and prints no account data. This check is deliberately excluded from CI.
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
