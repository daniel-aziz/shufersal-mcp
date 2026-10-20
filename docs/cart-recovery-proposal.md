# Recovery of an uncertain cart operation

Status: implemented as read-only MCP assessment plus an interactive local operator command. No live resolution has been performed. Future server receipt/dispatch instrumentation below is not implemented.

## What the current evidence says

The local journal records a fingerprint, pending status, before-cart snapshot, product key and target quantity. It has no dispatch phase, time, server receipt or correlated request result. `perform` saves pending before running the adapter; the adapter may navigate/authenticate before dispatch. A failure before dispatch and a lost response after application therefore produce the same pending record. The operation UUID deduplicates local callers only: `LiveShufersalSite.add` does not send it to Shufersal, and the returned result is discarded.

The existing snapshot reconciliation verifies a current postcondition, not causal attribution. Even full non-monetary cart equality cannot prove who made a target change. Unrelated concurrent edits make that comparison fail but removing the comparison does not establish stronger evidence.

For the reported case, the original target was 12 from 6; the last verified quantity is 6, with two unrelated quantities changed from 4 to 8. It is unknown whether the add never happened or happened and was later reversed. Do not replay it, claim failure or restore the old cart. The ledger must remain pending until supported evidence or an explicit audited resolution exists.

## Evidence classification

| Outcome | Sufficient evidence | Insufficient evidence |
| --- | --- | --- |
| Verified applied | Server receipt/audit entry correlated with the operation, account, product, amount and mutation; or a documented server idempotency lookup showing application | Current target quantity, a resolved frontend promise, HTTP success without a verified mutation contract, or a stable repeated read |
| Verified not applied | Durable pre-dispatch phase when the original worker is stopped and the protocol guarantees dispatch was impossible; or a correlated server terminal rejection guaranteed to have no side effect | Original quantity, generic exception, timeout, absent receipt, or lack of an order-history entry (cart edits are not orders) |
| Unknown | Dispatch might have occurred and neither terminal result is established | Unknown must not silently become failed or applied |

Future dispatch instrumentation must save `dispatch_started` before sending, never after. Crashing between this save and sending is still unknown. A `prepared` record is evidence of no dispatch only in a versioned protocol that cannot send before the next durable phase, with exclusive ownership and the old worker confirmed stopped. Legacy records must not be backfilled with invented evidence. Only audited provider evidence can distinguish concurrent same-product mutations after dispatch; instrumentation alone cannot.

## Smallest supported recovery change

Do not weaken `reconcileCart` to target-only success or unchanged-quantity failure. Add a separate explicit **accept current cart state** resolution for cart operations only. This is an operator decision to abandon/rebase the old intent, not proof of its historical outcome. Do not reuse `complete` to mean applied.

1. A read-only assessment returns the original operation ID, before/target/current quantity, latest full revision, changed unrelated product keys, evidence availability and historical outcome `unknown`. It persists nothing and never permits replay.
2. Before accepting, the old worker must be stopped and outstanding requests investigated. A running/possibly still-dispatching worker, invalid cart identity, incomplete read or stale revision blocks acceptance. If remote completion remains uncertain, disclose that limitation explicitly; local locking cannot exclude colleagues or a delayed server request.
3. An authenticated operator explicitly accepts the current observed quantity and acknowledges the unresolved historical outcome and residual remote uncertainty. The UI shows both quantities and unrelated changes. For this case the decision is **keep 6 and retire the old increase-to-12 intent**, or leave it pending while seeking server evidence. Do not infer either decision from a request to investigate.
4. Under the existing queue and ownership lock, re-read the full cart and require the reviewed revision/account/product to match. Append a durable, versioned resolution under the original operation ID: unique resolution ID, authenticated actor from the trusted host (not self-attested MCP text), timestamp, reason, before/target/observed quantities, observed revision, evidence references, `historicalOutcome: unknown`, `decision: accept_current_state`. Preserve the original fingerprint, snapshot, product and target verbatim. Mark a new terminal `resolved_by_operator` state, distinct from applied/not-applied. Record and fsync before releasing the guard; failed persistence leaves writes blocked.
5. Original-operation retries return the recorded resolution and can never call add again. Identical resolution retries are idempotent; conflicting decisions are rejected. The general uncertainty guard must recognize only this validated terminal resolution; other pending operations continue to block. No force/unlock flag, record deletion, ledger editing or ledger migration that drops history.
6. Recovery itself performs **no cart write**. A later decision to want 12 is a new intent, separately reviewed against a fresh cart; link it to the retired operation and prefer a guarded absolute target, never replay the old `+6`. Stop if old work may still be in flight. An absolute set still needs revision checks and external coordination; Shufersal has no verified atomic compare-and-set here.

The implementation adds a versioned `resolved_by_operator` record and `assess_shufersal_cart_recovery`. The mutating recovery path is not exposed through MCP: only the local interactive operator command injects an approval provider. It derives actor identity from the signed-in OS account, requires a TTY and explicit confirmations, and holds the existing ownership lock. This trusts the local OS session; it is not cryptographic proof of human presence and is not suitable as an authorization boundary against untrusted code running as that same OS user. Agents must not enter the confirmation for the operator. There is no force flag or new permission/credential configuration.

## Verification

The added fixture tests cover successful application with lost response, unrelated concurrent edits, a write never dispatched, and target edits that revert or independently reach the target. They prove that different histories can yield identical current carts and ledger records. Existing guards remain active.

Resolution regression tests cover actor/revision validation, preservation of every other cart item, no site writes, original-ID replay after restart, duplicate/conflicting resolution IDs, atomic persistence failure, multiple pending operations and rejection of checkout/delivery resolution. A test must show that an unknown operation remains historically unknown after operator acceptance.


## Operator command

Stop the running Shufersal MCP normally; do not delete its lock. From the repository, in your own terminal:

```sh
SHUFERSAL_CONFIG_FILE=/absolute/private/config.json npm run recover:cart -- --operation ORIGINAL_OPERATION_UUID --resolution NEW_RESOLUTION_UUID
```

`--resolution` may be omitted to generate an ID, printed before approval. Retain it for audit. The command requires the dedicated live browser and saved session; it does not fetch credentials or sign in. It shows the reviewed quantities/revision, unrelated quantity changes and uncertainty warning, asks for a reason, checks that the operator acknowledges stopped workers/investigated requests, and requires an exact acceptance phrase containing the original operation ID and observed quantity. It re-reads the cart and ledger after confirmation; any changed revision/account/ledger aborts. It never invokes add, set-quantity, delivery or checkout.

A completed operator resolution retains the original operation fingerprint and snapshot, the reviewed full cart, actor, acknowledgements, reason, timestamp and resolution ID. The historical outcome stays unknown. The old request returns the resolution on retries instead of running again. Every other pending operation still blocks writes. Failed persistence blocks further writes in that process; restart and inspect the preserved ledger to determine whether the record was saved. A valid persisted resolution is idempotent after restart, including a response lost after the save.

No unattended resolution, no retroactive claim that the original write failed, and no automatic follow-up cart change are provided. Resolving this case still requires the operator's separate decision to keep the observed quantity and abandon the old increase intent.
