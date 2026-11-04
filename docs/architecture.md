# Architecture

The workbench uses files and SQLite instead of a background service. The offline demo is intentionally independent of accounts, browser sessions and an AI provider.

```text
scripts/             Core import, assessment, history and reporting modules
lib/                 Shared browser identity and chat-evidence validators
formal-review/       Optional staged research, reports and PDF workflow
tests/               Synthetic core regressions
docs/                Public usage, privacy and validation guides
data/                Ignored local input, evidence, databases and reports
```

## Identities and evidence

- An inquiry is scoped by `store_key + inquiry_id`.
- A buyer account is distinct from a company entity. A name match never merges accounts automatically.
- A company merge needs explicit reviewed evidence.
- Message references carry a source identity, source hash, time and inquiry scope.
- History reuse requires unchanged dependencies and a contiguous verified boundary. New conflicts remain review items.
- Unknown values are retained as unknown; a missing source is not an empty successful response.

`inquiry_store.mjs` maintains raw observations and current rows. `chat_collection.mjs` and `chat_window.mjs` prepare/accept explicitly executed collection tickets. `history_index.mjs` builds a private, rebuildable index. `buyer_profile_axes.mjs`, `opportunity_review.mjs` and `deep_communication.mjs` validate structured judgments. Python modules calculate metrics and render reports.

## Operational and formal workflows

Operational review produces a follow-up view. It is not a formal entity, sanctions or payment clearance. The `formal-review` package maintains a separate staged state, immutable inputs, cited observations and report gates. Its rule hash is computed from the public package's current rules and code.

The public operational schema namespace is `lew.*`. Some formal input and platform protocol identifiers are retained for format compatibility. They are format identifiers, not credentials or evidence of affiliation with a platform.

## Frozen sources

Public chat runs pin the exact published source bytes. The release does not carry private legacy source allowlists or search a user's old company-batch directories. Unknown frozen source versions are rejected. Changing the rule tree starts a new formal run; changing evidence invalidates its downstream bindings.

## Runtime boundaries

The demo and core transformations are local and offline. Collection adapters require an authorized browser host and live identity checks. Formal research requires an operator to obtain and document sources. UK-list screening is a separately invoked tool; it does not download or silently complete a missing check during the ordinary demo. Reports and state flags cannot authorize outreach or CRM writes.
