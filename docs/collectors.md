# Collectors and verified account access

The public project includes account collectors, chat-window collection, customer collection for formal research, and the offline import/reporting pipeline. Only use accounts and record scopes you are authorized to read. No credentials, account mappings or real responses are supplied.

## Included modules

| Scope | Entry point | Output and boundary |
|---|---|---|
| Inquiries and member association | `scripts/collect_readonly_chains.mjs --chains inquiries` | Inquiry rows, bounded extra fields and optional buyer enrichment; existing member-bundle import format |
| Inquiry-associated visitors | Same CLI with `--chains visitors` | Daily visitor records and bounded detail occurrences; `isMcFb=true`, not all visitors |
| Advertising opportunities | Same CLI with `--chains opportunities --campaign-id ID` | Explicit type-47 whole-site plan; live metadata/scene checks; no plan modification |
| Chat history and continuation | `scripts/chat_collection.mjs`, `scripts/chat_window.mjs`, `scripts/history_collection.mjs` | Exact inquiry/account tickets, accepted pages, source pins, coverage and review queue; requires an authorized host adapter |
| Formal customer list/detail/profile | `formal-review/scripts/workflow.py collect` | Staged list/detail/buyer-profile records and input export; see the formal collection contract |
| Buyer levels | `scripts/export_buyer_levels_browser.js` | Small extra-field sidecar; missing/empty/unexpected values remain distinct |
| CRM link for one inquiry | `scripts/export_customer_link_browser.js` | One exact inquiry-to-CRM link; input inquiry ID must agree with the visible URL |
| Order candidates | `scripts/export_member_order_candidates_browser.js` | Bounded exact-member searches; candidate orders are not verified payments |
| Assignment and public pool | `scripts/export_ownership_browser.js` | Visible DOM records with explicit store, page type, display timezone and row cap |
| Browser inquiry/export compatibility | `scripts/export_inquiries_browser.js`, `scripts/export_inquiries_member_bundle_browser.js` | Low-level browser adapters; prefer the unified CLI for ordinary inquiry reads |
| Browser visitor/ad-report adapters | `scripts/export_visitors_browser.js`, `scripts/export_ads_browser.js` | Small, explicitly configured read-only samples; fixed historical plan/tracking values removed |

Lower-level browser scripts are integration components. They are not independent account-authentication tools and are not a way to bypass host permissions. See the verified-host contract below.

## Offline collection demo

```bash
npm run demo:collect -- collector-demo
```

This runs the actual collection orchestrator against `examples/collector_session.mjs`, which supplies invented responses. It makes no network calls, loads no browser dependency and uses no login. Outputs are marked `synthetic: true` under `data/collector-demo/run/`.

The demo exercises inquiry, visitor and advertising branches. It sets `enrich-limit=0`, so live HTML/CRM enrichment is not simulated in this example. Parser/enrichment tests cover those separate steps with synthetic fixtures.

```bash
node scripts/inquiries.mjs import-member-bundle --file data/collector-demo/run/inquiry-member-bundle.json --store demoalpha --db data/collector-demo/import.sqlite
```

## Optional browser transport

The offline project still needs no npm dependency. For real account reads, install the pinned optional adapter:

```bash
npm install --prefix .deps --no-save --no-package-lock --ignore-scripts playwright-core@1.60.0
```

The `.deps/` directory is ignored by Git. The collector uses a fixed local dependency path; a JSON config cannot select arbitrary JavaScript modules. Playwright Core does not supply an authenticated browser or download your profile.

Provide an already-running Chromium browser you own, with a loopback HTTP CDP endpoint. The collector does not launch a browser, migrate a profile, change an account or solve login/captcha prompts. It closes only tabs it created and disconnects its CDP attachment when finished.

