import { createHash } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { PAYMENT_REQUIRED, PAYMENT_RESPONSE, PAYMENT_SIGNATURE, decodeHeader, encodeHeader, type PaymentPayload, type PaymentRequired, type PaymentRequirements, type SettlementResponse } from "./x402.js";

/** USDC on Base Sepolia, as in the x402 specification's examples. 6 decimals: 10000 atomic units = USD 0.01. */
export const NETWORK = "eip155:84532";
export const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

interface PaidResource {
  path: string;
  serviceName: string;
  description: string;
  payTo: string;
  priceAtomic: string;
  /** How the simulated facilitator's settlement ends. */
  settlement: "success" | "settlement_pending";
  body: unknown;
}

/** Three sellers. The screenshot's settlement is broadcast but not confirmed, so the buyer gets a 402 and no result. */
export const RESOURCES: PaidResource[] = [
  {
    path: "/delta/company-profile",
    serviceName: "Delta Data",
    description: "Company profile: Acme Gears Ltd",
    payTo: "0x000000000000000000000000000000000000De17",
    priceAtomic: "2500000",
    settlement: "success",
    body: { company: "Acme Gears Ltd", founded: 1987, employees: 240 },
  },
  {
    path: "/echo/translate",
    serviceName: "Echo Translate",
    description: "Translate the profile summary to German",
    payTo: "0x000000000000000000000000000000000000EC40",
    priceAtomic: "400000",
    settlement: "success",
    body: { language: "de", text: "Acme Gears Ltd, gegründet 1987, 240 Mitarbeitende." },
  },
  {
    path: "/foxtrot/screenshot",
    serviceName: "Foxtrot Render",
    description: "Screenshot of acmegears.example",
    payTo: "0x000000000000000000000000000000000000F0C7",
    priceAtomic: "100000",
    settlement: "settlement_pending",
    body: { png_base64: "iVBORw0KGgo=" },
  },
];

/**
 * A stand-in for an x402 facilitator. It checks the payment against the requirements the way /verify does, and
 * "settles" by deriving a transaction hash from the nonce. No chain is contacted and no money moves.
 */
const usedNonces = new Set<string>();

function verify(payment: PaymentPayload, requirements: PaymentRequirements): string | null {
  const { authorization } = payment.payload;
  if (payment.accepted.scheme !== requirements.scheme || payment.accepted.network !== requirements.network) return "unsupported_scheme";
  if (authorization.to.toLowerCase() !== requirements.payTo.toLowerCase()) return "invalid_exact_evm_payload_recipient_mismatch";
  if (authorization.value !== requirements.amount) return "invalid_exact_evm_payload_authorization_value_mismatch";
  if (Number(authorization.validBefore) <= Date.now() / 1000) return "invalid_exact_evm_payload_authorization_valid_before";
  if (usedNonces.has(authorization.nonce)) return "invalid_exact_evm_payload_authorization_nonce_used";
  return null;
}

function settle(payment: PaymentPayload, outcome: PaidResource["settlement"]): SettlementResponse {
  const { authorization } = payment.payload;
  usedNonces.add(authorization.nonce);
  const transaction = `0x${createHash("sha256").update(authorization.nonce).digest("hex")}`;
  if (outcome === "settlement_pending") return { success: false, errorReason: "settlement_pending", transaction, network: NETWORK, payer: authorization.from };
  return { success: true, transaction, network: NETWORK, payer: authorization.from, amount: authorization.value };
}

export interface RunningSellers {
  url: string;
  close(): Promise<void>;
}

/** Serves the paid resources on a free localhost port, using the `authorization` flow: verify, run, settle, respond. */
export async function startSellers(): Promise<RunningSellers> {
  const app = express();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  for (const resource of RESOURCES) {
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: NETWORK,
      amount: resource.priceAtomic,
      asset: USDC,
      payTo: resource.payTo,
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    };
    const required = (error: string): PaymentRequired => ({
      x402Version: 2,
      error,
      resource: { url: `${url}${resource.path}`, description: resource.description, mimeType: "application/json", serviceName: resource.serviceName },
      accepts: [requirements],
    });

    app.get(resource.path, (req, res) => {
      const header = req.get(PAYMENT_SIGNATURE);
      if (!header) return void res.status(402).set(PAYMENT_REQUIRED, encodeHeader(required(`${PAYMENT_SIGNATURE} header is required`))).json({});
      const payment = decodeHeader<PaymentPayload>(header);
      const invalid = verify(payment, requirements);
      if (invalid) return void res.status(402).set(PAYMENT_REQUIRED, encodeHeader(required(invalid))).json({});
      const settlement = settle(payment, resource.settlement);
      if (!settlement.success) return void res.status(402).set(PAYMENT_RESPONSE, encodeHeader(settlement)).json({});
      res.status(200).set(PAYMENT_RESPONSE, encodeHeader(settlement)).json(resource.body);
    });
  }

  return {
    url,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
