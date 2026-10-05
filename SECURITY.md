# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub:
[Report a vulnerability](https://github.com/fadnisnikhil/atcn/security/advisories/new). Do not open a public issue,
pull request or discussion for a security problem.

Include the package and version, what an attacker can do, and the smallest input or steps that show it. A signed
document that verifies when it should not, or fails when it should pass, is the most useful kind of report.

You will get an acknowledgement within 3 working days and an assessment within 10. Fixes ship as a patch release of
every package (they share one version), with a GitHub security advisory that credits you unless you prefer otherwise.

## Supported versions

Only the latest release line gets security fixes. Today that is 1.5.x of every `@atcn/*` npm package, `atcn-sdk` on
npm, and `atcn` on PyPI. Documents signed by older versions keep verifying with the latest verifier.

## What counts

In scope:

- signing and offline verification: a forged, altered, replayed or wrongly scoped document that `verify*` functions or
  `atcn-verify` report as valid, or a valid document they reject;
- canonical JSON (RFC 8785) and digest differences between the TypeScript and Python implementations;
- the verifiers in `@atcn/verifiers` passing evidence they should fail;
- importers and SDKs: input that crashes them, runs code, or reads files it was not given;
- the local runner and MCP server: writing outside their data directory, or leaking a private key.

Out of scope:

- what a valid signature means: it proves who signed a record, not that the work happened or a payment was made;
- budget limits that are exceeded: ATCN records and reports, it never blocks, reserves or moves money;
- the bundled demo keys and sample data, which are public on purpose;
- findings that need a stolen private key, unless ATCN made the theft possible.

## Handling keys

Private keys never leave the machine that made them: the local runner keeps its key in its data directory, and the
SDKs sign in your process. If a key leaks, rotate it and revoke the old key: documents it signed before the revocation
still verify, and anything it signs afterwards fails verification.
