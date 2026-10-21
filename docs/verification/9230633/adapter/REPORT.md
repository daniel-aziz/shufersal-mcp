# Independent adapter verification

Build: e11984cf2bd6c106bfad592b2effa27f615c749e667c4fc0444ae69362d92618

Production LiveShufersalSite, ShoppingService and registered MCP handlers exercised through real MCP Client/InMemoryTransport and isolated localhost Chromium. No source/dist edits or rebuild. Fresh stdio tools/list and build resource also succeeded after sandbox escalation; initial sandbox startup failure was environmental.

| Scenario | Result | Expected |
|---|---|---|
| open | PASS | authenticated fixture |
| beyond30 | PASS | matcha at ordinal47 found; reported67 complete |
| absence | PASS | incomplete short search does not establish stock |
| exact-matcha | PASS | exact80g BY_UNIT available |
| existing-stock-out | PASS | no write existing SKU out |
| existing-stock-unknown | PASS | no write existing SKU unknown |
| existing-stock-conflict | PASS | no write existing SKU conflict |
| 12plus5 | PASS | existing quantity17 update endpoint; PRO25 unchanged |
| new-row | PASS | new separate matcha quantity3 add endpoint |
| identity | PASS | PRO20 200g and PRO25 180g identities distinct |
| wrong-sale-unit | PASS | reject no write |
| account-bound | PASS | reject different product account |
| incomplete-cart | PASS | partial DOM rejected |
| response-loss | PASS | unknown after actual write19 |
| no-replay | PASS | same request no second write |
| sanitized-evidence | PASS | no secret leaked pending retained |
| verified-empty | PASS | explicit empty in DOM and response |
| missing-empty | PASS | missing explicit empty rejected |
| concurrent-edit | PASS | stale revision rejects preserving external PRO25 edit |
| background-poll | PASS | polls occurred and operations completed |
| actual-live-write-and-empty | BLOCKED | explicitly prohibited saved profile/live mutations |

Input, actual output, before/after rows, HTTP paths and mutation counts are recorded in report.json. Fixture source: verify.mjs. Supporting existing suite: supporting-tests.txt. No live browser, ledger or lock was accessed.

Limit: these fixtures validate adapter contracts against synthetic markup, not current production markup or live server behavior. Pending-operation equivalence blocking was not independently exercised; distinct PRO20/PRO25 identities and pack metadata were exercised.

Supporting pre-existing suite: 8/9 passed on concurrent run. The empty-cart test timed out at its 200ms account wait (catalog-completeness.test.mjs:42); isolated rerun of that file passed 2/2. This is a reproducible test-run observation, not established product failure. Independent empty-cart checks passed.
