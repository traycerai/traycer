import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WindowsBridgeAuthSessionBridge } from "@/providers/windows-bridge-auth-session";
import type {
  AuthSessionSnapshot,
  RevokedCloudAuthorization,
} from "@/lib/auth/auth-service";
import type {
  DesktopAuthSessionRefusalReason,
  DesktopLocalAuthSessionRestoreResult,
  DesktopAuthSessionSetResult,
  DesktopAuthSessionSnapshot,
} from "@/lib/windows/types";
import type { Mock } from "vitest";

const toast = vi.hoisted(() => ({
  warning: vi.fn<(message: string) => void>(),
}));

vi.mock("sonner", () => ({ toast }));

// The wake signal the bridge resends on while it holds the local computer.
const wake = vi.hoisted((): { listener: (() => void) | null } => ({
  listener: null,
}));
vi.mock("@/lib/host/wake-reconnect", () => ({
  onWakeReconnect: (listener: () => void) => {
    wake.listener = listener;
    return () => {
      wake.listener = null;
    };
  },
}));

const mockUseAuthService = vi.hoisted(() => vi.fn());
vi.mock("@/lib/host", () => ({ useAuthService: mockUseAuthService }));

const mockUseWindowsBridge = vi.hoisted(() => vi.fn());
vi.mock("@/providers/windows-bridge-context", () => ({
  useWindowsBridge: mockUseWindowsBridge,
}));

const SIGNED_IN_TOKEN = "bearer-token";
const SIGNED_IN_SNAPSHOT: AuthSessionSnapshot = {
  status: "signed-in",
  token: SIGNED_IN_TOKEN,
  profile: { userId: "u1", userName: "Ada", email: "ada@example.com" },
  contextMetadata: null,
};

const UNVERIFIED_SNAPSHOT: AuthSessionSnapshot = {
  ...SIGNED_IN_SNAPSHOT,
  status: "unverified",
};

const SIGNED_OUT_DESKTOP_SNAPSHOT: DesktopAuthSessionSnapshot = {
  status: "signed-out",
  token: null,
  profile: null,
};

const UNVERIFIED_DESKTOP_SNAPSHOT: DesktopAuthSessionSnapshot = {
  status: "unverified",
  token: SIGNED_IN_TOKEN,
  profile: SIGNED_IN_SNAPSHOT.profile,
};

/** What the cross-window revoke channel says about a refusal. */
type RevocationScope = "user-epoch" | null;

/** What the next `restoreLocal` answers; `pending` waits for `resolveRestore`. */
type RestoreAnswer = DesktopLocalAuthSessionRestoreResult | Error | "pending";

type RenderWithFakesOptions = {
  readonly replayOutboundSnapshot?: AuthSessionSnapshot;
  readonly deferSet?: boolean;
  readonly omitRestoreLocal?: boolean;
};

type AuthSessionSetResolution =
  | { readonly kind: "resolve"; readonly result: DesktopAuthSessionSetResult }
  | { readonly kind: "reject"; readonly cause: Error };

