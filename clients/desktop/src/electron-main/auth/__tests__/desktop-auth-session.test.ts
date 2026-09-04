import { describe, expect, it } from "vitest";
import { DesktopAuthSession } from "../desktop-auth-session";

const SIGNED_IN = {
  status: "signed-in" as const,
  token: "bearer-1",
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
    session.setVerified(
      { ...SIGNED_IN, token: "bearer-2" },
      session.beginSet(),
    );
    let changes = 0;
    session.on("change", () => {
      changes += 1;
    });

    session.revokeVerification(SIGNED_IN.token);

    expect(session.get()).toEqual({
      ...SIGNED_IN,
      token: "bearer-2",
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

    session.revokeVerification("bearer-2");
    // The held session is untouched by a revoke it does not name.
    expect(session.get()).toEqual({ ...SIGNED_IN, verified: true });
    expect(changes).toBe(0);

    session.setVerified(
      { ...SIGNED_IN, token: "bearer-2" },
      session.beginSet(),
    );

    expect(session.get()).toEqual({
      ...SIGNED_IN,
      token: "bearer-2",
      verified: false,
    });
    expect(changes).toBe(1);
    // Non-vacuity: a bearer nobody revoked still verifies.
    session.setVerified(
      { ...SIGNED_IN, token: "bearer-3" },
      session.beginSet(),
    );
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
    session.setVerified(
      { ...SIGNED_IN, token: "bearer-2" },
      session.beginSet(),
    );
    session.revokeVerification(SIGNED_IN.token);
    let changes = 0;
    session.on("change", () => {
      changes += 1;
    });

    session.setVerified(SIGNED_IN, generationA);

    expect(session.get()).toEqual({
      ...SIGNED_IN,
      token: "bearer-2",
      verified: true,
    });
    expect(changes).toBe(0);

    // The same fence without any revoke: the ordering alone decides. A's
    // never-revoked bearer would otherwise have replaced B's session as
    // VERIFIED, which is the same wrong account with a better badge.
    const generationC = session.beginSet();
    session.setVerified(
      { ...SIGNED_IN, token: "bearer-4" },
      session.beginSet(),
    );
    session.setVerified({ ...SIGNED_IN, token: "bearer-3" }, generationC);
    expect(session.get().token).toBe("bearer-4");
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
