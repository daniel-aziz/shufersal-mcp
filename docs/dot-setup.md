# Updating Dot's local Shufersal MCP

Keep the existing MCP command, private configuration file, state directory, 1Password references and browser profile. Do not create a second worker or reset the operation ledger. Checkout stays disabled.

1. Build the reviewed version with `npm ci --ignore-scripts` and `npm run build`. Run `npm run check` against synthetic fixtures before deployment.
2. Stop/disconnect the existing Dot MCP worker, then reconnect using the same configuration. Do not start a second worker against its state directory. A stale ownership lock requires verifying that the old process has stopped; never delete the ledger.
3. Refresh tool discovery: this version exposes **23 tools**, including `get_shufersal_unresolved_items` and `apply_shufersal_cart_targets`. The existing prepare/accept/resume recovery tools remain supported.
4. Use read-only `get_shufersal_cart`, `get_shufersal_unresolved_items` and `get_shufersal_operation` to inspect current state. No cart mutation is needed to verify installation. Incomplete membership blocks writes. Monetary values may be null.
5. Preserve legacy pending operations. They lack trustworthy dispatch/scope evidence, so they remain globally blocking until explicitly accepted through existing owner-approved recovery. Show the current snapshot and replacement absolute targets first. Never fabricate owner approval or infer historical success/failure.
6. For an approved recovery, use `resume_shufersal_cart_recovery`. For a new shopping intent, use `apply_shufersal_cart_targets` with a fresh revision and one stable UUID per exact SKU/target. Refresh after cart changes; never issue a new UUID simply to bypass an uncertain outcome.

Batch input: `expectedRevision` plus `targets: [{operationId, productId, sellingMethod, expectedName, quantity}]`. Quantity is the desired total, not a delta. Results separate `verified`, `unresolved`, `unavailable` and `unattempted`. Unknown catalog availability is unattempted. Unknown pack equivalence may retain a global block.

The [workflow contract](cart-workflow-contract.md) explains evidence, quantity semantics and limitations. The [README recovery flow](../README.md#owner-approved-recovery-in-dot) lists the approval payload. Reconnecting discovers the tools; it does not authorize writes, resolve old operations or place an order.
