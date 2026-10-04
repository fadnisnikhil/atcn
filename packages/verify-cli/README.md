# @atcn/verify-cli

`atcn-verify` checks a signed [ATCN](https://github.com/fadnisnikhil/atcn) document on your machine, without contacting anyone. Use it when someone sends you a task closure, a receipt or a closure package and you want to know whether it's genuine and whether its numbers add up.

It checks the signatures, recomputes the totals and exceptions from the records inside, and prints each check with its result. It accepts:

- task closures (the signed summary of an agent job and its costs);
- provider receipts (what one provider sees of a task);
- obligation closure packages (the signed record of paid work and how it was accepted);
- clearing verdicts (an obligation's decision, for a payment rail to read).

```bash
npx @atcn/verify-cli task-closure.json --keys keys.json
```

To try it, run `npx @atcn/local-runner demo`: it writes a closure, its keys and its closure packages, and prints the exact `atcn-verify` command to check them.

## Options

- **`--keys`:** the signer's public keys, as a JSON array of key records or `{"items": [...]}`.
- **`--obligation-package`:** cross-checks a closure's linked obligations against their closure packages. You can repeat it. For a clearing verdict, pass the one package it was read from.
- **`--previous`:** checks the link to the previous version of a closure or revision of a receipt.
- **`--operator-keys` and `--require-operator-signature`:** check operator countersignatures.
- **`--trace <trace.json>`:** supplies an agent trace file. You can repeat it. For a closure package, each trace is rechecked against the declared runs and every `usage_cost` result is recomputed from the terms' pricing. For a receipt or closure, each recorded usage summary is recomputed from its trace. Usage whose trace you did not supply is reported as `NOT INSPECTED`, which is neither a pass nor a failure.
- **`--at <ISO-8601 time>`:** checks a receipt's `expires_at` against that time instead of now, for example the time you received it.
- **`--json`:** prints the report as JSON.

## Exit codes

- `0`: valid.
- `1`: invalid.
- `2`: usage or input error.
- `3`: unsupported schema version, so upgrade `atcn-verify`.

Supported subledger schema versions are `1.2` to `1.5`; see [compatibility](https://github.com/fadnisnikhil/atcn/blob/main/packages/schema/COMPATIBILITY.md).

A valid signature shows who stated something and that it hasn't changed since. It doesn't prove the work or payment really happened; each claim carries a label saying who stands behind it.

Part of [ATCN](https://github.com/fadnisnikhil/atcn). Apache-2.0.
