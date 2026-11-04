# Release verification

The initial public source snapshot was validated on Windows with Node.js 24 and Python 3.12 in a newly created virtual environment. Dependencies were installed from the published `requirements.txt`; no authenticated account or real customer input was used.

| Check | Observed result |
|---|---|
| Core Node regressions | 241 passed, no failures or skips |
| Core Python regressions | 131 passed |
| Formal workflow regressions | 54 passed |
| Operational synthetic demo | Metrics, HTML dashboard and XLSX workbook generated |
| Dashboard browser check | No JavaScript errors; changing the store filter changed the visible rows |
| Responsive smoke check | Desktop and mobile viewports rendered using invented data |
| Formal synthetic demo | Three invented customers, zero matches; completed with explicit limitations |
| Source/privacy checks | Tracked paths and source-only release reviewed; credential scan performed before publication |

The browser screenshot in the README comes from the actual local demo. It contains no business records.

The offline formal demo intentionally records unconfirmed identity and incomplete external-list coverage. It is not a real research run or a completed sanctions check. The positive-match PDF path still requires an installed browser, suitable fonts and a hash-bound human visual receipt; ordinary unit tests do not certify a user's PDF environment.

The GitHub Actions workflow runs the same offline suite on Ubuntu and Windows. Read its actual result for cross-platform verification rather than treating this local record as proof of a hosted run. The test launcher enables UTF-8 explicitly on Windows.

The public release deliberately rejects unknown private frozen collector versions. Tests cover published-source replay, changed evidence, malformed identities, duplicate keys, misleading same-name matches, cross-inquiry citation errors and altered rule/evidence bindings.
