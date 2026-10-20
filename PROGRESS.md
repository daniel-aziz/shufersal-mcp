# Office grocery automation checklist

1. **Connect:** local browser, secure 1Password login, saved session. — Verified live. Dedicated background browser, ownership lock, fresh sign-in through 1Password and saved-session reuse after a full browser restart passed on 2026-10-20.
2. **Test:** search, cart changes, past orders, delivery slots, checkout safeguards. — Live search, cart reads, add/change/remove, retry protection, order history and available-window reads passed. Checkout safeguards passed synthetic tests and a live disabled-checkout check. Live delivery selection/final purchase remain blocked and belong to steps 7–8; no real purchase authorized.
3. **Schedule:** every other Sunday; reuse the existing reminder. — Existing Google Calendar Task retained as requested. ChatGPT Dot owns automatic execution; no local scheduler.
4. **Prepare:** use past orders and the stock update to build the cart. — Read-only replenishment tool and Dot workflow implemented. Uses guarded additions, preserves existing cart items, and asks about unknown stock. Actual office stock update and Dot integration are still needed for the first real cycle.
5. **Invite:** approved Slack message so teammates can add items. — Not enabled; channel/message approval required.
6. **Review:** Sunday evening, flag duplicates, unusual quantities/items, and prices above ₪100/unit. — Not started.
7. **Approve:** complete order and Tuesday delivery around 11:00, never before 10:00 Israel time; ask if unavailable. — Not started.
8. **Order:** explicit final approval; material changes require reapproval; verify order number and prevent duplicate retries. — Safeguards have synthetic coverage; no live checkout.

## Validation evidence

- 2026-10-19: live automated 1Password sign-in succeeded; restarting the dedicated browser retained access to order history.
- 2026-10-20: saved session still works; live cart, order listing and delivery response inspected read-only. Source checkout moved out of temporary storage.

- 2026-10-20: compiled MCP over stdio verified search (30 results), cart (4 original lines), history (18 orders / 428 item lines), and 40 available windows.
- Live reversible test added one low-cost water product, checked same-operation retry, rejected a stale revision, changed quantity, removed it, and verified the exact original cart revision. An initially uncertain removal was resolved by a fresh exact baseline comparison without repeating the write. Durable read-only cart reconciliation and bounded read-back retries were added; the complete test then passed in headless mode.
- `npm run verify:live` passed with the saved local reference-only configuration and existing session. The fresh profile test correctly stopped at `VAULT_UNAVAILABLE` after 1Password authorization timed out; no credential values were printed.
- CI-equivalent validation: lint, TypeScript build, 23 automated tests, dependency audit (0 vulnerabilities), and package dry-run passed. Tests include secret redaction, unsafe-login-form rejection, persistence/idempotency, live-response parsing, incomplete-checkout rejection and lost-response recovery.
- Current live cart fields not yet mapped: selected address, selected window, substitution preferences. They are explicitly null and the summary is estimated. The live adapter refuses delivery selection and purchase before any operation is recorded; no purchase-ready summary is claimed.
- Implementation branch: `feat/live-auth-validation`.

- Final rerun note: one synthetic Chromium removal check timed out once; its isolated rerun and the complete three-test browser-suite rerun passed. Live cart restoration was independently verified.

- 2026-10-20: after the user unlocked 1Password, the integrated MCP authenticated a completely fresh temporary browser profile (`reused: false`). A second MCP process restarted the browser with that profile and authenticated without reading credentials again (`reused: true`). Checkout stayed disabled; the temporary profile was removed after validation.

- Step 4 validation: lint/build and all 25 automated tests passed. Live read-only MCP planning used the six most recent dated delivered orders as a test sample, inspected 106 distinct product/method combinations, identified 10 stock questions, and verified the exact cart revision remained unchanged. The sample is a validation input, not a permanently approved office baseline. No stock values were invented and no products were added. Step 4 implementation and validation are recorded on `feat/live-auth-validation`; connection to Dot remains to be verified.
