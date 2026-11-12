import type { ReactNode } from "react";
import type { UserSessionListItem } from "@traycer/protocol/auth/devices-sessions";
import {
  act,
  cleanup,
  fireEvent,
  render as renderUi,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StepUpCredential } from "@/lib/auth/step-up-flow";
import { StepUpRequiredError } from "@/lib/auth/step-up-flow";
import type { StepUpPromptRequest } from "@/lib/auth/step-up-prompt";
import { SignOutConfirmDialog } from "@/components/auth/sign-out-confirm-dialog";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSignOutConfirmStore } from "@/stores/auth/sign-out-confirm-store";

/**
 * Captures the active step-up prompt so tests can cancel/verify without driving
 * Radix dialog DOM (same pattern as host-credential-provision-provider tests).
 */
const dialogState = vi.hoisted<{
  request: StepUpPromptRequest | null;
  onCancel: (() => void) | null;
  onVerified: ((credential: StepUpCredential) => void) | null;
}>(() => ({
  request: null,
  onCancel: null,
  onVerified: null,
}));

const revokeMutateAsync = vi.hoisted(() =>
  vi.fn(
    (_input: {
      readonly familyId: string;
      readonly useStepUpCredential: boolean;
    }): Promise<{ readonly familyId: string; readonly revoked: true }> =>
      Promise.reject(new StepUpRequiredError()),
  ),
);

const revokeAllMutateAsync = vi.hoisted(() =>
  vi.fn((): Promise<unknown> => Promise.resolve({ ok: true })),
);

const sessionsState = vi.hoisted<{
  sessions: readonly UserSessionListItem[];
  isPending: boolean;
  isError: boolean;
  fetchStatus: "idle" | "fetching" | "paused";
}>(() => ({
  sessions: [],
  isPending: false,
  isError: false,
  fetchStatus: "idle",
}));

const signOutMock = vi.hoisted(() =>
  vi.fn<() => Promise<boolean>>(() => Promise.resolve(true)),
);

vi.mock("@/hooks/auth/use-user-sessions-query", () => ({
  useAuthFetchUserSessions: () => ({
    data: { sessions: sessionsState.sessions },
    isPending: sessionsState.isPending,
    isError: sessionsState.isError,
    fetchStatus: sessionsState.fetchStatus,
  }),
}));

vi.mock("@/hooks/auth/use-revoke-user-session-mutation", () => ({
  useAuthRevokeUserSession: () => ({
    isPending: false,
    mutateAsync: revokeMutateAsync,
  }),
}));

vi.mock("@/hooks/auth/use-revoke-all-sessions-mutation", () => ({
  useAuthRevokeAllSessions: () => ({
    isPending: false,
    mutateAsync: revokeAllMutateAsync,
  }),
}));

vi.mock("@/lib/host", () => ({
  useAuthService: () => ({ signOut: signOutMock }),
  useHostBinding: () => ({
    auth: { signOut: signOutMock },
  }),
}));

vi.mock("@/components/auth/step-up-challenge-dialog", () => ({
  StepUpChallengeDialog: (props: {
    readonly request: StepUpPromptRequest | null;
    readonly onVerified: (credential: StepUpCredential) => void;
    readonly onCancel: () => void;
  }): ReactNode => {
    dialogState.request = props.request;
    dialogState.onCancel = props.onCancel;
    dialogState.onVerified = props.onVerified;
    return null;
  },
}));

import { DevicesSessionsPanel } from "../devices-sessions-panel";

function makeSession(
  overrides: Partial<UserSessionListItem> & {
    readonly familyId: string;
  },
): UserSessionListItem {
  return {
    familyId: overrides.familyId,
    clientKind: overrides.clientKind ?? "desktop",
    displayLabel:
      overrides.displayLabel === undefined
        ? "MacBook Pro"
        : overrides.displayLabel,
    platform: overrides.platform === undefined ? "macOS" : overrides.platform,
    appVersion:
      overrides.appVersion === undefined ? "1.2.3" : overrides.appVersion,
    location:
      overrides.location === undefined ? "San Francisco" : overrides.location,
    createdAt: overrides.createdAt ?? "2026-07-01T00:00:00.000Z",
    lastSeenAt: overrides.lastSeenAt ?? "2026-07-08T12:00:00.000Z",
    revoked: overrides.revoked ?? false,
    revokedAt: overrides.revokedAt ?? null,
    revokedBy: overrides.revokedBy ?? null,
    current: overrides.current ?? false,
  };
}

