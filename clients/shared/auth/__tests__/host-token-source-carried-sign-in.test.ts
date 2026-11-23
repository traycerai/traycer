import { describe, expect, it, vi } from "vitest";
import type {
  HostToken,
  HostTokenChange,
  HostTokenTable,
} from "../host-token-store";
import {
  createHostTokenSource,
  createMemoryHostTokenPersistence,
  hostSignInKey,
  type HostTokenAsk,
  type HostTokenMintOutcome,
  type HostTokenPersistence,
  type OrderedMintAnswer,
  type IdentifyingHostTokenSource,
} from "../host-token-source";
import { createReleasedHostMemory } from "../../host-transport/released-sign-on";

/**
 * What the source hands back for a mint carries, in its type, the digest of
 * the sign-in it stands for: a refusal, the sign-in the refused request was
 * sent with; a token, the sign-in the token handed back was minted with,
 * which is not the asker's when a later-issued held token answers. Purchase
 * evidence (the process, the sign-in and the order of a request whose token
 * the source KEPT) rides beside it and is null for everything else. Nothing
 * carries either through an announce, a listener or a record, and the digest
 * is never the raw sign-in. A refusal is recorded at the source only while it
 * still stands for the pair.
 */

const USER_ID = "user-a";
const HOST_ID = "computer-carried-sign-in";
const HEX_DIGEST = /^[0-9a-f]{64}$/;

function signInToken(label: string): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: 2_000_000, jti: label }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

function hostTokenIssuedAt(label: string, issuedAtSeconds: number): HostToken {
  const payload = Buffer.from(
    JSON.stringify({ iat: issuedAtSeconds, jti: label }),
  ).toString("base64url");
  return {
    token: `header.${payload}.signature`,
    expiresAtMs: Date.now() + 3_600_000,
  };
}

const SIGN_IN_A = signInToken("sign-in-a");
const SIGN_IN_B = signInToken("sign-in-b");
const DIGEST_A = hostSignInKey(SIGN_IN_A);
const DIGEST_B = hostSignInKey(SIGN_IN_B);

/** What a mint's read hands back: the outcome, the digest, and the purchase evidence. */
interface Identified {
  readonly outcome: HostTokenMintOutcome;
  readonly signIn: string | null;
  readonly order: unknown;
  readonly purchase: unknown;
}

async function identify(
  tokens: IdentifyingHostTokenSource,
  fresh: boolean,
  ask: HostTokenAsk,
): Promise<Identified> {
  const read: unknown = await tokens.obtainIdentified(
    USER_ID,
    HOST_ID,
    fresh,
    ask,
  );
  const signIn: unknown = Reflect.get(Object(read), "signIn");
  return {
    outcome: Reflect.get(Object(read), "outcome"),
    signIn: typeof signIn === "string" ? signIn : null,
    order: Reflect.get(Object(read), "order"),
    purchase: Reflect.get(Object(read), "purchase"),
  };
}

interface PurchaseFields {
  readonly owner: unknown;
  readonly signIn: unknown;
  readonly order: unknown;
}

/** The purchase evidence's fields, or `null` when the read carries none. */
function purchaseOf(read: Identified): PurchaseFields | null {
  if (read.purchase === null || read.purchase === undefined) return null;
  return {
    owner: Reflect.get(Object(read.purchase), "owner"),
    signIn: Reflect.get(Object(read.purchase), "signIn"),
    order: Reflect.get(Object(read.purchase), "order"),
  };
}

/** A persistence that already holds `table`, as a token file read at start does. */
function persistenceHolding(table: HostTokenTable): HostTokenPersistence {
  let held = table;
  return {
    load: () => Promise.resolve(held),
    update: (change) => {
      held = change(held);
      return Promise.resolve(held);
    },
  };
}

