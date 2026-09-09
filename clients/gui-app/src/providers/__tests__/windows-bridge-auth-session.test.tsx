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

const SIGNED_OUT_DESKTOP_SNAPSHOT: DesktopAuthSessionSnapshot = {
  status: "signed-out",
  token: null,
  profile: null,
};

type RenderWithFakesOptions = {
  readonly replayOutboundSnapshot?: AuthSessionSnapshot;
  readonly deferSet?: boolean;
};

type AuthSessionSetResolution =
  | { readonly kind: "resolve"; readonly result: DesktopAuthSessionSetResult }
  | { readonly kind: "reject"; readonly cause: Error };

interface AuthSessionBridgeTestHarness {
  readonly emitInbound: (snapshot: DesktopAuthSessionSnapshot) => void;
  readonly emitOutbound: (snapshot: AuthSessionSnapshot) => void;
  readonly get: Mock<() => Promise<DesktopAuthSessionSnapshot>>;
  readonly ingest: Mock<(snapshot: AuthSessionSnapshot) => Promise<void>>;
  readonly inboundDispose: Mock<() => void>;
  readonly outboundDispose: Mock<() => void>;
  readonly resolveSet: (resolution: AuthSessionSetResolution) => void;
  readonly set: Mock<
    (
      snapshot: DesktopAuthSessionSnapshot,
    ) => Promise<DesktopAuthSessionSetResult>
  >;
  readonly unmount: () => void;
}

/**
 * A faithful boundary fake for the real startup race:
 *
 * - AuthService replays its restored session synchronously when the outbound
 *   subscription is installed.
 * - Main still reports its default signed-out snapshot from `get()` while the
 *   asynchronous bearer verification in `set()` is pending.
 * - The bridge can deliver live sibling-window changes through `onChange`.
 */
function renderWithFakes(
  setResult: DesktopAuthSessionSetResult,
  options: RenderWithFakesOptions,
): AuthSessionBridgeTestHarness {
  let outboundListener: ((snapshot: AuthSessionSnapshot) => void) | null = null;
  let inboundListener: ((snapshot: DesktopAuthSessionSnapshot) => void) | null =
    null;
  let resolveSetPromise:
    | ((resolution: AuthSessionSetResolution) => void)
    | null = null;
  let mainSnapshot = SIGNED_OUT_DESKTOP_SNAPSHOT;
  const inboundDispose = vi.fn(() => {
    inboundListener = null;
  });
  const outboundDispose = vi.fn(() => {
    outboundListener = null;
  });

  const ingest = vi.fn((_snapshot: AuthSessionSnapshot): Promise<void> =>
    Promise.resolve(),
  );
  mockUseAuthService.mockReturnValue({
    onSessionSnapshotChange: (
      handler: (snapshot: AuthSessionSnapshot) => void,
    ) => {
      outboundListener = handler;
      if (options.replayOutboundSnapshot !== undefined) {
        handler(options.replayOutboundSnapshot);
      }
      return {
        dispose: outboundDispose,
      };
    },
    getIdentityGeneration: () => 0,
    ingestProjectedSessionSnapshot: ingest,
  });

  const set = vi.fn((snapshot: DesktopAuthSessionSnapshot) => {
    if (!options.deferSet) {
      if (setResult.outcome === "accepted") {
        mainSnapshot = snapshot;
      }
      return Promise.resolve(setResult);
    }
    return new Promise<DesktopAuthSessionSetResult>((resolve, reject) => {
      resolveSetPromise = (resolution) => {
        if (resolution.kind === "resolve") {
          if (resolution.result.outcome === "accepted") {
            mainSnapshot = snapshot;
          }
          resolve(resolution.result);
        } else {
          reject(resolution.cause);
        }
      };
    });
  });
  const get = vi.fn(() => Promise.resolve(mainSnapshot));
  mockUseWindowsBridge.mockReturnValue({
    authSession: {
      get,
      set,
      onChange: (handler: (snapshot: DesktopAuthSessionSnapshot) => void) => {
        inboundListener = handler;
        return { dispose: inboundDispose };
      },
    },
  });

  const rendered = render(
    <WindowsBridgeAuthSessionBridge>
      <div>content</div>
    </WindowsBridgeAuthSessionBridge>,
  );

  return {
    get,
    ingest,
    inboundDispose,
    outboundDispose,
    resolveSet: (resolution) => {
      if (resolveSetPromise === null) {
        throw new Error("set is not pending");
      }
      resolveSetPromise(resolution);
      resolveSetPromise = null;
    },
    set,
    unmount: rendered.unmount,
    emitInbound: (snapshot) => {
      act(() => inboundListener?.(snapshot));
    },
    emitOutbound: (snapshot) => {
      act(() => outboundListener?.(snapshot));
    },
  };
}