interface AuthSessionBridgeTestHarness {
  readonly emitInbound: (snapshot: DesktopAuthSessionSnapshot) => void;
  readonly emitOutbound: (snapshot: AuthSessionSnapshot) => void;
  readonly emitRevoked: (token: string, revocation: RevocationScope) => void;
  readonly emitVerificationRevoked: (
    token: string,
    revocation: RevocationScope,
  ) => void;
  readonly get: Mock<() => Promise<DesktopAuthSessionSnapshot>>;
  readonly ingest: Mock<(snapshot: AuthSessionSnapshot) => Promise<void>>;
  readonly ingestRevoked: Mock<
    (rejectedToken: string, revocation: RevocationScope) => void
  >;
  readonly restoreLocal: Mock<
    (expected: {
      readonly userId: string;
      readonly token: string;
    }) => Promise<DesktopLocalAuthSessionRestoreResult>
  >;
  readonly inboundDispose: Mock<() => void>;
  readonly outboundDispose: Mock<() => void>;
  readonly resolveSet: (resolution: AuthSessionSetResolution) => void;
  /** What the next `set` answers; `pending` waits for `resolveSet`. */
  readonly answerSetWith: (
    answer: DesktopAuthSessionSetResult | "pending",
  ) => void;
  readonly answerRestoreWith: (answer: RestoreAnswer) => void;
  readonly resolveRestore: (
    result: DesktopLocalAuthSessionRestoreResult,
  ) => void;
  /** The session the sign-in service reports now (what a resend hands over). */
  readonly setCurrentSession: (snapshot: AuthSessionSnapshot) => void;
  readonly revalidate: Mock<() => Promise<unknown>>;
  readonly revoke: Mock<
    (rejectedToken: string, revocation: RevocationScope) => Promise<void>
  >;
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
  let revokedListener: ((revoked: RevokedCloudAuthorization) => void) | null =
    null;
  let verificationRevokedListener:
    | ((rejectedToken: string, revocation: RevocationScope) => void)
    | null = null;
  // Every write still waiting, oldest first: a window can have several.
  const pendingSets: Array<(resolution: AuthSessionSetResolution) => void> = [];
  let mainSnapshot = SIGNED_OUT_DESKTOP_SNAPSHOT;
  let setAnswer: DesktopAuthSessionSetResult | "pending" = setResult;
  let restoreAnswer: RestoreAnswer = "restored";
  let resolveRestorePromise:
    | ((result: DesktopLocalAuthSessionRestoreResult) => void)
    | null = null;
  let currentSession: AuthSessionSnapshot = SIGNED_IN_SNAPSHOT;
  const inboundDispose = vi.fn(() => {
    inboundListener = null;
  });
  const outboundDispose = vi.fn(() => {
    outboundListener = null;
  });

