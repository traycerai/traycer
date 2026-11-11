import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { WindowsBridgeAuthSessionBridge } from "@/providers/windows-bridge-auth-session";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import type {
  AuthSessionSnapshot,
  RevokedCloudAuthorization,
} from "@/lib/auth/auth-service";
import type {
  DesktopLocalAuthSessionRestoreResult,
  DesktopAuthSessionSetResult,
  DesktopAuthSessionSnapshot,
} from "@/lib/windows/types";
import type { Mock } from "vitest";

vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "dark" }) }));

const mockUseAuthService = vi.hoisted(() => vi.fn());
vi.mock("@/lib/host", () => ({ useAuthService: mockUseAuthService }));

const mockUseWindowsBridge = vi.hoisted(() => vi.fn());
vi.mock("@/providers/windows-bridge-context", () => ({
  useWindowsBridge: mockUseWindowsBridge,
}));

const SIGNED_IN_TOKEN = "bearer-token";
const SIGNED_IN_PROFILE = {
  userId: "u1",
  userName: "Ada",
  email: "ada@example.com",
};
const SIGNED_IN_SNAPSHOT: AuthSessionSnapshot = {
  status: "signed-in",
  token: SIGNED_IN_TOKEN,
  profile: SIGNED_IN_PROFILE,
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

const ROTATED_SNAPSHOT: AuthSessionSnapshot = {
  ...SIGNED_IN_SNAPSHOT,
  token: "rotated-bearer-token",
};

const SIGNED_OUT_SNAPSHOT: AuthSessionSnapshot = {
  status: "signed-out",
  token: null,
  profile: null,
  contextMetadata: null,
};

/** What the cross-window revoke channel says about a refusal. */
type RevocationScope = "user-epoch" | null;

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
  readonly revoke: Mock<
    (rejectedToken: string, revocation: RevocationScope) => Promise<void>
  >;
  readonly set: Mock<
    (
      snapshot: DesktopAuthSessionSnapshot,
    ) => Promise<DesktopAuthSessionSetResult>
  >;
  readonly signOut: Mock<() => Promise<void>>;
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
  const pendingSetResolvers: Array<
    (resolution: AuthSessionSetResolution) => void
  > = [];
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
  const ingestRevoked = vi.fn(
    (_rejectedToken: string, _revocation: RevocationScope): void => undefined,
  );
  const signOut = vi.fn(() => Promise.resolve());
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
    ingestProjectedSessionSnapshot: ingest,
    ingestCloudAuthorizationRevoked: ingestRevoked,
    signOut,
  });

  const revoke = vi.fn((_rejectedToken: string, _revocation: RevocationScope) =>
    Promise.resolve(),
  );
  const set = vi.fn((snapshot: DesktopAuthSessionSnapshot) => {
    if (!options.deferSet) {
      if (setResult.outcome === "accepted") {
        mainSnapshot = snapshot;
      }
      return Promise.resolve(setResult);
    }
    return new Promise<DesktopAuthSessionSetResult>((resolve, reject) => {
      pendingSetResolvers.push((resolution) => {
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
    (_expected: { readonly userId: string; readonly token: string }) =>
      Promise.resolve("restored" as const),
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
    <>
      <WindowsBridgeAuthSessionBridge>
        <div>content</div>
      </WindowsBridgeAuthSessionBridge>
      <Toaster />
    </>,
  );

  return {
    get,
    ingest,
    ingestRevoked,
    restoreLocal,
    inboundDispose,
    outboundDispose,
    resolveSet: (resolution) => {
      const resolveOldest = pendingSetResolvers.shift();
      if (resolveOldest === undefined) {
        throw new Error("set is not pending");
      }
      resolveOldest(resolution);
    },
    set,
    signOut,
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

/** Sonner mounts a toast on the macrotask after it is created. */
const TOAST_ENTER_MS = 1;

async function settle(): Promise<void> {
  await act(async () => {
    await drainMicrotasks();
    await vi.advanceTimersByTimeAsync(TOAST_ENTER_MS);
  });
}

async function advanceTimers(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

async function writeSession(
  harness: AuthSessionBridgeTestHarness,
  snapshot: AuthSessionSnapshot,
): Promise<void> {
  harness.emitOutbound(snapshot);
  await settle();
}

/**
 * A dismissed toast leaves through two animation frames, a render, and a
 * 200ms unmount timer set only after that render, so one long advance inside
 * one `act` never reaches the removal.
 */
const TOAST_EXIT_STEP_MS = 100;
const TOAST_EXIT_STEPS = 5;

async function letToastsLeave(): Promise<void> {
  for (let step = 0; step < TOAST_EXIT_STEPS; step += 1) {
    await advanceTimers(TOAST_EXIT_STEP_MS);
  }
}

function noticeRows(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-sonner-toast]"),
  );
}

function onlyNotice(): HTMLElement {
  const rows = noticeRows();
  const [row] = rows;
  if (rows.length !== 1) {
    throw new Error(`Expected exactly one notice, found ${rows.length}`);
  }
  return row;
}

interface NoticeCase {
  readonly label: string;
  readonly result: DesktopAuthSessionSetResult;
  readonly title: string;
  readonly description: string;
  readonly code: string;
  readonly offersSignOut: boolean;
}

const CANNOT_REACH = "Can't reach Traycer's sign-in service.";
const STILL_CONFIRMING = "Traycer is still confirming your sign-in.";
const KEEPS_TRYING = "Traycer will keep trying.";
const NOT_CONFIRMED = "Traycer couldn't confirm this sign-in.";
const RESTART_ONLINE = "Restart Traycer once you're back online.";

const NOTICE_CASES: readonly NoticeCase[] = [
  {
    label: "pending, key source unreachable, held locally",
    result: {
      outcome: "pending",
      reason: "key-source-unavailable",
      heldLocally: true,
    },
    title: CANNOT_REACH,
    description: "Hosts on your other devices will appear once it's back.",
    code: "key-source-unavailable",
    offersSignOut: false,
  },
  {
    label: "pending, key source unreachable, not held locally",
    result: {
      outcome: "pending",
      reason: "key-source-unavailable",
      heldLocally: false,
    },
    title: CANNOT_REACH,
    description: KEEPS_TRYING,
    code: "key-source-unavailable",
    offersSignOut: false,
  },
  {
    label: "pending, signing key unconfirmed, held locally",
    result: {
      outcome: "pending",
      reason: "signing-key-unconfirmed",
      heldLocally: true,
    },
    title: STILL_CONFIRMING,
    description: "Hosts on your other devices will appear once it's done.",
    code: "signing-key-unconfirmed",
    offersSignOut: false,
  },
  {
    label: "pending, signing key unconfirmed, not held locally",
    result: {
      outcome: "pending",
      reason: "signing-key-unconfirmed",
      heldLocally: false,
    },
    title: STILL_CONFIRMING,
    description: KEEPS_TRYING,
    code: "signing-key-unconfirmed",
    offersSignOut: false,
  },
  {
    label: "refused as expired",
    result: { outcome: "refused", reason: "expired" },
    title: NOT_CONFIRMED,
    description: "Sign out and back in.",
    code: "expired",
    offersSignOut: true,
  },
  {
    label: "refused for an unknown signing key",
    result: { outcome: "refused", reason: "unknown-signing-key" },
    title: NOT_CONFIRMED,
    description: "Sign out and back in.",
    code: "unknown-signing-key",
    offersSignOut: true,
  },
  {
    label: "refused by an older shell, key source unreachable",
    result: { outcome: "refused", reason: "key-source-unavailable" },
    title: CANNOT_REACH,
    description: RESTART_ONLINE,
    code: "key-source-unavailable",
    offersSignOut: false,
  },
  {
    label: "refused by an older shell, signing key unconfirmed",
    result: { outcome: "refused", reason: "signing-key-unconfirmed" },
    title: CANNOT_REACH,
    description: RESTART_ONLINE,
    code: "signing-key-unconfirmed",
    offersSignOut: false,
  },
];

const PENDING_AND_REFUSED = [
  {
    label: "pending",
    result: {
      outcome: "pending" as const,
      reason: "signing-key-unconfirmed" as const,
      heldLocally: false,
    },
  },
  {
    label: "refused",
    result: { outcome: "refused" as const, reason: "expired" as const },
  },
];

describe("<WindowsBridgeAuthSessionBridge />", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
  });

  afterEach(async () => {
    toast.dismiss();
    await letToastsLeave();
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    useDesktopDialogStore.getState().close();
    useDesktopDialogStore.setState({ reportIssueAvailable: false });
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

  it.each(NOTICE_CASES)(
    "shows one notice with its copy, its code and Report issue: $label",
    async ({ result, title, description, code, offersSignOut }) => {
      const harness = renderWithFakes(result, {});

      await writeSession(harness, SIGNED_IN_SNAPSHOT);

      const row = onlyNotice();
      expect(within(row).getByText(title)).toBeTruthy();
      expect(within(row).getByText(description)).toBeTruthy();
      expect(within(row).getByText(code)).toBeTruthy();
      expect(
        within(row).getByRole("button", { name: "Report issue" }),
      ).toBeTruthy();
      expect(
        within(row).queryByRole("button", { name: "Sign out" }) !== null,
      ).toBe(offersSignOut);
    },
  );

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

  it("keeps the latch and the notice when main answers pending, so the same session is not sent again", async () => {
    const harness = renderWithFakes(
      {
        outcome: "pending",
        reason: "key-source-unavailable",
        heldLocally: true,
      },
      {},
    );

    await writeSession(harness, SIGNED_IN_SNAPSHOT);
    expect(harness.set).toHaveBeenCalledTimes(1);

    await writeSession(harness, SIGNED_IN_SNAPSHOT);
    await letToastsLeave();

    expect(harness.set).toHaveBeenCalledTimes(1);
    expect(noticeRows()).toHaveLength(1);
  });

  it("shows nothing when main accepts the pushed session", async () => {
    const harness = renderWithFakes({ outcome: "accepted" }, {});

    await writeSession(harness, SIGNED_IN_SNAPSHOT);

    expect(noticeRows()).toHaveLength(0);
  });

  it("keeps the pending notice on screen until it is dismissed", async () => {
    const harness = renderWithFakes(
      {
        outcome: "pending",
        reason: "signing-key-unconfirmed",
        heldLocally: true,
      },
      {},
    );

    await writeSession(harness, SIGNED_IN_SNAPSHOT);
    await advanceTimers(60_000);

    expect(noticeRows()).toHaveLength(1);
  });

  it("dismisses the pending notice when main fans out the session it was written for", async () => {
    const harness = renderWithFakes(
      {
        outcome: "pending",
        reason: "signing-key-unconfirmed",
        heldLocally: true,
      },
      {},
    );
    await writeSession(harness, SIGNED_IN_SNAPSHOT);
    expect(noticeRows()).toHaveLength(1);

    harness.emitInbound({
      status: "signed-in",
      token: SIGNED_IN_SNAPSHOT.token,
      profile: SIGNED_IN_SNAPSHOT.profile,
    });
    await letToastsLeave();

    expect(noticeRows()).toHaveLength(0);
    expect(harness.ingest).not.toHaveBeenCalled();
  });

  it("keeps the pending notice up when main fans out its unverified hold of the session", async () => {
    const harness = renderWithFakes(
      {
        outcome: "pending",
        reason: "key-source-unavailable",
        heldLocally: true,
      },
      {},
    );
    await writeSession(harness, SIGNED_IN_SNAPSHOT);

    harness.emitInbound(UNVERIFIED_DESKTOP_SNAPSHOT);
    await letToastsLeave();

    expect(noticeRows()).toHaveLength(1);
    expect(harness.ingest).not.toHaveBeenCalled();
  });

  it("signs out and tracks it when the person chooses Sign out on a refused sign-in", async () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    const harness = renderWithFakes(
      { outcome: "refused", reason: "bad-signature" },
      {},
    );
    await writeSession(harness, SIGNED_IN_SNAPSHOT);

    fireEvent.click(
      within(onlyNotice()).getByRole("button", { name: "Sign out" }),
    );

    expect(track).toHaveBeenCalledWith(AnalyticsEvent.SignOutRequested, {
      source: "notification",
    });
    expect(harness.signOut).toHaveBeenCalledTimes(1);
  });

  it.each(NOTICE_CASES)(
    "reports the notice's fixed copy and code without identifying the person, and keeps the notice up: $label",
    async ({ result, title, description, code }) => {
      const harness = renderWithFakes(result, {});
      await writeSession(harness, SIGNED_IN_SNAPSHOT);
      const row = onlyNotice();

      fireEvent.click(
        within(row).getByRole("button", { name: "Report issue" }),
      );
      await letToastsLeave();

      const { reportIssueContext } = useDesktopDialogStore.getState();
      expect(reportIssueContext).toEqual({
        title,
        message: description,
        code,
        source: "Desktop sign-in",
      });
      const disclosed = JSON.stringify([row.textContent, reportIssueContext]);
      for (const secret of [
        SIGNED_IN_PROFILE.userId,
        SIGNED_IN_PROFILE.email,
        SIGNED_IN_PROFILE.userName,
        SIGNED_IN_TOKEN,
      ]) {
        expect(disclosed).not.toContain(secret);
      }
      expect(noticeRows()).toHaveLength(1);
    },
  );

  it.each(PENDING_AND_REFUSED)(
    "shows nothing for a $label answer to a write that is no longer the latest",
    async ({ result }) => {
      const harness = renderWithFakes(
        { outcome: "accepted" },
        { deferSet: true },
      );
      await writeSession(harness, SIGNED_IN_SNAPSHOT);
      await writeSession(harness, ROTATED_SNAPSHOT);

      harness.resolveSet({ kind: "resolve", result });
      await settle();
      expect(noticeRows()).toHaveLength(0);

      harness.resolveSet({ kind: "resolve", result });
      await settle();
      expect(noticeRows()).toHaveLength(1);
    },
  );

  it.each(PENDING_AND_REFUSED)(
    "dismisses a $label notice when this window writes a new session",
    async ({ result }) => {
      const harness = renderWithFakes(
        { outcome: "accepted" },
        { deferSet: true },
      );
      await writeSession(harness, SIGNED_IN_SNAPSHOT);
      harness.resolveSet({ kind: "resolve", result });
      await settle();
      expect(noticeRows()).toHaveLength(1);

      await writeSession(harness, SIGNED_OUT_SNAPSHOT);
      await letToastsLeave();

      expect(noticeRows()).toHaveLength(0);
    },
  );

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
