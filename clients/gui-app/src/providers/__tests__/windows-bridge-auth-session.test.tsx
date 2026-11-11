import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import {
  AUTH_FETCH_MAX_ATTEMPTS,
  authRetryDelayMs,
} from "@traycer-clients/shared/auth/auth-validation";
import { Toaster } from "@/components/ui/sonner";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { WindowsBridgeAuthSessionBridge } from "@/providers/windows-bridge-auth-session";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import {
  AuthService,
  type AuthSessionSnapshot,
  type RevokedCloudAuthorization,
} from "@/lib/auth/auth-service";
import type {
  DesktopLocalAuthSessionRestoreResult,
  DesktopAuthSessionRefusalReason,
  DesktopAuthSessionSetResult,
  DesktopAuthSessionSnapshot,
} from "@/lib/windows/types";
import type { Mock, MockInstance } from "vitest";

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

const SIGNED_IN_DESKTOP_SNAPSHOT: DesktopAuthSessionSnapshot = {
  status: "signed-in",
  token: SIGNED_IN_TOKEN,
  profile: SIGNED_IN_PROFILE,
};

const ROTATED_TOKEN = "rotated-bearer-token";
const ROTATED_SNAPSHOT: AuthSessionSnapshot = {
  ...SIGNED_IN_SNAPSHOT,
  token: ROTATED_TOKEN,
};

const SIGNED_OUT_SNAPSHOT: AuthSessionSnapshot = {
  status: "signed-out",
  token: null,
  profile: null,
  contextMetadata: null,
};

/** What the cross-window revoke channel says about a refusal. */
type RevocationScope = "user-epoch" | null;

/**
 * What the AuthService's session becomes when it ingests a projection of
 * main's session: `null` when it declines (validation failed, or the
 * projection was dropped), else the snapshot it lands on. A real AuthService
 * emits that snapshot synchronously, before `ingest` resolves.
 */
type IngestLanding = (
  projection: AuthSessionSnapshot,
) => AuthSessionSnapshot | null;

type RenderWithFakesOptions = {
  readonly replayOutboundSnapshot?: AuthSessionSnapshot;
  readonly deferSet?: boolean;
  readonly omitRestoreLocal?: boolean;
  readonly omitPendingRefused?: boolean;
  readonly authService?: AuthService;
  readonly ingestLands?: IngestLanding;
  readonly deferIngest?: boolean;
  readonly restoreLocalAnswer?:
    | DesktopLocalAuthSessionRestoreResult
    | "rejects";
};

type AuthSessionSetResolution =
  | { readonly kind: "resolve"; readonly result: DesktopAuthSessionSetResult }
  | { readonly kind: "reject"; readonly cause: Error };

interface AuthSessionBridgeTestHarness {
  readonly emitInbound: (snapshot: DesktopAuthSessionSnapshot) => void;
  readonly emitOutbound: (snapshot: AuthSessionSnapshot) => void;
  readonly emitPendingRefused: (
    token: string,
    reason: DesktopAuthSessionRefusalReason,
  ) => void;
  readonly emitRevoked: (token: string, revocation: RevocationScope) => void;
  readonly emitVerificationRevoked: (
    token: string,
    revocation: RevocationScope,
  ) => void;
  readonly get: Mock<() => Promise<DesktopAuthSessionSnapshot>>;
  readonly ingest: MockInstance<
    (snapshot: AuthSessionSnapshot) => Promise<void>
  >;
  readonly landIngest: (landed: AuthSessionSnapshot | null) => void;
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
  readonly pendingRefusedDispose: Mock<() => void>;
  readonly resolveSet: (resolution: AuthSessionSetResolution) => void;
  readonly revoke: Mock<
    (rejectedToken: string, revocation: RevocationScope) => Promise<void>
  >;
  readonly set: Mock<
    (
      snapshot: DesktopAuthSessionSnapshot,
    ) => Promise<DesktopAuthSessionSetResult>
  >;
  readonly signOut: MockInstance<() => Promise<void>>;
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
  let pendingRefusedListener:
    | ((token: string, reason: DesktopAuthSessionRefusalReason) => void)
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
  const pendingRefusedDispose = vi.fn(() => {
    pendingRefusedListener = null;
  });

