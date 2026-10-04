# x402 payments: link each payment record to the work it bought

A research agent prepares one customer brief by buying three resources over [x402](https://github.com/x402-foundation/x402) v2 (the `exact` scheme, USDC on Base Sepolia). ATCN records each purchase on the job, keeping payment and delivery as separate facts, and signs a closure that verifies offline.

```bash
npm ci              # from the repository root
npm run demo:x402
```

The sellers and the facilitator are local stand-ins. No chain is contacted, no wallet is needed, and no money moves.

## What happens

| Seller | Price | x402 outcome | Recorded |
| --- | --- | --- | --- |
| Delta Data | 2.50 USDC | 200, settled | delegation, completion claim, charge, payment report |
| Echo Translate | 0.40 USDC | 200, settled | delegation, completion claim, charge, payment report |
| Foxtrot Render | 0.10 USDC | 402, `settlement_pending` | delegation, provider failure, charge; no payment report |

```text
roll-up
  net cost USD 3.00 (charged USD 3.00)
  reported paid USD 2.90, unresolved USD 0.10

open exceptions: 2
  missing_receipt: billed 10 USD with no completion receipt recorded
  charge_after_cancellation: the delegation is provider failed but 10 USD is still billed; a refund, credit or reversal of it would net it to zero
```

Foxtrot Render's settlement was broadcast but not confirmed, so the seller returned no result. The transaction may still confirm. ATCN keeps the USD 0.10 unresolved and flags it as billed without delivery, so someone checks the chain and asks for a refund if needed.

## How a purchase is recorded

[`recordX402Purchase`](src/record.ts) reads only the decoded x402 headers:

| x402 | ATCN |
| --- | --- |
| EIP-3009 `authorization.nonce` (signed by the payer, emitted on chain when the transfer executes) | delegation `provider_job_ref`; charges match on it |
| `accepted` payment requirements | delegation `terms_digest`, `quoted_max_minor` and `quote_basis` |
| `resource.serviceName`, `network` + `payTo` | provider name and `provider_own_id` |
| HTTP 200 response body | `completion` claim citing the body's SHA-256 digest |
| `PAYMENT-RESPONSE` with a `transaction` | `charge` with the transaction hash as `provider_reference` and the settlement response's digest as evidence |
| `PAYMENT-RESPONSE` with `success: true` | `payment_reported`, settling that charge |

ATCN amounts use ISO 4217 currencies, so USDC is recorded as USD at 1:1, in cents. The exact atomic amount, asset and network stay in `quote_basis` and in the settlement digest. A price that is not a whole number of cents is refused rather than rounded.

## Using real x402

[`buyWithX402`](src/x402.ts) implements the v2 header exchange with a simulated signature. A real client signs the EIP-3009 authorization with the payer's wallet, for example with the x402 reference SDK, and pays a real facilitator. Pass the same decoded values (requirements, payment payload, response status and body, settlement response) to `recordX402Purchase`; nothing else changes.
