---
name: formal-buyer-review
description: Validate a local buyer-research workflow from immutable inputs to cited observations, reports and reviewed PDFs.
---

# Formal buyer review

Use only files, accounts and research scope explicitly supplied by the operator. The scripts validate evidence and stage transitions; they do not conduct autonomous research or authorize contacting a buyer.

1. Read `references/input-contract.md` and `references/research-report-contract.md` before handling source data.
2. For existing input files, use `scripts/workflow.py init` with explicit JSON, XLSX and workspace paths. The JSON/XLSX pair must agree.
3. For authorized browser collection, read `references/collection-contract.md` and `references/native-browser.md`. Use an explicitly verified browser map. Do not infer a store from the browser label, bypass a login challenge or switch accounts automatically.
4. Call `next` to learn the current stage. Preserve immutable inputs, original source observations and their SHA-256 bindings.
5. Record real research attempts and cited observations for every customer. An unexecuted check is incomplete; missing data is not zero risk.
6. Keep entity identity, procurement intent, risk, scores and payment verification separate. Same-name search results do not establish identity. Unknown scores remain null.
7. Generate reports only from validated research. Inspect every PDF page, then record a visual-review receipt bound to that exact PDF hash.
8. Use `finalize` only after all validators pass. Do not edit rule hashes, evidence hashes, state flags or receipts to skip a stage.

The synthetic example is for offline testing. It must remain visibly marked synthetic and cannot support a real buyer or legal/credit decision.
