# Privacy and publication model

This repository distributes software and invented examples. Customer records, source observations, business results and authenticated environments are private runtime inputs.

## What is excluded

`data/`, `outputs/`, `exports/`, `work/`, `envs/`, browser profiles, local assistant configuration, credentials, databases, workbooks and PDFs are ignored. Internal handoffs, historical business baselines, account inventories and the development repository's Git history are not part of the public release.

Sample companies, messages and store names are invented. Real deployment must use a user's explicitly authorized inputs and independently verified account bindings. No personal machine paths or publisher store identities are needed to use the project.

## Evidence is still sensitive

Source hashes establish a binding; they do not anonymize the underlying information. Email, phone and WhatsApp values may be valid local research clues, but that does not make them appropriate for a public issue, commit or dashboard. Exact account binding does not prove company authority, contact consent or payment.

Generated HTML embeds reviewed records so it can work without a server. Treat the HTML, workbook, PDF, state directory and observations as private business files. Do not upload them to a public static host merely because the source code is public.

Account collection uses private configuration under `data/`, not credentials committed to the repository. Session hints stay in memory; persisted collection payloads remove transport fields and credential-bearing text/URLs. Business identifiers such as a visitor's `buyerCookieId` can remain necessary for local association and are still private business data. A successful credential filter does not make a collected record anonymous or suitable for publication.

## Before committing

Run `npm run check:privacy`, review `git diff --cached` and scan the entire history that will be published with a credential scanner such as [Gitleaks](https://github.com/gitleaks/gitleaks). A scanner cannot determine whether a company, account ID or business statement is private; human source review is also required.

Do not post access-bearing URLs, browser storage, cookies, authentication headers, raw account exports or screenshots of real records. Report security concerns privately using [SECURITY.md](../SECURITY.md).

## Public release boundary

The initial public snapshot is an independent source-only repository with fresh commits. It includes rewritten public documentation, caller-supplied store keys, synthetic tests, original component notices and current-source evidence gates. It excludes development history and data migration paths. This boundary avoids making internal history accessible through an ordinary visibility change.

Removing a current file does not remove it from Git history. If an actual secret is exposed, revoke or rotate it before coordinating history cleanup; see [GitHub's sensitive-data removal guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).
