# Adapter evidence and reliability limits

## Contract verified in code and isolated Chromium fixtures

The production adapter already selected `miglog.cart.item.update_qty` for an existing row, passing the **absolute target**, and `miglog.cart.addToCart` for a new row. This audit preserves that implementation. The fixture verifies existing quantity 12 plus delta 5 yields 17, and separately verifies a newly added quantity 5. These tests establish the adapter's arguments and verification behavior; they do **not** establish a successful live server write. No office cart writes were authorized or performed.

Exact product availability is read from the authenticated product page, with exact SKU and supported sale unit checks and account verification before/after. Explicit JSON-LD and product-scoped Offer microdata must agree; missing, duplicated, unsupported or contradictory evidence yields `available: null`. `availabilityEvidence` retains the allowlisted status values and conflict flag. Neither catalog presence nor price proves stock. Explicit product-scoped base-product, pack and variant fields are preserved when supplied; missing equivalence information is not invented. The service preserves previously verified cart identity when newer availability evidence omits it and rejects conflicting identity.

## Search completeness

The observed public autocomplete JavaScript uses `search/results` with a `limit` parameter. A page/cursor contract has not been established. The adapter widens the supported result window to 30, 60, 120 and at most 240, verifying stable prefix membership and unique product/sale-unit keys. It reports `pagination.complete: false` without an authoritative matching result count, even for a short response. A source ignoring the wider limit is therefore not mistaken for exhaustion. `totalNumberOfResults` / `totalResults` metadata are accepted when supplied; the live source has not been established to return them.

Numeric SKU/barcode searches also query the authenticated exact product page, separately for BY_UNIT and BY_WEIGHT, returning `exactLookup` results only for verified identities. An absent suggestion or an unverifiable exact lookup is not an unavailable product. Consumers must inspect search completeness and exact lookup evidence, not treat the first thirty results as a complete catalog.

## Empty carts

The prior production adapter rejected every empty cart. The new path accepts zero rows only when the page explicitly reports `#cartTotalItems` equal to zero and a successful full `cart/load` response has one product-list container, zero rows and its own explicit zero counter. A page/server disagreement or absent counter remains incomplete. The counter name appears in the saved public cart-refresh JavaScript; its complete empty-cart shape has only been validated in synthetic fixtures. The real office cart is nonempty, so **live empty-cart validation remains blocked without an authorized isolated account/cart**. Monetary fields remain null when unavailable, including a verified empty cart.

## Validation boundaries

All browser regression cases use loopback HTTP fixtures and actual Puppeteer/production adapter code. They do not load saved credentials or the office ledger. Live writes, checkout and delivery reservations remain outside this audit's authorization. The permanent read/planning registration must not be expanded to obtain test coverage.

## Profile quantity completion

A deterministic polling fixture reproduced `OUTCOME_UNKNOWN` after an already-applied quantity update: unrelated GET polling prevented page-wide network idle. Profile quantity updates now observe completion/failure of same-origin mutating requests dispatched during the button action, followed by the existing full-cart readback. No idle heuristic determines success and no action is retried. A missing dispatch, incomplete response or failed request remains unknown. The profile contract requires its button to dispatch its request synchronously; delayed or unrelated mutating traffic must be separately validated when configuring a profile. Checkout and slot selection behavior are unchanged.

The response-loss fixture interrupts a response body after headers. During diagnosis, a server closing the socket before any response headers caused Chromium itself to issue multiple POST attempts. The MCP cannot guarantee server-side idempotency against transport-level retries without a supported idempotency key or verified absolute server operation. The existing-row absolute setter limits that particular risk; live new-row additive behavior remains a validation boundary.
