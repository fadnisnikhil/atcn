# @atcn/schema

The data formats and signing used throughout [ATCN](https://github.com/fadnisnikhil/atcn): wire schemas, canonical JSON (RFC 8785, so the same data always gives the same bytes), Ed25519 signatures and webhook signatures. It also ships JSON Schemas (`schemas/`) and test vectors (`test-vectors/`) for implementing ATCN in another language.

Most people get these through [`@atcn/sdk`](https://www.npmjs.com/package/@atcn/sdk); use this package when you only need the formats and signing.

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

Versioning and compatibility rules: [COMPATIBILITY.md](https://github.com/fadnisnikhil/atcn/blob/main/packages/schema/COMPATIBILITY.md). Part of [ATCN](https://github.com/fadnisnikhil/atcn). Apache-2.0.
