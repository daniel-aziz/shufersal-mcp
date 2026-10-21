# Independent candidate verification

These immutable transcripts identify implementation commit `9230633` and build `e11984cf2bd6c106bfad592b2effa27f615c749e667c4fc0444ae69362d92618`. Each group used a new agent with clean context, distinct from its implementer. Baseline records identify the earlier `fef067c` build.

- [All-tool matrix](all-tools/matrix.md): every repository tool was invoked via MCP, with sanitized inputs and complete actual results in [transcripts](all-tools/transcripts.json).
- [Browser adapter held-out scenarios](adapter/REPORT.md): localhost Chromium through real MCP handlers; live cart writes and actual empty-cart validation are BLOCKED.
- [Ownership and build cases](ownership/matrix.md): crash, CLI recovery, concurrent claims and ledger preservation against temporary state. This supplies the separate crash/ownership coverage marked delegated in the all-tool report.
- [Pre-change baseline](baseline/FINDINGS.md): actual failures and behaviors already passing before edits.

The adapter verifier caught a 200ms fixture-readiness timeout under concurrent load. Its isolated rerun and independent empty-cart fixture passed; the test budget was increased to5s without weakening assertions. A new final verifier reruns the affected case and all-tool matrix after this test-only change. Final execution build IDs and evidence are linked in the PR.

Harnesses preserve the exact local paths used during execution for auditability; use isolated temporary state and adjust repository/output paths before reproducing elsewhere. Never point fixture mutation handlers at live state. The permanent four-tool client boundary was not expanded. A PASS for a refusal means that refusal behaved as expected, not that its live action succeeded.