/** Per-row sign-out (not "Sign out everywhere"). */
function sessionSignOutButton(): HTMLElement {
  return screen.getByRole("button", { name: /^Sign out$/ });
}

function render(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return renderUi(
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  );
}

function renderWithSignOutDialog(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  renderUi(
    <QueryClientProvider client={queryClient}>
      <>
        <DevicesSessionsPanel />
        <SignOutConfirmDialog />
      </>
    </QueryClientProvider>,
  );
}

function signIn(): void {
  useAuthStore.setState({
    status: "signed-in",
    profile: {
      userId: "user-1",
      userName: "Ada",
      email: "ada@example.com",
    },
    contextMetadata: { userId: "user-1", username: "ada" },
    shareableTeams: [],
    subscriptionStatus: null,
  });
}

function signOut(): void {
  useAuthStore.setState({
    status: "signed-out",
    profile: null,
    contextMetadata: null,
    shareableTeams: [],
    subscriptionStatus: null,
  });
}

async function waitForPrompt(): Promise<StepUpPromptRequest> {
  await waitFor(() => {
    expect(dialogState.request).not.toBeNull();
  });
  const request = dialogState.request;
  if (request === null) {
    throw new Error("expected an active step-up prompt");
  }
  return request;
}

describe("<DevicesSessionsPanel />", () => {
  beforeEach(() => {
    dialogState.request = null;
    dialogState.onCancel = null;
    dialogState.onVerified = null;
    revokeMutateAsync.mockReset();
    revokeMutateAsync.mockRejectedValue(new StepUpRequiredError());
    revokeAllMutateAsync.mockReset();
    revokeAllMutateAsync.mockResolvedValue({ ok: true });
    signOutMock.mockReset();
    signOutMock.mockResolvedValue(true);
    useSignOutConfirmStore.getState().setOpen(false);
    sessionsState.sessions = [
      makeSession({ familyId: "family-other", current: false }),
    ];
    sessionsState.isPending = false;
    sessionsState.isError = false;
    sessionsState.fetchStatus = "idle";
    signIn();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useSignOutConfirmStore.getState().setOpen(false);
    signOut();
  });

  it("uses Settings dates when a session is old enough to show absolute dates", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 25, 12));
    sessionsState.sessions = [
      makeSession({
        familyId: "family-other",
        createdAt: new Date(2025, 9, 25, 8, 35).toISOString(),
        lastSeenAt: new Date(2026, 7, 25, 8, 35).toISOString(),
      }),
    ];
    render(<DevicesSessionsPanel />);

    expect(
      screen.getByText("Created 25 Oct 2025 · Last seen 25 Aug 08:35"),
    ).toBeTruthy();
    expect(
      screen.getByText("MacBook Pro / macOS / App 1.2.3 / San Francisco"),
    ).toBeTruthy();
    expect(screen.getByText("Desktop").getAttribute("data-variant")).toBe(
      "outline",
    );
    expect(screen.getByText("Session")).toBeTruthy();
  });

  it("restores the client-list sentence under Signed-in sessions", () => {
    render(<DevicesSessionsPanel />);

    expect(
      screen.getByText(
        "Review where your account is signed in and remove access you no longer recognize.",
      ),
    ).toBeDefined();
    expect(
      screen.getByRole("heading", { name: "Signed-in sessions" }),
    ).toBeDefined();
    expect(
      screen.getByText(
        "Browser, desktop, CLI, extension, and host access for this account.",
      ),
    ).toBeDefined();
  });

  it("titles the current row This session and leaves that phrase off the timeline", () => {
    sessionsState.sessions = [
      makeSession({ familyId: "family-current", current: true }),
    ];

    render(<DevicesSessionsPanel />);

    expect(screen.getByText("This session")).toBeDefined();
    const timeline = screen.getByText(/^Created /);
    expect(timeline.textContent).toMatch(/^Created .* · Last seen /);
    expect(timeline.textContent).not.toContain("This session");
    expect(screen.queryByText("This device")).toBeNull();
    expect(screen.queryByText("Session")).toBeNull();
  });

  it("badges a revoked row Signed out without prefixing the timeline", () => {
    sessionsState.sessions = [
      makeSession({
        familyId: "family-revoked",
        current: false,
        revoked: true,
        revokedAt: "2026-07-08T11:00:00.000Z",
      }),
    ];

    render(<DevicesSessionsPanel />);

    expect(screen.getByText("Session")).toBeDefined();
    const kind = screen.getByText("Desktop");
    expect(kind.getAttribute("data-slot")).toBe("badge");
    expect(kind.getAttribute("data-variant")).toBe("outline");
    const signedOut = screen.getByText("Signed out");
    expect(signedOut.getAttribute("data-slot")).toBe("badge");
    expect(signedOut.getAttribute("data-variant")).toBe("muted");
    const timeline = screen.getByText(/^Created /);
    expect(timeline.textContent).toMatch(/^Created .+ · Signed out /);
    expect(timeline.textContent).not.toContain("This session");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("shows name, platform, app version, location, and the timeline without Details", () => {
    sessionsState.sessions = [
      makeSession({
        familyId: "family-current",
        current: true,
        displayLabel: "Office laptop",
        platform: "macOS",
        appVersion: "2.0.0",
        location: "Berlin",
      }),
      makeSession({
        familyId: "family-older",
        current: false,
        displayLabel: "Home desktop",
        platform: "Windows",
        appVersion: "1.4.0",
        location: "Austin",
      }),
    ];
    render(<DevicesSessionsPanel />);

    expect(screen.getByText("This session")).toBeDefined();
    expect(screen.getByText("Session")).toBeDefined();
    const currentFacts = screen.getByText(
      "Office laptop / macOS / App 2.0.0 / Berlin",
    );
    const olderFacts = screen.getByText(
      "Home desktop / Windows / App 1.4.0 / Austin",
    );
    expect(currentFacts.closest("details")).toBeNull();
    expect(olderFacts.closest("details")).toBeNull();
    const timelines = screen.getAllByText(/^Created /);
    expect(timelines).toHaveLength(2);
    for (const line of timelines) {
      expect(line.textContent).toMatch(/^Created .* · Last seen /);
      expect(line.textContent).not.toContain("This session");
      expect(line.closest("details")).toBeNull();
    }
    expect(screen.queryByText("Details")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    const kindBadges = screen.getAllByText("Desktop");
    expect(kindBadges).toHaveLength(2);
    for (const badge of kindBadges) {
      expect(badge.getAttribute("data-slot")).toBe("badge");
      expect(badge.getAttribute("data-variant")).toBe("outline");
    }
  });

  it("omits null or blank location without a stray separator", () => {
    sessionsState.sessions = [
      makeSession({
        familyId: "family-null-loc",
        displayLabel: "CLI session",
        platform: "linux",
        appVersion: null,
        location: null,
        clientKind: "cli",
      }),
      makeSession({
        familyId: "family-blank-loc",
        displayLabel: "Web session",
        platform: "Windows",
        appVersion: null,
        location: "   ",
        clientKind: "web",
      }),
    ];
    render(<DevicesSessionsPanel />);

    expect(screen.getByText("CLI session / linux")).toBeDefined();
    expect(screen.getByText("Web session / Windows")).toBeDefined();
    expect(screen.getByText("CLI").getAttribute("data-variant")).toBe(
      "outline",
    );
    expect(screen.getByText("Web").getAttribute("data-variant")).toBe(
      "outline",
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText(/ \/ $/)).toBeNull();
    expect(screen.queryByText(/\/\s*\//)).toBeNull();
    expect(screen.queryByText(/ · · /)).toBeNull();
    expect(screen.queryByText(/App /)).toBeNull();
    expect(screen.getAllByText(/^Created /)).toHaveLength(2);
  });

  it("names each known client kind on an outline badge, not the facts line", () => {
    sessionsState.sessions = [
      makeSession({
        familyId: "family-extension",
        clientKind: "extension",
        displayLabel: "Extension window",
      }),
      makeSession({
        familyId: "family-mobile",
        clientKind: "mobile",
        displayLabel: "Phone",
      }),
      makeSession({
        familyId: "family-host",
        clientKind: "host",
        displayLabel: "Build host",
      }),
    ];
    render(<DevicesSessionsPanel />);

    expect(screen.queryByRole("img")).toBeNull();
    for (const [label, client] of [
      ["Extension window", "Extension"],
      ["Phone", "Mobile app"],
      ["Build host", "Host"],
    ] as const) {
      const line = screen.getByText(
        `${label} / macOS / App 1.2.3 / San Francisco`,
      );
      expect(line.closest("details")).toBeNull();
      const badge = screen.getByText(client);
      expect(badge.getAttribute("data-slot")).toBe("badge");
      expect(badge.getAttribute("data-variant")).toBe("outline");
    }
    expect(screen.getAllByText(/^Created /)).toHaveLength(3);
  });

  it("says session details are unavailable when name, platform, and location are empty", () => {
    sessionsState.sessions = [
      makeSession({
        familyId: "family-empty",
        displayLabel: "   ",
        platform: null,
        location: "",
        appVersion: null,
      }),
    ];
    render(<DevicesSessionsPanel />);

    expect(screen.getByText("Session details unavailable")).toBeDefined();
    expect(screen.getByText("Desktop")).toBeDefined();
    expect(screen.getByText(/^Created /)).toBeDefined();
    expect(screen.queryByText("macOS")).toBeNull();
    expect(screen.queryByText("San Francisco")).toBeNull();
    expect(screen.queryByText(/App /)).toBeNull();
  });

  it("names an unrecognized client on a badge and leaves the icon decorative", () => {
    sessionsState.sessions = [
      makeSession({ familyId: "family-unknown", clientKind: "unknown" }),
      makeSession({
        familyId: "family-future",
        clientKind: "future-client",
      }),
    ];
    const { container } = render(<DevicesSessionsPanel />);

    expect(screen.queryByRole("img")).toBeNull();
    const badges = screen.getAllByText("Unknown client");
    expect(badges).toHaveLength(2);
    for (const badge of badges) {
      expect(badge.getAttribute("data-slot")).toBe("badge");
      expect(badge.getAttribute("data-variant")).toBe("outline");
    }
    expect(
      screen.getAllByText("MacBook Pro / macOS / App 1.2.3 / San Francisco"),
    ).toHaveLength(2);
    expect(container.querySelector("[role='img']")).toBeNull();
    expect(container.querySelector("[aria-label='Unknown client']")).toBeNull();
    expect(
      container.querySelectorAll("svg.lucide-circle-question-mark"),
    ).toHaveLength(2);
  });

  it("does not show an alert banner when the user cancels step-up during revoke", async () => {
    render(<DevicesSessionsPanel />);

    fireEvent.click(sessionSignOutButton());
    await waitForPrompt();

    act(() => {
      dialogState.onCancel?.();
    });

    await waitFor(() => {
      expect(dialogState.request).toBeNull();
    });
    expect(screen.queryByRole("alert")).toBeNull();
    // Pre-fix: cancel used to surface the literal StepUpCanceledError message.
    expect(screen.queryByText("Verification canceled.")).toBeNull();
  });

  it("shows an alert banner when a real revoke failure occurs", async () => {
    revokeMutateAsync.mockRejectedValueOnce(
      new Error("Couldn't reach Traycer to sign out this session."),
    );
    render(<DevicesSessionsPanel />);

    fireEvent.click(sessionSignOutButton());

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(
      screen.getByText("Couldn't reach Traycer to sign out this session."),
    ).toBeDefined();
  });

  it.each(["current session", "all sessions"] as const)(
    "keeps a local sign-out retry after a successful %s revoke",
    async (scope) => {
      if (scope === "current session") {
        sessionsState.sessions = [
          makeSession({ familyId: "local-session", current: true }),
        ];
        revokeMutateAsync.mockImplementation(({ familyId }) =>
          Promise.resolve({
            familyId,
            revoked: true,
          }),
        );
      }
      signOutMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      renderWithSignOutDialog();

      fireEvent.click(
        scope === "current session"
          ? sessionSignOutButton()
          : screen.getByRole("button", { name: "Sign out everywhere" }),
      );
      if (scope === "all sessions") {
        await waitForPrompt();
        act(() => {
          dialogState.onVerified?.({ expiresAtMs: Date.now() + 10_000 });
        });
      }

      await waitFor(() => {
        expect(signOutMock).toHaveBeenCalledTimes(1);
      });
      expect(await screen.findByRole("alert")).toBeDefined();
      expect(screen.getByRole("alert").textContent).toBe(
        "Couldn't sign out. Please try again.",
      );

      const sharedDialog = screen.getByTestId("confirm-destructive-dialog");
      fireEvent.click(
        within(sharedDialog).getByRole("button", { name: "Sign out" }),
      );
      await waitFor(() => {
        expect(signOutMock).toHaveBeenCalledTimes(2);
      });
      await waitFor(() => {
        expect(screen.queryByTestId("confirm-destructive-dialog")).toBeNull();
      });

      expect(revokeMutateAsync).toHaveBeenCalledTimes(
        scope === "current session" ? 1 : 0,
      );
      expect(revokeAllMutateAsync).toHaveBeenCalledTimes(
        scope === "all sessions" ? 1 : 0,
      );
    },
  );
});
