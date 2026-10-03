# @atcn/schema

Wire schemas, canonical JSON (RFC 8785), Ed25519 signing and webhook signatures for ATCN. Includes JSON Schemas (`schemas/`) and the signing test vectors (`test-vectors/`).

```bash
npm install @atcn/schema
```

```ts
import { canonicalize, generateKeyPair, signPayload, verifyPayload } from "@atcn/schema";

canonicalize({ b: 1, a: 2 }); // '{"a":2,"b":1}'
const { privateKey, publicKey } = generateKeyPair();
const signed = signPayload({ hello: "world" }, { keyId: "key_1", keyVersion: 1, privateKey });
verifyPayload(signed, publicKey); // true
```

Versioning and compatibility rules: [COMPATIBILITY.md](COMPATIBILITY.md). Part of [ATCN](../../README.md). Apache-2.0.
