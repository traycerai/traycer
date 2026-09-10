import { describe, expect, it } from "vitest";
import { DesktopAuthSession } from "../desktop-auth-session";

/**
 * A bearer-SHAPED token: three base64url segments with a numeric `exp`. Not
 * signed - nothing here verifies - but a revocation is retained for the
 * bearer's lifetime, and a string that does not decode as a bearer is not
 * retained at all, so the fixtures have to look like the real thing.
 */
function bearer(name: string, expiresAtMs: number): string {
  const segment = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${segment({ alg: "RS256", kid: "k" })}.${segment({
    id: name,
    exp: Math.floor(expiresAtMs / 1_000),
  })}.sig`;
}

const ONE_HOUR_MS = 60 * 60_000;
const BEARER_1 = bearer("one", Date.now() + ONE_HOUR_MS);
const BEARER_2 = bearer("two", Date.now() + ONE_HOUR_MS);
const BEARER_3 = bearer("three", Date.now() + ONE_HOUR_MS);
const BEARER_4 = bearer("four", Date.now() + ONE_HOUR_MS);

const SIGNED_IN = {
  status: "signed-in" as const,
  token: BEARER_1,
  profile: { userId: "u1", userName: "Ada", email: "ada@example.com" },
};

describe("DesktopAuthSession.revokeVerification", () => {
  it("drops only the verification, keeps the session, and announces the change once", () => {
    const session = new DesktopAuthSession();
    session.setVerified(SIGNED_IN, session.beginSet());
    expect(session.get().verified).toBe(true);
    let changes = 0;
    session.on("change", () => {
      changes += 1;
    });

    session.revokeVerification(SIGNED_IN.token);

    // Same session, same status: nothing a renderer applies as a transition.
    expect(session.get()).toEqual({ ...SIGNED_IN, verified: false });
    expect(changes).toBe(1);
    // Idempotent: nothing left to withdraw, so nothing to announce.
    session.revokeVerification(SIGNED_IN.token);
    expect(changes).toBe(1);
  });

  it("drops a revoke naming a bearer the session no longer holds", () => {
    // Window A's terminal demotion of `bearer-1` reaches main AFTER window B
    // signed in and main verified `bearer-2`: IPC across renderers is
    // unordered. The stale revoke must not strip the new session.
    const session = new DesktopAuthSession();
    session.setVerified(SIGNED_IN, session.beginSet());
    session.setVerified({ ...SIGNED_IN, token: BEARER_2 }, session.beginSet());
    let changes = 0;
    session.on("change", () => {
      changes += 1;
    });

    session.revokeVerification(SIGNED_IN.token);

    expect(session.get()).toEqual({
      ...SIGNED_IN,
      token: BEARER_2,
      verified: true,
    });
    expect(changes).toBe(0);
  });

  it("retains a revoke for a bearer whose verification is still in flight, so its set lands unverified", () => {
    // `authSessionSet` awaits JWKS before storing. The renderer publishes
    // `bearer-2`, then receives the terminal verdict for it while main is
    // still verifying: the revoke arrives FIRST, naming a bearer main does not
    // hold yet. Dropping it as stale let the pending set complete as
    // `verified` and re-enable the jar plane on a rejected credential.
    const session = new DesktopAuthSession();
    session.setVerified(SIGNED_IN, session.beginSet());
    let changes = 0;
    session.on("change", () => {
      changes += 1;
    });

    session.revokeVerification(BEARER_2);
    // The held session is untouched by a revoke it does not name.
    expect(session.get()).toEqual({ ...SIGNED_IN, verified: true });
    expect(changes).toBe(0);

    session.setVerified({ ...SIGNED_IN, token: BEARER_2 }, session.beginSet());

    expect(session.get()).toEqual({
      ...SIGNED_IN,
      token: BEARER_2,
      verified: false,
    });
    expect(changes).toBe(1);
    // Non-vacuity: a bearer nobody revoked still verifies.
    session.setVerified({ ...SIGNED_IN, token: BEARER_3 }, session.beginSet());
    expect(session.get().verified).toBe(true);
  });

  it("keeps a revoked bearer unverified when a set for that same bearer lands afterwards", () => {
    // Main holds and has verified `bearer-1`; a second window's set for the
    // same bearer is still awaiting JWKS when the terminal verdict arrives.
    // The revoke strips the held verification - and must ALSO outlast the
    // pending set, or that set restores `verified: true`.
    const session = new DesktopAuthSession();
    session.setVerified(SIGNED_IN, session.beginSet());
    session.revokeVerification(SIGNED_IN.token);
    expect(session.get().verified).toBe(false);

    session.setVerified(SIGNED_IN, session.beginSet());

    expect(session.get()).toEqual({ ...SIGNED_IN, verified: false });
  });

  it("drops a verified set that a newer set overtook while it awaited JWKS, revoked or not", () => {
    // Window A's set for `bearer-1` is awaiting JWKS when window B signs in
    // and main verifies `bearer-2`. A's terminal revoke for `bearer-1` then
    // lands (retained; main does not hold it). When A's verification finally
    // completes, storing it - even unverified - would replace B's verified
    // session with A's stale snapshot, fan a sign-in for the wrong account
    // out to every window, and move the jar plane's principal off the
    // account the cloud still vouches for. The set is dropped whole.
    const session = new DesktopAuthSession();
    const generationA = session.beginSet();
    session.setVerified({ ...SIGNED_IN, token: BEARER_2 }, session.beginSet());
    session.revokeVerification(SIGNED_IN.token);
    let changes = 0;
    session.on("change", () => {
      changes += 1;
    });

    session.setVerified(SIGNED_IN, generationA);

    expect(session.get()).toEqual({
      ...SIGNED_IN,
      token: BEARER_2,
      verified: true,
    });
    expect(changes).toBe(0);

    // The same fence without any revoke: the ordering alone decides. A's
    // never-revoked bearer would otherwise have replaced B's session as
    // VERIFIED, which is the same wrong account with a better badge.
    const generationC = session.beginSet();
    session.setVerified({ ...SIGNED_IN, token: BEARER_4 }, session.beginSet());
    session.setVerified({ ...SIGNED_IN, token: BEARER_3 }, generationC);
    expect(session.get().token).toBe(BEARER_4);
  });

  it("drops a verified set that a sign-out overtook while it awaited JWKS", () => {
    // `set` is synchronous and so its own newest intent: a signed-out set
    // landing during A's verification must not be undone when A completes.
    const session = new DesktopAuthSession();
    const generationA = session.beginSet();
    session.set({ status: "signed-out", token: null, profile: null });

    session.setVerified(SIGNED_IN, generationA);

    expect(session.get().status).toBe("signed-out");
  });

  it("lets an older valid set commit when the newer set never committed (refused, or still verifying)", () => {
    // Two windows publish at once. A's set begins, then B's begins and is
    // REFUSED by verification (or is simply still awaiting JWKS). Fencing on
    // "a newer set began" dropped A as stale while telling A's sender it was
    // accepted - main stayed on the previous or empty session and nobody
    // retried. Only a set that COMMITTED supersedes.
    const session = new DesktopAuthSession();
    const generationA = session.beginSet();
    session.beginSet(); // B: refused by authn, never reaches setVerified.

    expect(session.setVerified(SIGNED_IN, generationA)).toBe(true);
    expect(session.get()).toEqual({ ...SIGNED_IN, verified: true });

    // And the report is truthful in the other direction: a set a newer
    // COMMIT overtook says so, rather than "accepted".
    const generationC = session.beginSet();
    session.setVerified({ ...SIGNED_IN, token: BEARER_2 }, session.beginSet());
    expect(
      session.setVerified({ ...SIGNED_IN, token: BEARER_3 }, generationC),
    ).toBe(false);
    expect(session.get().token).toBe(BEARER_2);
  });

  it("keeps a revocation for the bearer's lifetime, however many other revocations arrive", () => {
    // The revoke IPC takes any string from any renderer. The eight-entry ring
    // this replaces evicted the oldest revocation on the ninth revoke, so a
    // compromised renderer could push a real bearer's revocation out and let
    // a pending set for that still-unexpired bearer verify clean again.
    const session = new DesktopAuthSession();
    session.revokeVerification(BEARER_2);
    for (let i = 0; i < 64; i += 1) {
      session.revokeVerification(
        bearer(`bogus-${i}`, Date.now() + ONE_HOUR_MS),
      );
    }

    session.setVerified({ ...SIGNED_IN, token: BEARER_2 }, session.beginSet());

    expect(session.get().verified).toBe(false);
  });

  it("forgets a revocation once its bearer has expired, and never retains one for a non-bearer", () => {
    // Past `exp` (plus the verifier's tolerance) no set for the bearer can
    // verify, so the memory protects nothing; and a string that is not a
    // bearer could never have verified, so it is not the growth a hostile
    // renderer gets to cause.
    const session = new DesktopAuthSession();
    const expired = bearer("expired", Date.now() - 10 * 60_000);
    session.revokeVerification(expired);
    session.revokeVerification("not-a-bearer");
    // Both would still be "revoked" under a plain string set; neither is
    // retained here, so the same tokens verify as any unrevoked one would.
    session.setVerified({ ...SIGNED_IN, token: expired }, session.beginSet());
    expect(session.get().verified).toBe(true);
    session.setVerified(
      { ...SIGNED_IN, token: "not-a-bearer" },
      session.beginSet(),
    );
    expect(session.get().verified).toBe(true);
  });

  it("is a no-op on a session main never verified", () => {
    const session = new DesktopAuthSession();
    session.set(SIGNED_IN);
    let changes = 0;
    session.on("change", () => {
      changes += 1;
    });

    session.revokeVerification(SIGNED_IN.token);

    expect(session.get().verified).toBe(false);
    expect(changes).toBe(0);
  });
});