  const ingest = vi.fn((_snapshot: AuthSessionSnapshot): Promise<void> =>
    Promise.resolve(),
  );
  const revalidate = vi.fn((): Promise<unknown> => Promise.resolve(null));
  const ingestRevoked = vi.fn(
    (_rejectedToken: string, _revocation: RevocationScope): void => undefined,
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
    onCloudAuthorizationRevoked: (
      handler: (revoked: RevokedCloudAuthorization) => void,
    ) => {
      revokedListener = handler;
      return {
        dispose: () => {
          revokedListener = null;
        },
      };
    },
    getIdentityGeneration: () => 0,
    getCurrentSessionSnapshot: () => currentSession,
    revalidateCurrentContext: revalidate,
    ingestProjectedSessionSnapshot: ingest,
    ingestCloudAuthorizationRevoked: ingestRevoked,
  });

  const revoke = vi.fn((_rejectedToken: string, _revocation: RevocationScope) =>
    Promise.resolve(),
  );
  const set = vi.fn((snapshot: DesktopAuthSessionSnapshot) => {
    if (!options.deferSet && setAnswer !== "pending") {
      if (setAnswer.outcome === "accepted") {
        mainSnapshot = snapshot;
      }
      return Promise.resolve(setAnswer);
    }
    return new Promise<DesktopAuthSessionSetResult>((resolve, reject) => {
      pendingSets.push((resolution) => {
        if (resolution.kind === "resolve") {
          if (resolution.result.outcome === "accepted") {
            mainSnapshot = snapshot;
          }
          resolve(resolution.result);
        } else {
          reject(resolution.cause);
        }
      });
    });
  });
  const get = vi.fn(() => Promise.resolve(mainSnapshot));
  const restoreLocal = vi.fn(
    (_expected: {
      readonly userId: string;
      readonly token: string;
    }): Promise<DesktopLocalAuthSessionRestoreResult> => {
      if (restoreAnswer === "pending") {
        return new Promise((resolve) => {
          resolveRestorePromise = resolve;
        });
      }
      if (restoreAnswer instanceof Error) return Promise.reject(restoreAnswer);
      return Promise.resolve(restoreAnswer);
    },
  );
  mockUseWindowsBridge.mockReturnValue({
    authSession: {
      get,
      set,
      revoke,
      ...(options.omitRestoreLocal === true ? {} : { restoreLocal }),
      onChange: (handler: (snapshot: DesktopAuthSessionSnapshot) => void) => {
        inboundListener = handler;
        return { dispose: inboundDispose };
      },
      onVerificationRevoked: (
        handler: (rejectedToken: string, revocation: RevocationScope) => void,
      ) => {
        verificationRevokedListener = handler;
        return {
          dispose: () => {
            verificationRevokedListener = null;
          },
        };
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
    ingestRevoked,
    restoreLocal,
    inboundDispose,
    outboundDispose,
    resolveSet: (resolution) => {
      const resolvePending = pendingSets.shift();
      if (resolvePending === undefined) {
        throw new Error("set is not pending");
      }
      resolvePending(resolution);
    },
    set,
    answerSetWith: (answer) => {
      setAnswer = answer;
    },
    answerRestoreWith: (answer) => {
      restoreAnswer = answer;
    },
    resolveRestore: (result) => {
      if (resolveRestorePromise === null) {
        throw new Error("restoreLocal is not pending");
      }
      resolveRestorePromise(result);
      resolveRestorePromise = null;
    },
    setCurrentSession: (snapshot) => {
      currentSession = snapshot;
    },
    revalidate,
    revoke,
    unmount: rendered.unmount,
    emitInbound: (snapshot) => {
      act(() => inboundListener?.(snapshot));
    },
    emitOutbound: (snapshot) => {
      act(() => outboundListener?.(snapshot));
    },
    emitRevoked: (token, revocation) => {
      if (revokedListener === null) throw new Error("no revoke listener");
      act(() => revokedListener?.({ token, revocation }));
    },
    emitVerificationRevoked: (token, revocation) => {
      if (verificationRevokedListener === null) {
        throw new Error("no verification-revoked listener");
      }
      act(() => verificationRevokedListener?.(token, revocation));
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

  it("asks main to drop its verification on a terminal verdict loss, without projecting a session transition", async () => {
    const { emitOutbound, emitRevoked, set, revoke } = renderWithFakes(
      { outcome: "accepted" },
      {},
    );
    await act(async () => {
      emitOutbound(SIGNED_IN_SNAPSHOT);
      await Promise.resolve();
    });
    expect(set).toHaveBeenCalledTimes(1);

    await act(async () => {
      emitRevoked(SIGNED_IN_TOKEN, null);
      await Promise.resolve();
    });

    // The revoke, and ONLY the revoke: no `signed-out` (which siblings apply
    // unconditionally) and no published `unverified` transition. Local
    // unverified restoration uses its separate file-backed IPC path.
    // Revoke names the rejected bearer, which is main's fence against a
    // revoke that lands after a sibling window's fresh sign-in.
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(SIGNED_IN_TOKEN, null);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("passes the user-epoch revocation scope through to main, so the other windows can be told", async () => {
    const { emitOutbound, emitRevoked, set, revoke } = renderWithFakes(
      { outcome: "accepted" },
      {},
    );
    await act(async () => {
      emitOutbound(SIGNED_IN_SNAPSHOT);
      await Promise.resolve();
    });

    await act(async () => {
      emitRevoked(SIGNED_IN_TOKEN, "user-epoch");
      await Promise.resolve();
    });

    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(SIGNED_IN_TOKEN, "user-epoch");
    // Still only the revoke: the scope does not turn it into a session write.
    expect(set).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "a user-epoch revocation", revocation: "user-epoch" as const },
    { label: "a revocation without a scope", revocation: null },
  ])(
    "hands a sibling window's verdict loss to the service with its scope: $label",
    ({ revocation }) => {
      const { emitVerificationRevoked, ingestRevoked, ingest, set } =
        renderWithFakes({ outcome: "accepted" }, {});

      emitVerificationRevoked(SIGNED_IN_TOKEN, revocation);

      expect(ingestRevoked).toHaveBeenCalledTimes(1);
      expect(ingestRevoked).toHaveBeenCalledWith(SIGNED_IN_TOKEN, revocation);
      // It is a verdict-loss edge, not a session projection either way.
      expect(ingest).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
    },
  );

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

  it("asks main to restore this window's unverified local identity without publishing a session transition", async () => {
    const harness = renderWithFakes(
      { outcome: "accepted" },
      { replayOutboundSnapshot: UNVERIFIED_SNAPSHOT },
    );

    await act(async () => {
      await drainMicrotasks();
    });

    expect(harness.restoreLocal).toHaveBeenCalledOnce();
    expect(harness.restoreLocal).toHaveBeenCalledWith({
      userId: "u1",
      token: SIGNED_IN_TOKEN,
    });
    expect(harness.set).not.toHaveBeenCalled();
    expect(harness.ingest).not.toHaveBeenCalled();
  });

  it("publishes the same bearer again when local restoration is promoted", async () => {
    const harness = renderWithFakes({ outcome: "accepted" }, {});

    await act(async () => {
      harness.emitOutbound(SIGNED_IN_SNAPSHOT);
      await drainMicrotasks();
    });
    expect(harness.set).toHaveBeenCalledTimes(1);

    await act(async () => {
      harness.emitOutbound(UNVERIFIED_SNAPSHOT);
      await drainMicrotasks();
    });
    expect(harness.restoreLocal).toHaveBeenCalledWith({
      userId: "u1",
      token: SIGNED_IN_TOKEN,
    });

    await act(async () => {
      harness.emitOutbound(SIGNED_IN_SNAPSHOT);
      await drainMicrotasks();
    });

    expect(harness.set).toHaveBeenCalledTimes(2);
    expect(harness.set).toHaveBeenLastCalledWith({
      status: "signed-in",
      token: SIGNED_IN_TOKEN,
      profile: SIGNED_IN_SNAPSHOT.profile,
    });
  });

  it("ignores an inbound unverified snapshot from another window", async () => {
    const harness = renderWithFakes({ outcome: "accepted" }, {});

    harness.emitInbound(UNVERIFIED_DESKTOP_SNAPSHOT);
    await act(async () => {
      await drainMicrotasks();
    });

    expect(harness.ingest).not.toHaveBeenCalled();
  });

  it("keeps old shells without local restore support on the existing unverified path", async () => {
    const harness = renderWithFakes(
      { outcome: "accepted" },
      {
        replayOutboundSnapshot: UNVERIFIED_SNAPSHOT,
        omitRestoreLocal: true,
      },
    );

    await act(async () => {
      await drainMicrotasks();
    });

    expect(harness.set).not.toHaveBeenCalled();
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

const NO_KEYS: DesktopAuthSessionSetResult = {
  outcome: "refused",
  reason: "key-source-unavailable",
};
const ACCEPTED: DesktopAuthSessionSetResult = { outcome: "accepted" };
const refused = (
  reason: DesktopAuthSessionRefusalReason,
): DesktopAuthSessionSetResult => ({ outcome: "refused", reason });

/** Every refusal that is a statement about the token, never a missing key source. */
const TOKEN_REFUSALS: readonly Exclude<
  DesktopAuthSessionRefusalReason,
  "key-source-unavailable"
>[] = [
  "bad-signature",
  "unknown-signing-key",
  "expired",
  "malformed-token",
  "unsupported-algorithm",
  "issuer-mismatch",
  "audience-mismatch",
  "subject-mismatch",
];

const RESEND_MS = 60_000;
const FRESH_SNAPSHOT: AuthSessionSnapshot = {
  ...SIGNED_IN_SNAPSHOT,
  token: "refreshed-token",
};
const SIGNED_OUT_SNAPSHOT: AuthSessionSnapshot = {
  status: "signed-out",
  token: null,
  profile: null,
  contextMetadata: null,
};

const READ_FAILED_TOAST =
  "Traycer could not read your local session. Reload the window to try again.";
const RESTORE_FAILED_TOAST =
  "Traycer could not restore your local session. Reload the window to try again.";

async function settle(): Promise<void> {
  await act(async () => {
    await drainMicrotasks();
  });
}

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** The window at a cold start with no network: main cannot reach its keys. */
async function startOffline(
  options: RenderWithFakesOptions,
): Promise<AuthSessionBridgeTestHarness> {
  const harness = renderWithFakes(NO_KEYS, options);
  harness.setCurrentSession(SIGNED_IN_SNAPSHOT);
  harness.emitOutbound(SIGNED_IN_SNAPSHOT);
  await settle();
  return harness;
}

describe("<WindowsBridgeAuthSessionBridge /> when main cannot reach its signing keys", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    toast.warning.mockClear();
    vi.useRealTimers();
  });

  it("restores the local computer without a toast", async () => {
    const harness = await startOffline({});

    expect(harness.set).toHaveBeenCalledTimes(1);
    expect(harness.restoreLocal).toHaveBeenCalledTimes(1);
    expect(harness.restoreLocal).toHaveBeenCalledWith({
      userId: SIGNED_IN_SNAPSHOT.profile?.userId,
      token: SIGNED_IN_TOKEN,
    });
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("starts one restore for two refusals in quick succession", async () => {
    const harness = renderWithFakes(NO_KEYS, {});
    harness.answerRestoreWith("pending");
    harness.emitOutbound(SIGNED_IN_SNAPSHOT);
    await settle();
    expect(harness.restoreLocal).toHaveBeenCalledTimes(1);

    harness.emitOutbound(SIGNED_IN_SNAPSHOT);
    await settle();

    expect(harness.set).toHaveBeenCalledTimes(2);
    expect(harness.restoreLocal).toHaveBeenCalledTimes(1);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it.each(TOKEN_REFUSALS)(
    "restores nothing and tells the person for a token refused as %s",
    async (reason) => {
      const harness = renderWithFakes(refused(reason), {});
      harness.emitOutbound(SIGNED_IN_SNAPSHOT);
      await settle();

      expect(harness.restoreLocal).not.toHaveBeenCalled();
      expect(toast.warning).toHaveBeenCalledTimes(1);
      const [message] = toast.warning.mock.calls[0] ?? [];
      expect(message).toContain("could not verify this sign-in");
      await tick(RESEND_MS * 3);
      expect(harness.set).toHaveBeenCalledTimes(1);
    },
  );

  it("says the local session could not be read when the restore answers unavailable, and does not hold", async () => {
    const harness = renderWithFakes(NO_KEYS, {});
    harness.answerRestoreWith("unavailable");
    harness.emitOutbound(SIGNED_IN_SNAPSHOT);
    await settle();

    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning.mock.calls[0]?.[0]).toBe(READ_FAILED_TOAST);
    await tick(RESEND_MS * 3);
    expect(harness.set).toHaveBeenCalledTimes(1);
  });

  it("says the local session could not be restored when the restore throws, and does not hold", async () => {
    const harness = renderWithFakes(NO_KEYS, {});
    harness.answerRestoreWith(new Error("ipc closed"));
    harness.emitOutbound(SIGNED_IN_SNAPSHOT);
    await settle();

    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning.mock.calls[0]?.[0]).toBe(RESTORE_FAILED_TOAST);
    await tick(RESEND_MS * 3);
    expect(harness.set).toHaveBeenCalledTimes(1);
  });

  it("does not hold before the restore has answered", async () => {
    const harness = renderWithFakes(NO_KEYS, {});
    harness.answerRestoreWith("pending");
    harness.emitOutbound(SIGNED_IN_SNAPSHOT);
    await settle();

    await tick(RESEND_MS * 3);

    expect(harness.set).toHaveBeenCalledTimes(1);
    harness.resolveRestore("restored");
    await settle();
    await tick(RESEND_MS);
    expect(harness.set).toHaveBeenCalledTimes(2);
  });

  it("hands the session over again each minute while it holds, and verification ends the hold", async () => {
    const harness = await startOffline({});
    harness.answerSetWith(ACCEPTED);

    await tick(RESEND_MS);

    expect(harness.set).toHaveBeenCalledTimes(2);
    expect(harness.set).toHaveBeenLastCalledWith({
      status: "signed-in",
      token: SIGNED_IN_TOKEN,
      profile: SIGNED_IN_SNAPSHOT.profile,
    });
    expect(toast.warning).not.toHaveBeenCalled();
    await tick(RESEND_MS * 5);
    expect(harness.set).toHaveBeenCalledTimes(2);
  });

  it("keeps the hold, silently and with no second restore, when a resend is refused for the keys again", async () => {
    const harness = await startOffline({});

    await tick(RESEND_MS);
    await tick(RESEND_MS);

    expect(harness.set).toHaveBeenCalledTimes(3);
    expect(harness.restoreLocal).toHaveBeenCalledTimes(1);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("starts no timer for a session main verified at once", async () => {
    const harness = renderWithFakes(ACCEPTED, {});
    harness.emitOutbound(SIGNED_IN_SNAPSHOT);
    await settle();

    await tick(RESEND_MS * 5);

    expect(harness.set).toHaveBeenCalledTimes(1);
    expect(harness.restoreLocal).not.toHaveBeenCalled();
  });

  it("ends the hold, and its timer, on a sign-out", async () => {
    const harness = await startOffline({});
    harness.answerSetWith(ACCEPTED);

    harness.emitOutbound(SIGNED_OUT_SNAPSHOT);
    await settle();
    expect(harness.set).toHaveBeenCalledTimes(2);
    await tick(RESEND_MS * 5);

    expect(harness.set).toHaveBeenCalledTimes(2);
  });

  it("ends the hold's timer on unmount", async () => {
    const harness = await startOffline({});

    harness.unmount();
    await tick(RESEND_MS * 5);

    expect(harness.set).toHaveBeenCalledTimes(1);
  });

  it("does not start a hand-over while the last one is still in flight", async () => {
    const harness = await startOffline({});
    harness.answerSetWith("pending");

    await tick(RESEND_MS);
    expect(harness.set).toHaveBeenCalledTimes(2);
    await tick(RESEND_MS * 3);
    expect(harness.set).toHaveBeenCalledTimes(2);

    harness.resolveSet({ kind: "resolve", result: NO_KEYS });
    await settle();
    expect(harness.restoreLocal).toHaveBeenCalledTimes(1);
    await tick(RESEND_MS);
    expect(harness.set).toHaveBeenCalledTimes(3);
  });

  it("hands the session over again on a wake signal while it holds, and only then", async () => {
    const harness = await startOffline({});
    expect(wake.listener).not.toBeNull();

    act(() => wake.listener?.());
    await settle();
    expect(harness.set).toHaveBeenCalledTimes(2);

    harness.answerSetWith(ACCEPTED);
    act(() => wake.listener?.());
    await settle();
    expect(harness.set).toHaveBeenCalledTimes(3);

    act(() => wake.listener?.());
    await settle();
    expect(harness.set).toHaveBeenCalledTimes(3);
  });

  describe("once main's keys are back and it judges the held session", () => {
    it("asks the sign-in service once, and tells the person once, whatever the number of ticks", async () => {
      const harness = await startOffline({});
      harness.answerSetWith(refused("expired"));

      await tick(RESEND_MS);
      await tick(RESEND_MS);
      await tick(RESEND_MS);

      expect(harness.revalidate).toHaveBeenCalledTimes(1);
      expect(toast.warning).toHaveBeenCalledTimes(1);
    });

    it("tells the person once for a verdict authn cannot settle, and does not ask it", async () => {
      const harness = await startOffline({});
      harness.answerSetWith(refused("malformed-token"));

      await tick(RESEND_MS);
      await tick(RESEND_MS);

      expect(harness.revalidate).not.toHaveBeenCalled();
      expect(toast.warning).toHaveBeenCalledTimes(1);
    });

    it("ends with main verified after authn refreshes the session, with no act by the person", async () => {
      const harness = await startOffline({});
      harness.answerSetWith(refused("expired"));
      harness.revalidate.mockImplementation(() => {
        harness.setCurrentSession(FRESH_SNAPSHOT);
        harness.answerSetWith(ACCEPTED);
        harness.emitOutbound(FRESH_SNAPSHOT);
        return Promise.resolve(null);
      });

      await tick(RESEND_MS);
      await settle();

      expect(harness.set).toHaveBeenLastCalledWith({
        status: "signed-in",
        token: FRESH_SNAPSHOT.token,
        profile: FRESH_SNAPSHOT.profile,
      });
      const handedOver = harness.set.mock.calls.length;
      await tick(RESEND_MS * 5);
      expect(harness.set).toHaveBeenCalledTimes(handedOver);
    });

    it("hands main the sign-out when the service signs the held session out", async () => {
      const harness = await startOffline({});
      harness.answerSetWith(refused("expired"));
      harness.revalidate.mockImplementation(() => {
        harness.setCurrentSession(SIGNED_OUT_SNAPSHOT);
        harness.answerSetWith(ACCEPTED);
        harness.emitOutbound(SIGNED_OUT_SNAPSHOT);
        return Promise.resolve(null);
      });

      await tick(RESEND_MS);
      await settle();

      expect(harness.set).toHaveBeenLastCalledWith({
        status: "signed-out",
        token: null,
        profile: null,
      });
      const handedOver = harness.set.mock.calls.length;
      await tick(RESEND_MS * 5);
      expect(harness.set).toHaveBeenCalledTimes(handedOver);
    });

    it("asks for the local restore and hands over no more when authn rejects the held session and the service demotes it to unverified", async () => {
      const harness = await startOffline({});
      harness.answerSetWith(refused("bad-signature"));
      // What the service projects when authn refuses the refresh: the session
      // stays as the local plane's identity (`unverified`), not a sign-out.
      harness.revalidate.mockImplementation(() => {
        harness.setCurrentSession(UNVERIFIED_SNAPSHOT);
        harness.emitOutbound(UNVERIFIED_SNAPSHOT);
        return Promise.resolve(null);
      });

      await tick(RESEND_MS);
      await settle();
      expect(harness.restoreLocal).toHaveBeenCalledTimes(2);
      const handedOver = harness.set.mock.calls.length;

      await tick(RESEND_MS * 5);

      expect(harness.set).toHaveBeenCalledTimes(handedOver);
      expect(harness.set).not.toHaveBeenCalledWith({
        status: "signed-out",
        token: null,
        profile: null,
      });
    });

    it("hands the same session over on the next tick when authn accepts it", async () => {
      const harness = await startOffline({});
      harness.answerSetWith(refused("unknown-signing-key"));
      await tick(RESEND_MS);
      expect(harness.revalidate).toHaveBeenCalledTimes(1);

      harness.answerSetWith(ACCEPTED);
      await tick(RESEND_MS);

      expect(harness.set).toHaveBeenLastCalledWith({
        status: "signed-in",
        token: SIGNED_IN_TOKEN,
        profile: SIGNED_IN_SNAPSHOT.profile,
      });
      const handedOver = harness.set.mock.calls.length;
      await tick(RESEND_MS * 5);
      expect(harness.set).toHaveBeenCalledTimes(handedOver);
    });

    it("keeps the hold and its timer when authn cannot be reached", async () => {
      const harness = await startOffline({});
      harness.answerSetWith(refused("expired"));
      harness.revalidate.mockRejectedValue(new Error("network down"));

      await tick(RESEND_MS);
      await tick(RESEND_MS);

      expect(harness.set).toHaveBeenCalledTimes(3);
      expect(harness.restoreLocal).toHaveBeenCalledTimes(1);
    });
  });

  it("lets a superseded write's refusal for the keys decide nothing", async () => {
    const harness = renderWithFakes(NO_KEYS, {});
    harness.answerSetWith("pending");
    harness.emitOutbound(SIGNED_IN_SNAPSHOT);
    harness.emitOutbound(FRESH_SNAPSHOT);
    await settle();
    expect(harness.set).toHaveBeenCalledTimes(2);

    harness.resolveSet({ kind: "resolve", result: NO_KEYS });
    await settle();
    expect(harness.restoreLocal).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();

    harness.resolveSet({ kind: "resolve", result: NO_KEYS });
    await settle();
    expect(harness.restoreLocal).toHaveBeenCalledTimes(1);
    expect(harness.restoreLocal).toHaveBeenCalledWith({
      userId: FRESH_SNAPSHOT.profile?.userId,
      token: FRESH_SNAPSHOT.token,
    });
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("releases the hold when a different session is written over it, and tells the person about its own refusal", async () => {
    const harness = await startOffline({});
    harness.answerSetWith(refused("expired"));
    await tick(RESEND_MS);
    expect(harness.revalidate).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledTimes(1);

    harness.setCurrentSession(FRESH_SNAPSHOT);
    harness.emitOutbound(FRESH_SNAPSHOT);
    await settle();

    // A fresh session's refusal: told, as any first refusal is, and not asked
    // about again as a held one would be.
    expect(toast.warning).toHaveBeenCalledTimes(2);
    expect(harness.revalidate).toHaveBeenCalledTimes(1);
    const handedOver = harness.set.mock.calls.length;
    await tick(RESEND_MS * 5);
    expect(harness.set).toHaveBeenCalledTimes(handedOver);
  });

  it("asks the sign-in service once about a rotated token it holds, when main then judges that one bad", async () => {
    const harness = await startOffline({});
    harness.setCurrentSession(FRESH_SNAPSHOT);
    harness.emitOutbound(FRESH_SNAPSHOT);
    await settle();
    expect(harness.restoreLocal).toHaveBeenCalledTimes(2);

    harness.answerSetWith(refused("expired"));
    await tick(RESEND_MS);
    await tick(RESEND_MS);
    await tick(RESEND_MS);

    expect(harness.revalidate).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it("holds a rotated token once, with no toast, and resends the new one", async () => {
    const harness = await startOffline({});
    expect(harness.restoreLocal).toHaveBeenCalledTimes(1);

    harness.setCurrentSession(FRESH_SNAPSHOT);
    harness.emitOutbound(FRESH_SNAPSHOT);
    await settle();

    expect(harness.restoreLocal).toHaveBeenCalledTimes(2);
    expect(harness.restoreLocal).toHaveBeenLastCalledWith({
      userId: FRESH_SNAPSHOT.profile?.userId,
      token: FRESH_SNAPSHOT.token,
    });
    expect(toast.warning).not.toHaveBeenCalled();
    const handedOver = harness.set.mock.calls.length;
    await tick(RESEND_MS);
    expect(harness.set).toHaveBeenCalledTimes(handedOver + 1);
    expect(harness.set).toHaveBeenLastCalledWith({
      status: "signed-in",
      token: FRESH_SNAPSHOT.token,
      profile: FRESH_SNAPSHOT.profile,
    });
    expect(harness.restoreLocal).toHaveBeenCalledTimes(2);
  });

  it("does not sign a second window out when main publishes its local fallback", async () => {
    const harness = await startOffline({});

    harness.emitInbound(UNVERIFIED_DESKTOP_SNAPSHOT);
    await settle();

    expect(harness.ingest).not.toHaveBeenCalled();
    expect(harness.restoreLocal).toHaveBeenCalledTimes(1);
  });
});
