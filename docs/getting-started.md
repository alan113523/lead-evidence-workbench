# Getting started

Use Node.js 24 or newer and Python 3.12 or newer. Create and activate a virtual environment, then install `requirements.txt`. The offline core has no npm dependencies.

## Python selection

The npm scripts use `python` on Windows and `python3` elsewhere. An activated virtual environment is normally sufficient. To choose an interpreter explicitly:

```powershell
$env:PYTHON_EXECUTABLE = (Resolve-Path .venv\Scripts\python.exe).Path
npm run demo -- example-run
```

```bash
PYTHON_EXECUTABLE="$PWD/.venv/bin/python" npm run demo -- example-run
```

All supplied Python entry points use explicit UTF-8 mode. Preserve LF line endings in code that is included in frozen evidence pins.

## Demo output

`npm run demo -- example-run` creates a new `data/example-run/` directory. It contains synthetic input, messages, metrics, an HTML dashboard and a workbook. It makes no network requests. Open the HTML directly; no web server is required.

## Inquiry import

The importer handles one explicitly selected store at a time. Save this invented example as `data/inquiries.jsonl` after creating `data/`:

```json
{"store_key":"demoalpha","inquiry_id":"101","created_at":"2026-01-05T09:00:00+08:00","observed_at":"2026-01-15T00:00:00+08:00","owner":"Demo A","source_system":"synthetic-example-v1"}
```

```bash
node scripts/inquiries.mjs import --file data/inquiries.jsonl --store demoalpha --db data/leads.sqlite
node scripts/inquiries.mjs summary --store demoalpha --db data/leads.sqlite
```

Repeating the same observation is idempotent. A row with a different `store_key` is rejected. Timestamps must include an explicit timezone. IDs stay strings.

## Existing operational inputs

The core pipeline consumes a frozen final-data JSON and a bound messages JSONL. The generated demo provides an inspectable example of both. Keep a separate original source and bind the derived files by SHA-256; do not manufacture evidence references to make an assessment pass.

```bash
python -X utf8 scripts/followup_metrics.py --input data/run/final-data.json --messages data/run/messages.jsonl --out data/run/metrics.json
python -X utf8 scripts/build_dashboard.py --input data/run/final-data.json --metrics data/run/metrics.json --messages data/run/messages.jsonl --period "Review period" --out data/run/dashboard.html
python -X utf8 scripts/build_followup_workbook.py --input data/run/final-data.json --metrics data/run/metrics.json --from 2026-01-01T00:00:00+08:00 --to 2026-01-15T00:00:00+08:00 --out data/run/follow-up.xlsx
```

Use new output paths. The dashboard and workbook builders reject overwriting existing reports. The metrics command is a calculation step; preserve previously frozen metric files yourself by selecting a new output path.

## Browser adapters

The core includes resumable chat-collection and browser-binding adapters. They do not open a browser automatically. A host integration must execute each ticket on the exact selected connection and return the fresh seller proof with the requested response. Never infer identity from a browser label or copy another account's binding.

The public package accepts a valid caller-supplied store slug. The synthetic names are examples, not a publisher-account allowlist. Browser store slugs must correspond to the actual verified minisite hostname. Keep private binding maps under `data/`; see the formal package's [collection contract](../formal-review/references/collection-contract.md).

## Formal research

Read the [formal package guide](../formal-review/README.md). Its JSON/XLSX input contract is separate from the operational final-data format. Formal completion requires evidence, report validation and, when a PDF is produced, a page-by-page visual receipt.
