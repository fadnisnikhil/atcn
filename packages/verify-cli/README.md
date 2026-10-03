# @atcn/verify-cli

`atcn-verify` checks ATCN documents offline, without contacting anyone. It accepts these documents:

- subledger task closures;
- provider receipts;
- obligation closure packages.

```bash
npx @atcn/verify-cli task-closure.json --keys keys.json --obligation-package obligation.json
```

Options:

- **`--keys`:** a JSON array of public key records, or `{"items": [...]}`.
- **`--previous`:** checks the chain link to the previous revision.
- **`--operator-keys` and `--require-operator-signature`:** check operator countersignatures.
- **`--obligation-package`:** cross-checks a closure's linked obligations against their closure packages. You can repeat it.
- **`--json`:** prints the report as JSON.

Exit codes:

- `0`: valid.
- `1`: invalid.
- `2`: usage or input error.
- `3`: unsupported schema version, so upgrade `atcn-verify`.

Supported subledger schema versions are `1.2` and `1.3`; see [COMPATIBILITY.md](../schema/COMPATIBILITY.md).

A valid signature attests to what the signer stated, not to the truth of the underlying work or payment. Part of [ATCN](../../README.md). Apache-2.0.
