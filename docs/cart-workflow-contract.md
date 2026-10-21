# Cart workflow contract and incident findings

## Investigation (2026-10-21)

The actual ledger entry `8650a68e-f522-4e54-a21a-b5a16abe940f` records exact SKU `P_7290110565527`, name `דנונה פרו 20 גרם חלבון`, a before quantity of 12 and intended target 17. Its status is pending. It contains no original exception, dispatch stage or response evidence. The owner reports the later readback as 5; this report is not a server receipt.

Read-only inspection of the public Shufersal JavaScript showed:

- The site's UI routes existing rows to `cart.item.update_qty(entry, sellingMethod, absoluteQuantity, productId)`. The request uses `/cart/update` with that absolute quantity.
- `addToCart` sends its quantity argument unchanged as both `qty` and `frontQuantity` to `/cart/add`. Its fifth argument is a DOM element; the context object belongs in argument six. Our former adapter sent a delta for existing rows and supplied the context in argument five.
- The old browser tests covered cart extraction but did not exercise this live add/update boundary.

The confirmed defect is that the adapter treated a new-row entry point as a generic additive API for existing rows. The reported 12 → 5 result is consistent with absolute handling, but the historical `/cart/add` server response cannot be reconstructed. The new adapter follows the UI's existing-row absolute update path and verifies readback. The local HTTP regression fixture proves current 12 + delta 5 sends target 17, never 5. No write was sent to Shufersal during this investigation or testing.

The reason PRO25 was omitted from later reads remains unknown. Omission is not evidence of deletion or of a failed write. PRO20 and PRO25 are different exact SKUs; no name-based substitution is permitted.

## Integrity, identity and scopes

A live cart read compares every parsed DOM product row with the separate full `/cart/load` response, including exact SKU, selling method and quantity. Malformed/duplicate rows fail; mismatched membership or an unrecognized full-cart container yields incomplete integrity and prevents writes. Empty carts remain unverified until an explicit empty-cart contract is implemented. This intentionally fails closed rather than treating a missing row as zero.

New pending operations retain original history plus a separate `unresolved` record: product identity, requested absolute target, last verified quantity, reason, account/cart scope and equivalence keys. `get_shufersal_unresolved_items` returns these without changing the ledger. A fresh complete cart is required to continue an independent item. Same SKU across sale units, normalized barcode aliases, and known equivalent pack groups conflict. Unknown equivalence/scope or checkout/delivery uncertainty retains a global block.

**Metadata limitation:** the live adapter returns exact name and SKU, barcode where encoded by the SKU, and variant/pack size only when explicitly present in catalog/DOM metadata. Unknown fields are null. It does not infer pack equivalence from names. Isolation requires explicit base-product/equivalence metadata; if the site does not supply it, the write remains globally blocking and owner recovery is required. Legacy pending records are not silently assigned newly invented scopes. Pack conversions require review; the tool never adds an overlapping pack or overwrites its quantity.

## Durable evidence

Each attempted write records timestamps and prepared/dispatch/response/readback stages. Known adapter failures before dispatch use terminal `not_applied`; transport failures or mismatched readback stay pending/unknown. Repeated calls never replay either terminal or uncertain records. Successful results mean a verified cart postcondition, not proof of causality when other actors can edit the cart.

Evidence includes allowlisted stage/reason, exception type and digest, numeric HTTP status, endpoint category and verified numeric quantities when available. Arbitrary original text/stack, request headers, query strings, bodies, credentials and session tokens are not persisted or returned. Full original messages cannot safely be reconstructed from the digest. Persistence uncertainty blocks further writes in that process.

## Dot workflow

1. Read `get_shufersal_cart` and `get_shufersal_unresolved_items`. Use actual current quantities; the owner's latest PRO20 observation is 5, superseding 12, but another fresh read is still required.
2. Use the existing `prepare_shufersal_cart_recovery` and `accept_shufersal_cart_recovery` to retire superseded intents with explicit owner approval of the fresh snapshot. Replacement targets can use a different exact SKU; an empty target list abandons the old intent without additions. Original history remains unknown and preserved.
3. Use existing `resume_shufersal_cart_recovery` for an accepted recovery's approved products. Alternatively, for new owner-requested shopping intents use `apply_shufersal_cart_targets` with `expectedRevision` and `targets: [{operationId, productId, sellingMethod, expectedName, quantity}]`. Quantity is an absolute desired total. Keep one stable operation ID per target across retries and restarts. Never reuse an ID for a changed target.
4. Batch targets execute sequentially from fresh state and return `verified`, `unresolved`, `unavailable` and `unattempted`, plus the full pending-operation list. A scoped uncertain item does not cancel safe independent items. Cart changes require fresh review; no blind retry. A previously completed result is historical, not a claim about today's quantity.

Do not use the contextual target list as execution permission during repair. Preserve all Coke Zero and unrelated items. Checkout remains disabled. No profile, credential or ledger reset is part of setup. Reconnect the local MCP after deployment to discover the added tools.

## Account-context availability (2026-10-21)

Search suggestions expose `stock.stockLevelStatus.code`; the old Zod schema stripped
`stock`, and `describeProduct` incorrectly expected a top-level `available` boolean.
The search schema now preserves the allowlisted status without exposing arbitrary
response fields. Search results remain discovery data, not permission to write.

Before adding an absent SKU, the live adapter opens its exact `/online/he/p/{SKU}`
page in the authenticated browser. It requires matching Product JSON-LD SKU, exact
cart-control product code, requested selling unit, and the same account as the
fresh cart both before and after parsing. Product-scoped Offer microdata must agree
with that Product's JSON-LD: `https://schema.org/InStock` is available;
`https://schema.org/OutOfStock` is unavailable. Missing, contradictory, duplicate or
unrecognized stock evidence is unknown. Missing identity fails closed. Price,
catalog presence and add buttons never establish stock. This check does not reserve
inventory; existing pre-write and readback safeguards still apply.

Read-only authenticated inspection of `P_7290116936628` found matching SKU and
`OutOfStock` in both representations, plus the visible out-of-stock indicator.
The product modal nevertheless displayed an add button and price, demonstrating
why those are unsafe availability signals. Barcode search did not return this SKU
at inspection time. No live write was performed; stock may change later.

The availability check reports unknown variant/equivalence metadata rather than
inventing pack relationships. Existing cart rows retain their verified identity;
uncertain operations with unknown equivalence scope remain conservatively blocked.
