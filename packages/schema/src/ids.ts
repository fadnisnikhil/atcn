const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const ID_PREFIXES = {
  tenant: "ten",
  principal: "prn",
  platform: "plt",
  agent: "agt",
  key: "key",
  obligation: "obl",
  event: "evt",
  evidence: "evd",
  verifierResult: "vrs",
  decision: "dec",
  postingBatch: "pbt",
  posting: "pst",
  settlementInstruction: "sti",
  settlementEvent: "ste",
  dispute: "dsp",
  user: "usr",
  apiKey: "apk",
  webhookEndpoint: "whe",
  webhookDelivery: "whd",
  reconciliationException: "rex",
  account: "acc",
  task: "tsk",
  delegation: "dlg",
  delegationEvent: "dle",
  financialEvent: "fev",
  match: "mch",
  allocation: "alc",
  subledgerException: "slx",
  receipt: "rcp",
  receiptShare: "shr",
  receiptResponse: "rsp",
  closure: "cls",
  provider: "prv",
  providerKeyBinding: "pkb",
  allocationRule: "alr",
  receiptDelivery: "rdl",
  responseDecision: "rdc",
  captureGap: "cgp",
  taskGrant: "tgr",
  domainChallenge: "dch",
  operatorKey: "opk",
  operatorSignature: "osg",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

/** ULID (time-ordered, 128-bit) with an entity prefix, e.g. obl_01J9Z... */
export function newId(kind: IdKind, now: number = Date.now()): string {
  return `${ID_PREFIXES[kind]}_${ulid(now)}`;
}

export function ulid(now: number = Date.now()): string {
  let time = "";
  let remaining = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }
  const random = new Uint8Array(16);
  crypto.getRandomValues(random);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[random[i] % 32];
  return time + rand;
}

export function idPattern(kind: IdKind): RegExp {
  return new RegExp(`^${ID_PREFIXES[kind]}_[0-9A-HJKMNP-TV-Z]{26}$`);
}

export function hasPrefix(id: string, kind: IdKind): boolean {
  return idPattern(kind).test(id);
}
