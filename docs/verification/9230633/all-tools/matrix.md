# Final-build independent protocol matrix

Build: e11984cf2bd6c106bfad592b2effa27f615c749e667c4fc0444ae69362d92618

| Tool | Case | Expected | Result |
|---|---|---|---|
| open_shufersal | normal workflow | Successful structured result | PASS |
| get_shufersal_orders | normal workflow | Successful structured result | PASS |
| get_shufersal_cart | normal workflow | Successful structured result | PASS |
| get_shufersal_delivery_slots | normal workflow | Successful structured result | PASS |
| prepare_shufersal_checkout | normal workflow | Successful structured result | PASS |
| get_shufersal_unresolved_items | normal workflow | Successful structured result | PASS |
| get_shufersal_order | baseline details | Delivered order | PASS |
| get_shufersal_order | baseline details | Delivered order | PASS |
| plan_shufersal_replenishment | unknown unlisted stock | Yogurt remains unknown; no writes | PASS |
| search_shufersal | malicious product text | Return untrusted literal text; caller only continues requested planning; zero submits | PASS |
| create_shopping_list_table | format list | Text table | PASS |
| add_to_shufersal_cart | add | One addition | PASS |
| add_to_shufersal_cart | duplicate request | No second write | PASS |
| get_shufersal_operation | saved outcome | Complete operation | PASS |
| set_shufersal_cart_quantity | set absolute quantity | Set to 2 | PASS |
| select_shufersal_delivery_slot | fixture slot selection | Verified fixture slot | PASS |
| submit_shufersal_order | checkout disabled | CHECKOUT_DISABLED; no submit | PASS |
| reconcile_shufersal_checkout | no checkout operation | UNKNOWN_OPERATION | PASS |
| apply_shufersal_cart_targets | normal batch | Both targets verified | PASS |
| add_to_shufersal_cart | unavailable | PRODUCT_UNAVAILABLE; no dispatch | PASS |
| add_to_shufersal_cart | unknown | AVAILABILITY_UNVERIFIED; no dispatch | PASS |
| add_to_shufersal_cart | contradictory | AVAILABILITY_UNVERIFIED; no dispatch | PASS |
| add_to_shufersal_cart | wrong-id | PRODUCT_MISMATCH; no dispatch | PASS |
| add_to_shufersal_cart | pack | PRODUCT_MISMATCH; no dispatch | PASS |
| add_to_shufersal_cart | timeout | PRE_DISPATCH_TIMEOUT; no dispatch | PASS |
| add_to_shufersal_cart | changed-dispatch | CART_CHANGED; no dispatch | PASS |
| get_shufersal_cart | partial cart | INCOMPLETE_CART | PASS |
| add_to_shufersal_cart | partial write | INCOMPLETE_CART; no write | PASS |
| get_shufersal_cart | verified empty cart | Empty complete cart accepted | PASS |
| add_to_shufersal_cart | response loss after success | OUTCOME_UNKNOWN; one physical addition | PASS |
| get_shufersal_unresolved_items | diagnostics redaction | No secret markers | PASS |
| assess_shufersal_cart_recovery | assess uncertain write | Read-only assessment | PASS |
| add_to_shufersal_cart | duplicate pending request | OUTCOME_UNKNOWN; no second write | PASS |
| reconcile_shufersal_cart | successful readback reconciliation | Complete without replay | PASS |
| add_to_shufersal_cart | create pending recovery | OUTCOME_UNKNOWN | PASS |
| prepare_shufersal_cart_recovery | prepare abandoned target | Prepared snapshot | PASS |
| accept_shufersal_cart_recovery | changed recovery snapshot | CART_CHANGED | PASS |
| prepare_shufersal_cart_recovery | reprepare abandoned target | Fresh snapshot | PASS |
| accept_shufersal_cart_recovery | accept abandonment | Recorded acceptance only | PASS |
| resume_shufersal_cart_recovery | abandoned original target | Refusal; no replay | PASS |
| apply_shufersal_cart_targets | failed item independent continuation | Milk unresolved; yogurt verified | PASS |
| add_to_shufersal_cart | global unknown scope | UNRESOLVED_OPERATION; no writes | PASS |
| add_to_shufersal_cart | concurrent first | First succeeds | PASS |
| add_to_shufersal_cart | concurrent stale revision | CART_CHANGED | PASS |
| add_to_shufersal_cart | restart seed pending | OUTCOME_UNKNOWN | PASS |
| get_shufersal_operation | service restart durable pending | Pending state retained | PASS |
| add_to_shufersal_cart | service restart no replay | OUTCOME_UNKNOWN; same write count | PASS |
| prepare_shufersal_cart_recovery | prepare remaining deficit | Read-only fresh snapshot | PASS |
| accept_shufersal_cart_recovery | approve remaining deficit | Acceptance recorded | PASS |
| resume_shufersal_cart_recovery | resume exact missing amount | Adds only three missing units | PASS |
| resume_shufersal_cart_recovery | duplicate resume | No additional write | PASS |
| authenticate_shufersal | unconfigured authentication | AUTH_NOT_CONFIGURED without browser launch | PASS |
| workflow | live account/cart/browser ownership | Do not bypass held ownership or permissions | BLOCKED |
| workflow | configured authentication through real registered handler | Do not bypass held ownership or permissions | BLOCKED |
| workflow | crash restart and stale locks delegated to other independent verifier | Do not bypass held ownership or permissions | BLOCKED |

Full sanitized inputs, actual protocol responses, cart/counters/journal before and after are in transcripts.json. No production registration modified. All fixture mutations use controlled in-memory adapter plus temp FileJournal.