  const pendingIngests: Array<(landed: AuthSessionSnapshot | null) => void> =
    [];
  const realAuth = options.authService;
  const ingest =
    realAuth === undefined
      ? vi.fn((projection: AuthSessionSnapshot): Promise<void> => {
          if (options.deferIngest === true) {
            return new Promise<void>((resolve) => {
              pendingIngests.push((landed) => {
                if (landed !== null) outboundListener?.(landed);
                resolve();
              });
            });
          }
          const landed =
            options.ingestLands === undefined
              ? projection
              : options.ingestLands(projection);
          if (landed !== null) outboundListener?.(landed);
          return Promise.resolve();
        })
      : vi.spyOn(realAuth, "ingestProjectedSessionSnapshot");
  const ingestRevoked = vi.fn(
    (_rejectedToken: string, _revocation: RevocationScope): void => undefined,
  );
  const signOut =
    realAuth === undefined
      ? vi.fn(() => Promise.resolve())
      : vi.spyOn(realAuth, "signOut");
  mockUseAuthService.mockReturnValue(
    realAuth ?? {
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
    },
  );

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
    (_expected: {
      readonly userId: string;
      readonly token: string;
    }): Promise<DesktopLocalAuthSessionRestoreResult> => {
      const answer = options.restoreLocalAnswer ?? "restored";
      return answer === "rejects"
        ? Promise.reject(new Error("ipc closed"))
        : Promise.resolve(answer);
    },
  );
  mockUseWindowsBridge.mockReturnValue({
    authSession: {
      get,
      set,
      revoke,
      ...(options.omitRestoreLocal === true ? {} : { restoreLocal }),
      ...(options.omitPendingRefused === true
        ? {}
        : {
            onPendingRefused: (
              handler: (
                token: string,
                reason: DesktopAuthSessionRefusalReason,
              ) => void,
            ) => {
              pendingRefusedListener = handler;
              return { dispose: pendingRefusedDispose };
            },
          }),
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
    landIngest: (landed) => {
      const land = pendingIngests.shift();
      if (land === undefined) throw new Error("ingest is not pending");
      act(() => land(landed));
    },
    ingestRevoked,
    restoreLocal,
    inboundDispose,
    outboundDispose,
    pendingRefusedDispose,
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
    emitPendingRefused: (token, reason) => {
      if (pendingRefusedListener === null) {
        throw new Error("no pending-refused listener");
      }
      act(() => pendingRefusedListener?.(token, reason));
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

interface NoticeCopy {
  readonly title: string;
  readonly description: string;
  readonly code: string;
}

interface NoticeCase extends NoticeCopy {
  readonly label: string;
  readonly result: DesktopAuthSessionSetResult;
  readonly offersSignOut: boolean;
}

function expectNoticeCopy(row: HTMLElement, copy: NoticeCopy): void {
  expect(within(row).getByText(copy.title)).toBeTruthy();
  expect(within(row).getByText(copy.description)).toBeTruthy();
  expect(within(row).getByText(copy.code)).toBeTruthy();
}

function hasSignOutAction(row: HTMLElement): boolean {
  return within(row).queryByRole("button", { name: "Sign out" }) !== null;
}

const CANNOT_REACH = "Can't reach Traycer's sign-in service.";
const STILL_CONFIRMING = "Traycer is still confirming your sign-in.";
const KEEPS_TRYING = "Traycer will keep trying.";
const NOT_CONFIRMED = "Traycer couldn't confirm this sign-in.";
const RESTART_ONLINE = "Restart Traycer once you're back online.";

const UNREACHABLE_HELD_COPY: NoticeCopy = {
  title: CANNOT_REACH,
  description: "Hosts on your other devices will appear once it's back.",
  code: "key-source-unavailable",
};
const EXPIRED_COPY: NoticeCopy = {
  title: NOT_CONFIRMED,
  description: "Sign out and back in.",
  code: "expired",
};

const PENDING_UNREACHABLE: DesktopAuthSessionSetResult = {
  outcome: "pending",
  reason: "key-source-unavailable",
  heldLocally: true,
};
const PENDING_UNCONFIRMED: DesktopAuthSessionSetResult = {
  outcome: "pending",
  reason: "signing-key-unconfirmed",
  heldLocally: true,
};

const NOTICE_CASES: readonly NoticeCase[] = [
  {
    label: "pending, key source unreachable, held locally",
    result: PENDING_UNREACHABLE,
    ...UNREACHABLE_HELD_COPY,
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
    ...EXPIRED_COPY,
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

interface InboundAdoptionCase {
  readonly label: string;
  readonly inbound: DesktopAuthSessionSnapshot;
  readonly adopted: AuthSessionSnapshot;
}

const INBOUND_ADOPTIONS: readonly InboundAdoptionCase[] = [
  {
    label: "a newer session",
    inbound: { ...SIGNED_IN_DESKTOP_SNAPSHOT, token: ROTATED_TOKEN },
    adopted: ROTATED_SNAPSHOT,
  },
  {
    label: "a sibling's sign-out",
    inbound: SIGNED_OUT_DESKTOP_SNAPSHOT,
    adopted: SIGNED_OUT_SNAPSHOT,
  },
];

interface VerdictSource {
  readonly label: string;
  readonly result: DesktopAuthSessionSetResult;
  readonly reachVerdict: (
    harness: AuthSessionBridgeTestHarness,
  ) => Promise<void>;
}

const REFUSED_ANSWER: VerdictSource = {
  label: "a refused answer",
  result: { outcome: "refused", reason: "expired" },
  reachVerdict: () => Promise.resolve(),
};

const LATE_VERDICT: VerdictSource = {
  label: "a late re-check verdict",
  result: PENDING_UNREACHABLE,
  reachVerdict: async (harness) => {
    harness.emitPendingRefused(SIGNED_IN_TOKEN, "expired");
    await settle();
  },
};

const VERDICT_SOURCES: readonly VerdictSource[] = [
  REFUSED_ANSWER,
  LATE_VERDICT,
];

const OWN_SNAPSHOT: AuthSessionSnapshot = {
  ...SIGNED_IN_SNAPSHOT,
  token: "own-flow-bearer-token",
};

const RESTORE_UNAVAILABLE =
  "Traycer could not read your local session. Reload the window to try again.";

const RESTORE_FAILURES = [
  {
    label: "cannot read its local session",
    answer: "unavailable" as const,
    title: RESTORE_UNAVAILABLE,
  },
  {
    label: "cannot restore its local session",
    answer: "rejects" as const,
    title:
      "Traycer could not restore your local session. Reload the window to try again.",
  },
];

const FIRST_SIBLING_DESKTOP_SNAPSHOT: DesktopAuthSessionSnapshot = {
  ...SIGNED_IN_DESKTOP_SNAPSHOT,
  token: "first-sibling-bearer-token",
};

const declines: IngestLanding = () => null;

const VERDICT_THEN_ADOPTION = VERDICT_SOURCES.flatMap((source) =>
  INBOUND_ADOPTIONS.map((adoption) => ({
    label: `${source.label}, then ${adoption.label}`,
    result: source.result,
    reachVerdict: source.reachVerdict,
    inbound: adoption.inbound,
    adopted: adoption.adopted,
  })),
);

const authServices: AuthService[] = [];

function makeAuthService(): AuthService {
  const host = new MockRunnerHost({
    signInUrl:
      "https://auth.traycer.ai/sign-in?redirect_uri=traycer%3A%2F%2Fauth",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  const service = new AuthService({ runnerHost: host });
  authServices.push(service);
  return service;
}

function authnUserResponse(): Response {
  const { userId, userName, email } = SIGNED_IN_PROFILE;
  const at = "2024-01-01T00:00:00.000Z";
  return new Response(
    JSON.stringify({
      user: {
        id: userId,
        name: userName,
        providerId: `gh-${userId}`,
        providerHandle: userId,
        providerType: "GITHUB",
        email,
        avatarUrl: null,
        activatedAt: null,
        createdAt: at,
        updatedAt: at,
        lastSeenAt: null,
        privacyMode: false,
        isLearningEnabled: true,
      },
      userSubscription: {
        id: `sub-${userId}`,
        userID: userId,
        orgID: null,
        teamID: null,
        customerId: `cus-${userId}`,
        createdAt: at,
        updatedAt: at,
        subscriptionExpiry: null,
        trialEndsAt: null,
        subscriptionStatus: "FREE",
        hasPaymentMethod: false,
        isInTrial: false,
        rechargeRateSeconds: 0,
      },
      teamSubscriptions: [],
      payAsYouGoUsage: { allowPayAsYouGo: false },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "x-traycer-user-record-version": "2.0",
      },
    },
  );
}

interface AuthnRequestInit {
  readonly headers?: Record<string, string>;
}

/** Authn validates every bearer except `unreachableBearer`, which never answers. */
function stubAuthn(unreachableBearer: string | null): void {
  vi.stubGlobal(
    "fetch",
    (
      _input: unknown,
      init: AuthnRequestInit | undefined,
    ): Promise<Response> => {
      if (
        unreachableBearer !== null &&
        init?.headers?.Authorization === `Bearer ${unreachableBearer}`
      ) {
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return Promise.resolve(authnUserResponse());
    },
  );
}

async function letValidationRetriesElapse(): Promise<void> {
  for (let retry = 1; retry < AUTH_FETCH_MAX_ATTEMPTS; retry += 1) {
    await advanceTimers(authRetryDelayMs(retry));
  }
  await settle();
}

interface RealAuthWindow {
  readonly service: AuthService;
  readonly harness: AuthSessionBridgeTestHarness;
}

/**
 * A window whose real AuthService holds the signed-in session and writes it
 * to main, which answers `result`. Main's later fan-out of `ROTATED_TOKEN`
 * reaches the AuthService, which validates it against `stubAuthn`.
 */
async function startWithRealAuth(
  result: DesktopAuthSessionSetResult,
  unreachableBearer: string | null,
): Promise<RealAuthWindow> {
  stubAuthn(unreachableBearer);
  const service = makeAuthService();
  await service.ingestProjectedSessionSnapshot(SIGNED_IN_SNAPSHOT);
  const harness = renderWithFakes(result, { authService: service });
  await settle();
  return { service, harness };
}

async function startOnVerdict(
  source: VerdictSource,
  unreachableBearer: string | null,
): Promise<RealAuthWindow> {
  const window = await startWithRealAuth(source.result, unreachableBearer);
  await source.reachVerdict(window.harness);
  expectNoticeCopy(onlyNotice(), EXPIRED_COPY);
  return window;
}

const ROTATED_DESKTOP_SNAPSHOT: DesktopAuthSessionSnapshot = {
  ...SIGNED_IN_DESKTOP_SNAPSHOT,
  token: ROTATED_TOKEN,
};

describe("<WindowsBridgeAuthSessionBridge />", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useDesktopDialogStore.setState({ reportIssueAvailable: true });
  });

  afterEach(async () => {
    toast.dismiss();
    await letToastsLeave();
    cleanup();
    for (const service of authServices.splice(0)) {
      service.dispose();
    }
    vi.unstubAllGlobals();
    useAuthStore.getState().setSignedOut();
    useAuthStore.getState().setCloudVerdictLoss("unreachable");
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
      expectNoticeCopy(row, { title, description, code });
      expect(
        within(row).getByRole("button", { name: "Report issue" }),
      ).toBeTruthy();
      expect(hasSignOutAction(row)).toBe(offersSignOut);
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
    const harness = renderWithFakes(PENDING_UNREACHABLE, {});

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
    const harness = renderWithFakes(PENDING_UNCONFIRMED, {});

    await writeSession(harness, SIGNED_IN_SNAPSHOT);
    await advanceTimers(60_000);

    expect(noticeRows()).toHaveLength(1);
  });

  it("dismisses the pending notice when main fans out the session it was written for", async () => {
    const harness = renderWithFakes(PENDING_UNCONFIRMED, {});
    await writeSession(harness, SIGNED_IN_SNAPSHOT);
    expect(noticeRows()).toHaveLength(1);

    harness.emitInbound(SIGNED_IN_DESKTOP_SNAPSHOT);
    await letToastsLeave();

    expect(noticeRows()).toHaveLength(0);
    expect(harness.ingest).not.toHaveBeenCalled();
  });

  it("keeps the pending notice up when main fans out its unverified hold of the session", async () => {
    const harness = renderWithFakes(PENDING_UNREACHABLE, {});
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

  it("replaces the pending notice with the verdict when main's own re-check refuses the written session, and sends the session again", async () => {
    const harness = renderWithFakes(PENDING_UNREACHABLE, {});
    await writeSession(harness, SIGNED_IN_SNAPSHOT);
    expectNoticeCopy(onlyNotice(), UNREACHABLE_HELD_COPY);

    harness.emitPendingRefused(SIGNED_IN_TOKEN, "expired");
    await settle();

    const row = onlyNotice();
    expectNoticeCopy(row, EXPIRED_COPY);
    expect(
      within(row).getByRole("button", { name: "Report issue" }),
    ).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Sign out" }));
    expect(harness.signOut).toHaveBeenCalledTimes(1);

    await writeSession(harness, SIGNED_IN_SNAPSHOT);
    expect(harness.set).toHaveBeenCalledTimes(2);
  });

  it("ignores a re-check verdict for a bearer this window did not write", async () => {
    const harness = renderWithFakes(PENDING_UNREACHABLE, {});
    await writeSession(harness, SIGNED_IN_SNAPSHOT);

    harness.emitPendingRefused(ROTATED_TOKEN, "expired");
    await settle();

    const row = onlyNotice();
    expectNoticeCopy(row, UNREACHABLE_HELD_COPY);
    expect(hasSignOutAction(row)).toBe(false);
    await writeSession(harness, SIGNED_IN_SNAPSHOT);
    expect(harness.set).toHaveBeenCalledTimes(1);
  });

  it("shows only the verdict when main's re-check refuses the session before the write is answered pending", async () => {
    const harness = renderWithFakes(
      { outcome: "accepted" },
      { deferSet: true },
    );
    await writeSession(harness, SIGNED_IN_SNAPSHOT);

    harness.emitPendingRefused(SIGNED_IN_TOKEN, "expired");
    harness.resolveSet({ kind: "resolve", result: PENDING_UNREACHABLE });
    await settle();

    const row = onlyNotice();
    expectNoticeCopy(row, EXPIRED_COPY);
    expect(hasSignOutAction(row)).toBe(true);
  });

  it("shows no notice when the verified fan-out of the written session arrives before its pending answer", async () => {
    const harness = renderWithFakes(
      { outcome: "accepted" },
      { deferSet: true },
    );
    await writeSession(harness, SIGNED_IN_SNAPSHOT);

    harness.emitInbound(SIGNED_IN_DESKTOP_SNAPSHOT);
    harness.resolveSet({ kind: "resolve", result: PENDING_UNCONFIRMED });
    await settle();

    expect(noticeRows()).toHaveLength(0);
    expect(harness.ingest).not.toHaveBeenCalled();
  });

  it("still shows a pending notice for a session written again after an earlier write's verified fan-out", async () => {
    const harness = renderWithFakes(
      { outcome: "accepted" },
      { deferSet: true },
    );
    await writeSession(harness, SIGNED_IN_SNAPSHOT);
    harness.emitInbound(SIGNED_IN_DESKTOP_SNAPSHOT);
    await writeSession(harness, SIGNED_OUT_SNAPSHOT);
    await writeSession(harness, SIGNED_IN_SNAPSHOT);

    harness.resolveSet({ kind: "resolve", result: { outcome: "accepted" } });
    harness.resolveSet({ kind: "resolve", result: { outcome: "accepted" } });
    harness.resolveSet({ kind: "resolve", result: PENDING_UNREACHABLE });
    await settle();

    expectNoticeCopy(onlyNotice(), UNREACHABLE_HELD_COPY);
  });

  it.each(INBOUND_ADOPTIONS)(
    "dismisses the pending notice and adopts $label from main",
    async ({ inbound, adopted }) => {
      const harness = renderWithFakes(PENDING_UNCONFIRMED, {});
      await writeSession(harness, SIGNED_IN_SNAPSHOT);
      expect(noticeRows()).toHaveLength(1);

      harness.emitInbound(inbound);
      await letToastsLeave();

      expect(noticeRows()).toHaveLength(0);
      expect(harness.ingest).toHaveBeenCalledExactlyOnceWith(adopted);
    },
  );

  it.each(VERDICT_THEN_ADOPTION)(
    "dismisses a verdict notice when this window then adopts another session from main: $label",
    async ({ result, reachVerdict, inbound, adopted }) => {
      const harness = renderWithFakes(result, {});
      await writeSession(harness, SIGNED_IN_SNAPSHOT);
      await reachVerdict(harness);
      expectNoticeCopy(onlyNotice(), EXPIRED_COPY);

      harness.emitInbound(inbound);
      await letToastsLeave();

      expect(noticeRows()).toHaveLength(0);
      expect(harness.ingest).toHaveBeenCalledExactlyOnceWith(adopted);
    },
  );

  it.each(VERDICT_SOURCES)(
    "keeps the verdict notice when this window's AuthService does not adopt the session main fans out: $label",
    async (source) => {
      const { service, harness } = await startOnVerdict(source, ROTATED_TOKEN);

      harness.emitInbound(ROTATED_DESKTOP_SNAPSHOT);
      await letValidationRetriesElapse();
      await letToastsLeave();

      expect(service.getCurrentSessionSnapshot().token).toBe(SIGNED_IN_TOKEN);
      expect(harness.ingest).toHaveBeenCalledOnce();
      const row = onlyNotice();
      expectNoticeCopy(row, EXPIRED_COPY);
      expect(
        within(row).getByRole("button", { name: "Report issue" }),
      ).toBeTruthy();
      expect(hasSignOutAction(row)).toBe(true);
    },
  );

  it.each(VERDICT_SOURCES)(
    "dismisses the verdict notice once this window's AuthService adopts the session main fans out: $label",
    async (source) => {
      const { service, harness } = await startOnVerdict(source, null);

      harness.emitInbound(ROTATED_DESKTOP_SNAPSHOT);
      await letValidationRetriesElapse();
      await letToastsLeave();

      expect(service.getCurrentSessionSnapshot().token).toBe(ROTATED_TOKEN);
      expect(harness.ingest).toHaveBeenCalledOnce();
      expect(noticeRows()).toHaveLength(0);
    },
  );

  it("dismisses a pending notice when main fans out a session this window does not adopt, and keeps the write latched", async () => {
    const harness = renderWithFakes(PENDING_UNREACHABLE, {
      ingestLands: declines,
    });
    await writeSession(harness, SIGNED_IN_SNAPSHOT);
    expectNoticeCopy(onlyNotice(), UNREACHABLE_HELD_COPY);

    harness.emitInbound(ROTATED_DESKTOP_SNAPSHOT);
    await letToastsLeave();
    expect(noticeRows()).toHaveLength(0);

    await writeSession(harness, SIGNED_IN_SNAPSHOT);
    expect(harness.set).toHaveBeenCalledTimes(1);

    harness.emitPendingRefused(SIGNED_IN_TOKEN, "expired");
    await settle();
    expectNoticeCopy(onlyNotice(), EXPIRED_COPY);
  });

  it("shows no notice for an own pending answer that arrives after main fanned out another session", async () => {
    const harness = renderWithFakes(
      { outcome: "accepted" },
      { deferSet: true, ingestLands: declines },
    );
    await writeSession(harness, SIGNED_IN_SNAPSHOT);

    harness.emitInbound(ROTATED_DESKTOP_SNAPSHOT);
    harness.resolveSet({ kind: "resolve", result: PENDING_UNREACHABLE });
    await settle();

    expect(noticeRows()).toHaveLength(0);
  });

  it.each(PENDING_AND_REFUSED)(
    "shows nothing for a $label answer to a write that a session of main's this window adopted has superseded",
    async ({ result }) => {
      const harness = renderWithFakes(
        { outcome: "accepted" },
        { deferSet: true },
      );
      await writeSession(harness, SIGNED_IN_SNAPSHOT);
      harness.emitInbound(ROTATED_DESKTOP_SNAPSHOT);
      await settle();

      await writeSession(harness, ROTATED_SNAPSHOT);
      expect(harness.set).toHaveBeenCalledTimes(1);

      harness.resolveSet({ kind: "resolve", result });
      await settle();
      expect(noticeRows()).toHaveLength(0);
    },
  );

  it("dismisses a verdict notice and keeps the latch when this window's own session changes during a projection of main's", async () => {
    const harness = renderWithFakes(REFUSED_ANSWER.result, {
      ingestLands: () => OWN_SNAPSHOT,
    });
    await writeSession(harness, SIGNED_IN_SNAPSHOT);
    expectNoticeCopy(onlyNotice(), EXPIRED_COPY);

    harness.emitInbound(ROTATED_DESKTOP_SNAPSHOT);
    await letToastsLeave();
    expect(noticeRows()).toHaveLength(0);

    await writeSession(harness, OWN_SNAPSHOT);
    expect(harness.set).toHaveBeenCalledTimes(2);
  });

  it("keeps the verdict notice when main fans out the bearer this window already holds", async () => {
    const { service, harness } = await startOnVerdict(REFUSED_ANSWER, null);

    harness.emitInbound(SIGNED_IN_DESKTOP_SNAPSHOT);
    await letToastsLeave();

    expect(service.getCurrentSessionSnapshot().token).toBe(SIGNED_IN_TOKEN);
    expect(harness.ingest).toHaveBeenCalledOnce();
    const row = onlyNotice();
    expectNoticeCopy(row, EXPIRED_COPY);
    expect(hasSignOutAction(row)).toBe(true);
  });

  it("keeps the local-restore warning through a fan-out from main that this window does not adopt", async () => {
    const harness = renderWithFakes(PENDING_UNREACHABLE, {
      ingestLands: declines,
      restoreLocalAnswer: "unavailable",
    });
    await writeSession(harness, SIGNED_IN_SNAPSHOT);
    expectNoticeCopy(onlyNotice(), UNREACHABLE_HELD_COPY);

    harness.emitOutbound(UNVERIFIED_SNAPSHOT);
    await settle();
    expect(within(onlyNotice()).getByText(RESTORE_UNAVAILABLE)).toBeTruthy();

    harness.emitInbound(ROTATED_DESKTOP_SNAPSHOT);
    await letToastsLeave();

    expect(within(onlyNotice()).getByText(RESTORE_UNAVAILABLE)).toBeTruthy();
  });

  it.each(RESTORE_FAILURES)(
    "replaces the pending notice entirely with the local-restore warning when this window $label",
    async ({ answer, title }) => {
      const harness = renderWithFakes(PENDING_UNREACHABLE, {
        restoreLocalAnswer: answer,
      });
      await writeSession(harness, SIGNED_IN_SNAPSHOT);
      expectNoticeCopy(onlyNotice(), UNREACHABLE_HELD_COPY);

      harness.emitOutbound(UNVERIFIED_SNAPSHOT);
      await settle();

      const row = onlyNotice();
      expect(within(row).getByText(title)).toBeTruthy();
      expect(
        within(row).queryByText(UNREACHABLE_HELD_COPY.description),
      ).toBeNull();
      expect(within(row).queryByText(UNREACHABLE_HELD_COPY.code)).toBeNull();
      expect(
        within(row).queryByRole("button", { name: "Report issue" }),
      ).toBeNull();
    },
  );

  it("writes nothing back and moves the latch when a later projection lands after an earlier one has settled", async () => {
    const harness = renderWithFakes(
      { outcome: "accepted" },
      { deferIngest: true },
    );
    await writeSession(harness, SIGNED_IN_SNAPSHOT);
    harness.emitInbound(FIRST_SIBLING_DESKTOP_SNAPSHOT);
    harness.emitInbound(ROTATED_DESKTOP_SNAPSHOT);

    harness.landIngest(null);
    await settle();
    harness.landIngest(ROTATED_SNAPSHOT);
    await settle();

    expect(harness.set.mock.calls.map(([snapshot]) => snapshot.token)).toEqual([
      SIGNED_IN_TOKEN,
    ]);
    await writeSession(harness, ROTATED_SNAPSHOT);
    expect(harness.set).toHaveBeenCalledTimes(1);
  });

  it("dismisses a pending notice when main fans out a session this window's AuthService cannot validate, and the window keeps its own", async () => {
    const { service, harness } = await startWithRealAuth(
      PENDING_UNREACHABLE,
      ROTATED_TOKEN,
    );
    expectNoticeCopy(onlyNotice(), UNREACHABLE_HELD_COPY);

    harness.emitInbound(ROTATED_DESKTOP_SNAPSHOT);
    await letValidationRetriesElapse();
    await letToastsLeave();

    expect(service.getCurrentSessionSnapshot().token).toBe(SIGNED_IN_TOKEN);
    expect(noticeRows()).toHaveLength(0);
  });

  it("shows the pending notice on a shell with no re-check channel", async () => {
    const harness = renderWithFakes(PENDING_UNREACHABLE, {
      omitPendingRefused: true,
    });

    await writeSession(harness, SIGNED_IN_SNAPSHOT);

    expectNoticeCopy(onlyNotice(), UNREACHABLE_HELD_COPY);
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

  it("suppresses an accepted write's echo and cleans up its subscriptions", async () => {
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

    harness.emitInbound(SIGNED_IN_DESKTOP_SNAPSHOT);
    expect(harness.ingest).not.toHaveBeenCalled();

    harness.unmount();
    expect(harness.outboundDispose).toHaveBeenCalledTimes(1);
    expect(harness.inboundDispose).toHaveBeenCalledTimes(1);
    expect(harness.pendingRefusedDispose).toHaveBeenCalledTimes(1);

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
