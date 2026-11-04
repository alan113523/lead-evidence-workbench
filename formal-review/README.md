# Formal buyer review

An optional local workflow for auditable buyer research. It validates immutable JSON/XLSX input, research attempts, entity attribution, nine analysis dimensions, risk coverage, reports and PDF review receipts. It does not replace a researcher or provide automatic legal/credit clearance.

## Requirements

- Python 3.12+ and the dependencies in `requirements.txt`.
- Node.js for browser-side collection adapters.
- Your own authorized, logged-in browser and an explicitly verified route for live collection.
- Local Chrome/Edge and appropriate fonts for PDF generation. Browser binaries and fonts are not bundled.
- The UK screening CLI uses Windows process-isolation facilities. Its parser/matching routines have offline synthetic tests; unsupported platforms must not report a completed real scan.

Run commands below from the repository root. All runtime directories belong under ignored `data/`.

## Safe offline example

```bash
python -X utf8 formal-review/examples/synthetic_demo.py --out data/formal-demo --customers 3 --matched 0
```

The example uses invented companies and observations, completes with explicitly recorded limitations and makes no real buyer or sanctions conclusion. `--matched 0` avoids PDF rendering. To exercise matched-report generation with your own local browser, use a new output directory and a positive matched count; the workflow stops for a human visual-review receipt.

## Existing input files

Read the [input contract](references/input-contract.md) and [research contract](references/research-report-contract.md), then provide a matching JSON/XLSX pair:

```bash
python -X utf8 formal-review/scripts/workflow.py init --input data/input.json --xlsx data/input.xlsx --workspace data/research
```

Use the actual run path returned by `init`:

```bash
python -X utf8 formal-review/scripts/workflow.py next --run data/research/RUN_DIRECTORY
python -X utf8 formal-review/scripts/workflow.py advance --run data/research/RUN_DIRECTORY
python -X utf8 formal-review/scripts/workflow.py finalize --run data/research/RUN_DIRECTORY
```

`advance` verifies one stage. `next` describes missing evidence and the required artifact. `finalize` rechecks all bindings. Editing state flags or copying another run's receipt cannot establish completion.

## Stages

| Stage | Required evidence |
|---|---|
| Input validated | Immutable source JSON, matching XLSX and their hashes |
| Research prepared | A temporary research view and a record for every source customer |
| Research recorded | Actual query attempts and sanitized source observations |
| Identity classified | An explicit match/unconfirmed status and independent attribution anchors |
| Analysis validated | Nine dimensions, risk coverage, evidence references and nullable scores |
| Reports validated | Complete reports; matched PDF where applicable; hash-bound visual review |
| Final validated | Original inputs, current rules, evidence, reports and receipts still agree |

Insufficient, limited and unconfirmed results remain visible. Missing risk evidence is not zero risk. A null score is not a zero score. Matching a company does not establish that a platform contact is authorized to represent it.

## Optional collection

Read [collection](references/collection-contract.md), [browser access](references/native-browser.md) and [store binding](references/browser-stores.md). Collection uses your own authenticated host; it does not ship a remote account or create a browser profile automatically. Captchas and native authorization prompts require the operator. Do not bypass them or change stores to make a failed task continue.

The public sample keys are synthetic. Supply your own verified minisite slug and private route map. Keep account mappings and observations under `data/`.

## Reports and assets

The HTML/PDF template retains its [Phosphor Icons MIT notice](assets/THIRD_PARTY_NOTICES.md). No screenshots of real buyers, external sanctions-list data, browser binaries or fonts are included. The package's original [MIT notice](LICENSE) is preserved.

The public rule hash is computed from this package's published code, contracts and templates. Old internal rule hashes and runs are not migration targets for this release.
