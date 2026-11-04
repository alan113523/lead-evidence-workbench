# Contributing

Start with an issue describing the concrete problem, input contract and expected behavior. Use invented examples; do not attach real account exports or buyer records.

1. Use Node.js 24+ and Python 3.12+, then install `requirements.txt` in a virtual environment.
2. Keep changes scoped. Preserve exact identities, source bindings and explicit unknown states.
3. Add meaningful synthetic coverage for changed behavior and run `npm test`.
4. Run `npm run check:privacy` and inspect the staged diff. Do not commit generated data, account configuration or research receipts.
5. Describe the behavior change, validation and remaining limits in the pull request.

Changes to formal rules invalidate existing rule hashes. Update the public contract and use a new run rather than editing an old run's state. Generated PDFs require actual visual inspection; unit tests do not replace it.

Contributions are submitted under the project's MIT license. Preserve existing component copyrights and third-party notices.
