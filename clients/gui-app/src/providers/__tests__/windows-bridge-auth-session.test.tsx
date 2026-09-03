import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowsBridgeAuthSessionBridge } from "@/providers/windows-bridge-auth-session";
import type { AuthSessionSnapshot } from "@/lib/auth/auth-service";
import type {
  DesktopAuthSessionSetResult,
  DesktopAuthSessionSnapshot,
} from "@/lib/windows/types";
import type { Mock } from "vitest";

const toast = vi.hoisted(() => ({
  warning: vi.fn<(message: string) => void>(),
}));

vi.mock("sonner", () => ({ toast }));

const mockUseAuthService = vi.hoisted(() => vi.fn());
vi.mock("@/lib/host", () => ({ useAuthService: mockUseAuthService }));

const mockUseWindowsBridge = vi.hoisted(() => vi.fn());
vi.mock("@/providers/windows-bridge-context", () => ({
  useWindowsBridge: mockUseWindowsBridge,
}));

const SIGNED_IN_SNAPSHOT: AuthSessionSnapshot = {
  status: "signed-in",
  token: "bearer-token",
  profile: { userId: "u1", userName: "Ada", email: "ada@example.com" },
  contextMetadata: null,
};

/**
 * Only the surface `WindowsBridgeAuthSessionBridge` actually reads: the
 * outbound snapshot emitter and a settable `authSession.set` result.
 */
function renderWithFakes(setResult: DesktopAuthSessionSetResult): {
  emitOutbound: (snapshot: AuthSessionSnapshot) => void;
  emitRevoked: () => void;
  set: Mock<(snapshot: DesktopAuthSessionSnapshot) => Promise<unknown>>;
  revoke: Mock<() => Promise<void>>;
} {
  let outboundListener: ((snapshot: AuthSessionSnapshot) => void) | null = null;
  let revokedListener: (() => void) | null = null;

  mockUseAuthService.mockReturnValue({
    onSessionSnapshotChange: (
      handler: (snapshot: AuthSessionSnapshot) => void,
    ) => {
      outboundListener = handler;
      return {
        dispose: () => {
          outboundListener = null;
        },
      };
    },
    onCloudAuthorizationRevoked: (handler: () => void) => {
      revokedListener = handler;
      return {
        dispose: () => {
          revokedListener = null;
        },
      };
    },
    getIdentityGeneration: () => 0,
    ingestProjectedSessionSnapshot: vi.fn().mockResolvedValue(undefined),
  });

  const set = vi.fn((_snapshot: DesktopAuthSessionSnapshot) =>
    Promise.resolve<unknown>(setResult),
  );
  const revoke = vi.fn(() => Promise.resolve());
  mockUseWindowsBridge.mockReturnValue({
    authSession: {
      get: vi.fn().mockResolvedValue({
        status: "signed-out",
        token: null,
        profile: null,
      }),
      set,
      revoke,
      onChange: () => ({ dispose: () => undefined }),
    },
  });

  render(
    <WindowsBridgeAuthSessionBridge>
      <div>content</div>
    </WindowsBridgeAuthSessionBridge>,
  );

  return {
    set,
    revoke,
    emitOutbound: (snapshot) => {
      if (outboundListener === null) throw new Error("no outbound listener");
      act(() => outboundListener?.(snapshot));
    },
    emitRevoked: () => {
      if (revokedListener === null) throw new Error("no revoke listener");
      act(() => revokedListener?.());
    },
  };
}

describe("<WindowsBridgeAuthSessionBridge />", () => {
  afterEach(() => {
    cleanup();
    toast.warning.mockClear();
  });

  it("asks main to drop its verification on a terminal verdict loss, without projecting a session transition", async () => {
    const { emitOutbound, emitRevoked, set, revoke } = renderWithFakes({
      outcome: "accepted",
    });
    await act(async () => {
      emitOutbound(SIGNED_IN_SNAPSHOT);
      await Promise.resolve();
    });
    expect(set).toHaveBeenCalledTimes(1);

    await act(async () => {
      emitRevoked();
      await Promise.resolve();
    });

    // The revoke, and ONLY the revoke: no `signed-out` (which siblings apply
    // unconditionally) and no `unverified` (which main has no shape for).
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("surfaces a toast naming the reason when main refuses the pushed session", async () => {
    const { emitOutbound } = renderWithFakes({
      outcome: "refused",
      reason: "expired",
    });

    await act(async () => {
      emitOutbound(SIGNED_IN_SNAPSHOT);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(toast.warning).toHaveBeenCalledTimes(1);
    const [message] = toast.warning.mock.calls[0] ?? [];
    expect(message).toContain("could not verify this sign-in");
    expect(message).toContain("the sign-in token had expired");
    expect(message).not.toContain("bearer-token");
  });

  it("re-attempts the same session after a refusal instead of latching it", async () => {
    // The refusal is the transient case that matters: authn unreachable at
    // launch. A latch held over a write that landed nowhere makes the next
    // projection of the same snapshot a no-op, and the jar plane stays closed
    // until an unrelated rotation changes the bytes.
    const { emitOutbound, set } = renderWithFakes({
      outcome: "refused",
      reason: "key-source-unavailable",
    });
    // The mount's own inbound `get` also writes the latch; drain it first so
    // what this pins is the refusal and not the arrival of the initial
    // signed-out snapshot.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      emitOutbound(SIGNED_IN_SNAPSHOT);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(set).toHaveBeenCalledTimes(1);

    await act(async () => {
      emitOutbound(SIGNED_IN_SNAPSHOT);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(set).toHaveBeenCalledTimes(2);
  });

  it("shows nothing when main accepts the pushed session", async () => {
    const { emitOutbound } = renderWithFakes({ outcome: "accepted" });

    await act(async () => {
      emitOutbound(SIGNED_IN_SNAPSHOT);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(toast.warning).not.toHaveBeenCalled();
  });
});