async function drainMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("<WindowsBridgeAuthSessionBridge />", () => {
  afterEach(() => {
    cleanup();
    toast.warning.mockClear();
  });

  it("surfaces a toast naming the reason when main refuses the pushed session", async () => {
    const { emitOutbound } = renderWithFakes(
      {
        outcome: "refused",
        reason: "expired",
      },
      {},
    );

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
    const { emitOutbound, set } = renderWithFakes(
      {
        outcome: "refused",
        reason: "key-source-unavailable",
      },
      {},
    );

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
    const { emitOutbound } = renderWithFakes({ outcome: "accepted" }, {});

    await act(async () => {
      emitOutbound(SIGNED_IN_SNAPSHOT);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(toast.warning).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "while verification is pending",
      resolution: null,
    },
    {
      label: "after main accepts it",
      resolution: {
        kind: "resolve" as const,
        result: { outcome: "accepted" as const },
      },
    },
    {
      label: "after main refuses it",
      resolution: {
        kind: "resolve" as const,
        result: { outcome: "refused" as const, reason: "expired" as const },
      },
    },
    {
      label: "after the bridge write rejects",
      resolution: {
        kind: "reject" as const,
        cause: new Error("bridge closed"),
      },
    },
  ])(
    "does not ingest main's default signed-out snapshot $label",
    async ({ resolution }) => {
      const harness = renderWithFakes(
        { outcome: "accepted" },
        {
          deferSet: true,
          replayOutboundSnapshot: SIGNED_IN_SNAPSHOT,
        },
      );

      expect(harness.set).toHaveBeenCalledWith({
        status: "signed-in",
        token: SIGNED_IN_SNAPSHOT.token,
        profile: SIGNED_IN_SNAPSHOT.profile,
      });

      await act(async () => {
        await drainMicrotasks();
      });
      expect(harness.ingest).not.toHaveBeenCalled();

      if (resolution !== null) {
        harness.resolveSet(resolution);
        await act(async () => {
          await drainMicrotasks();
        });
        expect(harness.ingest).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps a synchronously accepted restored session without a startup sign-out", async () => {
    const harness = renderWithFakes(
      { outcome: "accepted" },
      { replayOutboundSnapshot: SIGNED_IN_SNAPSHOT },
    );

    await act(async () => {
      await drainMicrotasks();
    });

    expect(harness.ingest).not.toHaveBeenCalled();
  });

  it("ingests a live signed-out update from a sibling window", async () => {
    const harness = renderWithFakes(
      { outcome: "accepted" },
      {
        deferSet: true,
        replayOutboundSnapshot: SIGNED_IN_SNAPSHOT,
      },
    );

    harness.emitInbound(SIGNED_OUT_DESKTOP_SNAPSHOT);
    await act(async () => {
      await drainMicrotasks();
    });

    expect(harness.ingest).toHaveBeenCalledTimes(1);
    expect(harness.ingest).toHaveBeenCalledWith({
      status: "signed-out",
      token: null,
      profile: null,
      contextMetadata: null,
    });

    harness.resolveSet({
      kind: "resolve",
      result: { outcome: "accepted" },
    });
  });

  it("suppresses an accepted write's echo and cleans up both subscriptions", async () => {
    const harness = renderWithFakes(
      { outcome: "accepted" },
      {
        deferSet: true,
        replayOutboundSnapshot: SIGNED_IN_SNAPSHOT,
      },
    );

    harness.resolveSet({
      kind: "resolve",
      result: { outcome: "accepted" },
    });
    await act(async () => {
      await drainMicrotasks();
    });

    harness.emitInbound({
      status: "signed-in",
      token: SIGNED_IN_SNAPSHOT.token,
      profile: SIGNED_IN_SNAPSHOT.profile,
    });
    expect(harness.ingest).not.toHaveBeenCalled();

    harness.unmount();
    expect(harness.outboundDispose).toHaveBeenCalledTimes(1);
    expect(harness.inboundDispose).toHaveBeenCalledTimes(1);

    harness.emitInbound(SIGNED_OUT_DESKTOP_SNAPSHOT);
    harness.emitOutbound({
      status: "signed-out",
      token: null,
      profile: null,
      contextMetadata: null,
    });
    expect(harness.ingest).not.toHaveBeenCalled();
    expect(harness.set).toHaveBeenCalledTimes(1);
  });
});
