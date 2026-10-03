# atcn (Python SDK)

The ATCN Python SDK. It covers:

- **Signing.** RFC 8785 canonical JSON, Ed25519 signing, and obligation event signing with `EventSigner`.
- **Webhooks.** `verify_webhook` and `sign_webhook`.
- **API clients.** `AtcnClient` is for the clearing network. `SubledgerClient` and `CaptureQueue` record tasks, delegations and charges. `ReceiptLinkClient` is for providers.
- **Provider response statements.** `build_response_statement`, `sign_statement` and `verify_statement_signature`.

It passes the same signing test vectors as the TypeScript SDK.

```bash
pip install atcn
```

```python
from atcn import canonicalize, generate_key_pair, sign_payload, verify_payload

canonicalize({"b": 1, "a": 2})  # '{"a":2,"b":1}'
private_key, public_key = generate_key_pair()
signed = sign_payload({"hello": "world"}, "key_1", 1, private_key)
assert verify_payload(signed, public_key)
```

The API clients need an ATCN API at `base_url`. The hosted API is not open for signup yet.

The Python SDK does not verify task closures or receipts. Use `npx @atcn/verify-cli` or the TypeScript SDK for that.

`python -m atcn init` records whether this machine shares anonymous usage metrics. Reporting is off by default and needs `ATCN_USAGE_URL`; see the [usage data documentation](https://github.com/OWNER/atcn/blob/main/docs/USAGE_DATA.md).

Apache-2.0.