function rig(persistence: HostTokenPersistence) {
  let stored = SIGN_IN_A;
  const hosts = createReleasedHostMemory();
  hosts.observeInstance(HOST_ID, "process-a");
  const owner = hosts.currentInstance(HOST_ID);
  const mints: Array<{
    readonly signIn: string;
    readonly answer: (answer: HostTokenMintOutcome | OrderedMintAnswer) => void;
  }> = [];
  const tokens = createHostTokenSource({
    persistence,
    mint: (_hostId, sentWith) =>
      new Promise<HostTokenMintOutcome | OrderedMintAnswer>((resolve) => {
        mints.push({ signIn: sentWith, answer: resolve });
      }),
    signIn: (userId) => (userId === USER_ID ? stored : null),
    now: () => Date.now(),
  });
  const ask = { signal: null, owner, observedNow: () => owner.observed };
  return {
    tokens,
    mints,
    owner,
    ask,
    moveSignInTo: (next: string): void => {
      stored = next;
    },
  };
}

describe("what the source hands back for a mint carries the sign-in it stands for", () => {
  it("carries, on a refusal, the digest of the sign-in the refused request was sent with, though the stored one has moved, and no purchase", async () => {
    const { tokens, mints, ask, moveSignInTo } = rig(
      createMemoryHostTokenPersistence(),
    );
    await tokens.whenLoaded();
    const refused = identify(tokens, true, ask);
    await vi.waitFor(() => expect(mints).toHaveLength(1));
    moveSignInTo(SIGN_IN_B);

    mints[0].answer({ kind: "sign-in-rejected" });
    const read = await refused;

    expect(read.outcome.kind).toBe("sign-in-rejected");
    expect(read.signIn).toBe(DIGEST_A);
    expect(read.signIn).toMatch(HEX_DIGEST);
    expect(typeof read.order).toBe("number");
    expect(purchaseOf(read)).toBeNull();
  });

  it("carries, on a token the source kept, the digest of the sign-in it was minted with and the purchase evidence of its request", async () => {
    const { tokens, mints, ask, owner, moveSignInTo } = rig(
      createMemoryHostTokenPersistence(),
    );
    await tokens.whenLoaded();
    moveSignInTo(SIGN_IN_B);
    const minted = identify(tokens, true, ask);
    await vi.waitFor(() => expect(mints).toHaveLength(1));

    mints[0].answer({ kind: "ok", token: hostTokenIssuedAt("on-b", 2_000) });
    const read = await minted;

    expect(read.outcome.kind).toBe("ok");
    expect(read.signIn).toBe(DIGEST_B);
    const purchase = purchaseOf(read);
    expect(purchase).toMatchObject({ owner, signIn: DIGEST_B });
    expect(typeof purchase?.order).toBe("number");
  });

  it("carries the digest of the sign-in a later-issued held token was minted with, not the asker's, and no purchase of this ask, when that token answers", async () => {
    const { tokens, mints, ask, moveSignInTo } = rig(
      createMemoryHostTokenPersistence(),
    );
    await tokens.whenLoaded();
    // The ask on A is sent first, and held.
    const onA = identify(tokens, true, ask);
    await vi.waitFor(() => expect(mints).toHaveLength(1));
    expect(mints[0].signIn).toBe(SIGN_IN_A);
    // The sign-in moves to B; a later ask mints on B, and its newer token is kept.
    moveSignInTo(SIGN_IN_B);
    const onB = identify(tokens, true, ask);
    await vi.waitFor(() => expect(mints).toHaveLength(2));
    const newer = hostTokenIssuedAt("minted-on-b", 2_000);
    mints[1].answer({ kind: "ok", token: newer });
    const keptOnB = await onB;
    expect(keptOnB.outcome).toMatchObject({ kind: "ok", token: newer });
    expect(purchaseOf(keptOnB)).toMatchObject({ signIn: DIGEST_B });

    // A's older token answers after: the write declines it, and the token
    // held, minted on B, is what the ask on A is handed back.
    mints[0].answer({
      kind: "ok",
      token: hostTokenIssuedAt("minted-on-a", 1_000),
    });
    const read = await onA;

    expect(read.outcome).toMatchObject({ kind: "ok", token: newer });
    expect(read.signIn).toBe(DIGEST_B);
    expect(read.signIn).not.toBe(DIGEST_A);
    expect(purchaseOf(read)).toBeNull();
  });

  it("carries, on a token its process check declined to store, the digest of the sign-in it was minted with and no purchase", async () => {
    const { tokens, mints, owner } = rig(createMemoryHostTokenPersistence());
    await tokens.whenLoaded();
    let observedNow = owner.observed;
    const minted = identify(tokens, true, {
      signal: null,
      owner,
      observedNow: () => observedNow,
    });
    await vi.waitFor(() => expect(mints).toHaveLength(1));
    // The host process is replaced while the mint is out: nothing is stored.
    observedNow = `${owner.observed}-replaced`;

    const token = hostTokenIssuedAt("not-wanted", 2_000);
    mints[0].answer({ kind: "ok", token });
    const read = await minted;

    expect(read.outcome).toMatchObject({ kind: "ok", token });
    expect(tokens.current(USER_ID, HOST_ID)).toBeNull();
    expect(read.signIn).toBe(DIGEST_A);
    expect(purchaseOf(read)).toBeNull();
  });

  it("carries no purchase for a joiner of a flight another request bought, and the flight's for its starter", async () => {
    const { tokens, mints, ask, owner } = rig(
      createMemoryHostTokenPersistence(),
    );
    await tokens.whenLoaded();
    const starter = identify(tokens, true, ask);
    await vi.waitFor(() => expect(mints).toHaveLength(1));
    const joiner = identify(tokens, true, ask);

    mints[0].answer({ kind: "ok", token: hostTokenIssuedAt("shared", 2_000) });
    const [started, joined] = await Promise.all([starter, joiner]);

    expect(mints).toHaveLength(1);
    expect(purchaseOf(started)).toMatchObject({ owner, signIn: DIGEST_A });
    expect(joined.signIn).toBe(DIGEST_A);
    expect(purchaseOf(joined)).toBeNull();
  });

  it("carries the flight's purchase, with the flight's order, on the joiner whose write is the one kept when the starter has ended", async () => {
    const { tokens, mints, owner } = rig(createMemoryHostTokenPersistence());
    await tokens.whenLoaded();
    const starterEnds = new AbortController();
    let starterObserved = owner.observed;
    const starter = identify(tokens, true, {
      signal: starterEnds.signal,
      owner,
      observedNow: () => starterObserved,
    });
    await vi.waitFor(() => expect(mints).toHaveLength(1));
    const joiner = identify(tokens, true, {
      signal: null,
      owner,
      observedNow: () => owner.observed,
    });
    // The starter ends: its signal aborts and its own check no longer holds,
    // so only the joiner's write can be kept.
    starterEnds.abort();
    starterObserved = `${owner.observed}-ended`;

    mints[0].answer({
      outcome: { kind: "ok", token: hostTokenIssuedAt("flight", 2_000) },
      order: 7,
    });
    const [started, joined] = await Promise.all([starter, joiner]);

    expect(mints).toHaveLength(1);
    expect(purchaseOf(started)).toBeNull();
    expect(purchaseOf(joined)).toMatchObject({
      owner,
      signIn: DIGEST_A,
      order: 7,
    });
  });

  it("carries no purchase for a cache hit, which names the sign-in its token was minted with", async () => {
    const { tokens, mints, ask } = rig(createMemoryHostTokenPersistence());
    await tokens.whenLoaded();
    const minted = identify(tokens, true, ask);
    await vi.waitFor(() => expect(mints).toHaveLength(1));
    mints[0].answer({ kind: "ok", token: hostTokenIssuedAt("cached", 2_000) });
    await minted;

    const hit = await identify(tokens, false, ask);

    expect(hit.outcome.kind).toBe("ok");
    expect(mints).toHaveLength(1);
    expect(hit.signIn).toBe(DIGEST_A);
    expect(purchaseOf(hit)).toBeNull();
  });

  it("carries neither a sign-in nor a purchase for a token read from the file", async () => {
    const fileToken = hostTokenIssuedAt("from-the-file", 2_000);
    const { tokens, mints, ask } = rig(
      persistenceHolding(new Map([[USER_ID, new Map([[HOST_ID, fileToken]])]])),
    );
    await tokens.whenLoaded();

    const hit = await identify(tokens, false, ask);

    expect(hit.outcome).toMatchObject({ kind: "ok", token: fileToken });
    expect(mints).toHaveLength(0);
    expect(hit.signIn).toBeNull();
    expect(purchaseOf(hit)).toBeNull();
  });

  it("carries none on a superseded ask", async () => {
    const { tokens, mints, ask } = rig(createMemoryHostTokenPersistence());
    await tokens.whenLoaded();
    const superseded = identify(tokens, true, ask);
    await vi.waitFor(() => expect(mints).toHaveLength(1));
    await tokens.forgetUser(USER_ID);

    mints[0].answer({ kind: "ok", token: hostTokenIssuedAt("late", 2_000) });
    const read = await superseded;

    expect(read.outcome.kind).toBe("superseded");
    expect(read.signIn).toBeNull();
    expect(purchaseOf(read)).toBeNull();
  });

  it("carries none on an unavailable mint", async () => {
    const { tokens, mints, ask } = rig(createMemoryHostTokenPersistence());
    await tokens.whenLoaded();
    const unreachable = identify(tokens, true, ask);
    await vi.waitFor(() => expect(mints).toHaveLength(1));

    mints[0].answer({ kind: "unavailable", detail: "authn unreachable" });
    const read = await unreachable;

    expect(read.outcome.kind).toBe("unavailable");
    expect(read.signIn).toBeNull();
    expect(purchaseOf(read)).toBeNull();
  });

  it("puts nothing it carries on what it announces or records, and the digest is never the raw sign-in", async () => {
    const { tokens, mints, ask } = rig(createMemoryHostTokenPersistence());
    await tokens.whenLoaded();
    const announced: HostTokenChange[] = [];
    tokens.subscribe((change) => {
      announced.push(change);
    });
    const minted = identify(tokens, true, ask);
    await vi.waitFor(() => expect(mints).toHaveLength(1));
    mints[0].answer({
      kind: "ok",
      token: hostTokenIssuedAt("announced", 2_000),
    });
    const kept = await minted;
    const refused = identify(tokens, true, ask);
    await vi.waitFor(() => expect(mints).toHaveLength(2));
    mints[1].answer({ kind: "sign-in-rejected" });
    const refusal = await refused;

    // The digest is on what is handed back, and is not the sign-in itself.
    expect(kept.signIn).toBe(DIGEST_A);
    expect(refusal.signIn).toBe(DIGEST_A);
    expect(DIGEST_A).not.toBe(SIGN_IN_A);
    // The announce carries the change and nothing else.
    expect(announced).toEqual([
      { userId: USER_ID, hostId: HOST_ID, replaced: null },
    ]);
    expect(JSON.stringify(announced)).not.toContain(DIGEST_A);
    // What a reader of the record is handed is the refusal's kind alone.
    const failure = tokens.lastFailureOf(USER_ID, ask.owner);
    expect(failure).toBe("sign-in-rejected");
    expect(JSON.stringify(failure)).not.toContain(DIGEST_A);
  });
});

describe("a refusal is recorded at the source only while it still stands for the pair", () => {
  it("records none for a request that a later-started write, which was kept, has outlived", async () => {
    const { tokens, mints, owner } = rig(createMemoryHostTokenPersistence());
    const otherProcess = createReleasedHostMemory();
    otherProcess.observeInstance(HOST_ID, "process-b");
    const laterOwner = otherProcess.currentInstance(HOST_ID);
    await tokens.whenLoaded();
    // The refused request starts first, and is held.
    const refused = identify(tokens, true, {
      signal: null,
      owner,
      observedNow: () => owner.observed,
    });
    await vi.waitFor(() => expect(mints).toHaveLength(1));
    // A later request for the same pair on the same sign-in starts, and its write is kept.
    const later = identify(tokens, true, {
      signal: null,
      owner: laterOwner,
      observedNow: () => laterOwner.observed,
    });
    await vi.waitFor(() => expect(mints).toHaveLength(2));
    mints[1].answer({ kind: "ok", token: hostTokenIssuedAt("later", 2_000) });
    await later;

    mints[0].answer({ kind: "sign-in-rejected" });
    await refused;

    expect(tokens.lastFailureOf(USER_ID, owner)).toBeNull();
  });
});
