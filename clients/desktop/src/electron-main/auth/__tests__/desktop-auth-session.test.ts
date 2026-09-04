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
    session.setVerified(SIGNED_IN);
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
    session.setVerified(SIGNED_IN);
    session.setVerified({ ...SIGNED_IN, token: "bearer-2" });
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
    session.setVerified(SIGNED_IN);
    let changes = 0;
    session.on("change", () => {
      changes += 1;
    });

    session.revokeVerification("bearer-2");
    // The held session is untouched by a revoke it does not name.
    expect(session.get()).toEqual({ ...SIGNED_IN, verified: true });
    expect(changes).toBe(0);

    session.setVerified({ ...SIGNED_IN, token: "bearer-2" });

    expect(session.get()).toEqual({
      ...SIGNED_IN,
      token: "bearer-2",
      verified: false,
    });
    expect(changes).toBe(1);
    // Non-vacuity: a bearer nobody revoked still verifies.
    session.setVerified({ ...SIGNED_IN, token: "bearer-3" });
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
