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

    session.revokeVerification();

    // Same session, same status: nothing a renderer applies as a transition.
    expect(session.get()).toEqual({ ...SIGNED_IN, verified: false });
    expect(changes).toBe(1);
    // Idempotent: nothing left to withdraw, so nothing to announce.
    session.revokeVerification();
    expect(changes).toBe(1);
  });

  it("is a no-op on a session main never verified", () => {
    const session = new DesktopAuthSession();
    session.set(SIGNED_IN);
    let changes = 0;
    session.on("change", () => {
      changes += 1;
    });

    session.revokeVerification();

    expect(session.get().verified).toBe(false);
    expect(changes).toBe(0);
  });
});
