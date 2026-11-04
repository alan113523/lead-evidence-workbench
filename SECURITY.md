# Security policy

Report credential exposure, account-binding bypasses, source-binding failures and unsafe report rendering using GitHub's **Report a vulnerability** feature on this repository when available. Do not put secrets or customer records in a public issue.

Include an affected version, a minimal synthetic reproduction, expected behavior and the practical impact. Redact account IDs and access-bearing URLs. Maintainers may request a smaller reproduction that contains no real data.

If an actual credential has been exposed, revoke or rotate it promptly. Removing a file or making a repository private does not retract existing copies. Coordinate any necessary Git history cleanup separately.

The current supported line is the latest public `main` branch. Live platform integrations can change independently; an offline regression passing does not verify current account access or a complete platform workflow.