See the official [CDP connection](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp) and [connected-browser close semantics](https://playwright.dev/docs/api/class-browser#browser-close).

## Private live configuration

Create `data/collector.json` locally. Replace every placeholder using the current, independently verified account identity:

```json
{
  "store": "your-verified-minisite-slug",
  "cdp": "http://127.0.0.1:9222/",
  "expectedHost": "your-verified-minisite-slug.en.alibaba.com",
  "companyId": "REPLACE_WITH_VERIFIED_DIGITS",
  "adminAliId": "REPLACE_WITH_VERIFIED_DIGITS"
}
```

The config accepts exactly these five fields. Use strings for long IDs. Do not put cookies, tokens, headers or session exports in it. The placeholder file is intentionally unusable until the identity is configured. The endpoint must be loopback HTTP without userinfo, query, fragment or a custom path.

The connection is checked against the seller-profile response using all three identity values. Each business read is checked before and after execution. A browser label, port number, a matching company name or an older mapping is not identity proof.

## Live CLI

Inspect help without installing the browser dependency or reading a config:

```bash
npm run collect -- --help
```

Read a bounded inquiry sample:

```bash
npm run collect -- --config data/collector.json --out data/run-01 --from 2026-01-01 --to 2026-01-07 --chains inquiries --page-size 3 --max-pages 1 --enrich-limit 1
```

Read selected chains together, with an explicit advertising plan:

```bash
npm run collect -- --config data/collector.json --out data/run-02 --from 2026-01-01 --to 2026-01-07 --chains inquiries,visitors,opportunities --campaign-id REPLACE_WITH_VERIFIED_PLAN_ID --page-size 3 --max-pages 1 --detail-pages 2 --enrich-limit 1
```

Dates are explicit inclusive Beijing calendar dates, at most 31 days. Limits: at most 100 rows/page, 10 pages/report or date, 10 detail pages and 20 enrichment records. Defaults are 3 rows, 1 page, 2 detail pages and 1 enrichment. The default chain is `inquiries`; ads are never selected merely by omitting `--chains`.

Both config and output belong under ignored `data/`. Symlinked/escaping paths and existing output directories are rejected before a connection. A successful read writes `collection.json`, `receipt.json` and, for inquiries, `inquiry-member-bundle.json`. The console receipt contains counts and coverage, not session tokens or raw query URLs.

## Coverage and interpretation

- Inquiry results remain `sample_only`; a total of `99999` is retained as an unverified sentinel/cap. Small successful samples do not establish full period coverage.
- Visitor totals are sums of daily records, not period-unique people. The filter is inquiry-associated visitors. Repeated identical detail events are retained because the endpoint does not provide an event ID.
- Advertising reads require plan metadata to match the requested ID/type/optimization target and the current scene configuration. A successful empty response is not treated as proof of complete account coverage.
- Buyer level, repeat flags, low-quality flags, tags and order counts retain their source meaning. They do not automatically establish a new company customer, credit approval, conversion or verified payment.
- Enrichment step statuses and source gaps remain in the output. A receipt's `read_completed` is not a formal research or full-coverage certificate.

## Verified-host contract for browser adapters

Each low-level adapter requires explicit configuration in its corresponding `window` field, plus `storeProof`, `browserBinding` and `requestId`. The proof must be the current seller proof for that exact request, store host and browser route, with an observation age below five minutes. The host must execute on the selected route and independently recheck identity before accepting output; a caller-supplied JSON object alone cannot authenticate the active page.

| Adapter | Configuration field |
|---|---|
| Inquiry list | `window.__LEW_INQUIRY_LIST_CONFIG__` |
| Inquiry/member bundle | `window.__LEW_INQUIRY_EXPORT_CONFIG__` |
| Buyer-level sidecar | `window.__LEW_BUYER_LEVEL_CONFIG__` |
| Exact customer link | `window.__LEW_CUSTOMER_LINK_CONFIG__` |
| Member-order candidates | `window.__LEW_ORDER_EXPORT_CONFIG__` |
| Assignment/public pool | `window.__LEW_OWNERSHIP_EXPORT_CONFIG__` |
| Visitor sample | `window.__LEW_VISITOR_EXPORT_CONFIG__` |
| Advertising report | `window.__LEW_ADS_EXPORT_CONFIG__` |

The adapters keep their original pagination and sample limits. They have no publisher account or campaign defaults. Missing configuration, stale/mismatched proof or a failed read must not be accepted as an empty successful export. Login challenges and authorization prompts are handled by the operator through the supported host.

## Validation and private output

Offline tests exercise request/method/field guards, identity mismatches, credential redaction, output containment, cleanup, parsers and synthetic orchestration. A separately supplied `READONLY_SAMPLE_DIR` can enable the optional private local-response replay; the repository contains no such samples, and CI does not provide one.

This code-publication task does not connect to a real account or certify live access. Recheck the current platform behavior using a small explicitly authorized sample before a production collection. Keep the resulting records, account mappings, logs and reports private, as described in [the privacy model](privacy.md).
