import type { ReactNode } from "react";
import type { UserSessionListItem } from "@traycer/protocol/auth/devices-sessions";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StepUpCredential } from "@/lib/auth/step-up-flow";
import { StepUpRequiredError } from "@/lib/auth/step-up-flow";
import type { StepUpPromptRequest } from "@/lib/auth/step-up-prompt";
import { useAuthStore } from "@/stores/auth/auth-store";

/**
 * Captures the active step-up prompt so tests can cancel/verify without driving
 * Radix dialog DOM (same pattern as host-credential-provision-provider tests).
 */
const dialogState = vi.hoisted<{
  request: StepUpPromptRequest | null;
  onCancel: (() => void) | null;
}>(() => ({
  request: null,
  onCancel: null,
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

const signOutMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

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

/** Closed `<details>` stays in the DOM; role queries skip it until it is open. */
function openSessionDetails(): void {
  for (const summary of screen.getAllByText("Details")) {
    const details = summary.parentElement;
    if (!(details instanceof HTMLDetailsElement)) {
      throw new Error("expected a session details disclosure");
    }
    details.open = true;
  }
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
    revokeMutateAsync.mockReset();
    revokeMutateAsync.mockRejectedValue(new StepUpRequiredError());
    revokeAllMutateAsync.mockReset();
    revokeAllMutateAsync.mockResolvedValue({ ok: true });
    signOutMock.mockReset();
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

    expect(screen.getByText("Last seen 25 Aug 08:35")).toBeTruthy();
    openSessionDetails();
    expect(
      screen
        .getByText("Desktop · App 1.2.3 · Created 25 Oct 2025")
        .closest("details"),
    ).not.toBeNull();
  });

  it("describes where the account is signed in, without the old client-list sentence", () => {
    render(<DevicesSessionsPanel />);

    expect(
      screen.getByText(
        "Review where your account is signed in and remove access you no longer recognize.",
      ),
    ).toBeDefined();
    expect(
      screen.queryByText(
        "Browser, desktop, CLI, extension, and host access for this account.",
      ),
    ).toBeNull();
  });

  it("labels the active credential as this session on the status line", () => {
    sessionsState.sessions = [
      makeSession({ familyId: "family-current", current: true }),
    ];

    render(<DevicesSessionsPanel />);

    expect(screen.getByText(/^This session · Last seen /)).toBeDefined();
    expect(screen.queryByText("This session")).toBeNull();
    expect(screen.queryByText("This device")).toBeNull();
    expect(screen.queryByText("Session")).toBeNull();
  });

  it("puts the name first, platform and location on the next line, and the version in Details", () => {
    sessionsState.sessions = [
      makeSession({
        familyId: "family-loc",
        displayLabel: "Office laptop",
        platform: "macOS",
        appVersion: "2.0.0",
        location: "Berlin",
      }),
    ];
    render(<DevicesSessionsPanel />);

    const name = screen.getByText("Office laptop");
    expect(name.className).toContain("wrap-anywhere");
    expect(name.classList.contains("truncate")).toBe(false);
    expect(screen.getByText("macOS · Berlin")).toBeDefined();
    expect(screen.getByRole("img", { name: "Desktop" })).toBeDefined();
    expect(
      screen.queryByText("Office laptop / macOS / App 2.0.0 / Berlin"),
    ).toBeNull();
    openSessionDetails();
    expect(screen.getByText(/^Desktop · App 2\.0\.0 · Created /)).toBeDefined();
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

    expect(screen.getByText("CLI session")).toBeDefined();
    expect(screen.getByText("linux")).toBeDefined();
    expect(screen.getByText("Web session")).toBeDefined();
    expect(screen.getByText("Windows")).toBeDefined();
    expect(screen.getByRole("img", { name: "CLI" })).toBeDefined();
    expect(screen.getByRole("img", { name: "Web" })).toBeDefined();
    expect(screen.queryByText(/ \/ $/)).toBeNull();
    expect(screen.queryByText(/\/\s*\//)).toBeNull();
    openSessionDetails();
    expect(screen.getByText(/^CLI · Created /)).toBeDefined();
    expect(screen.getByText(/^Web · Created /)).toBeDefined();
    expect(screen.queryByText(/^Created /)).toBeNull();
  });

  it("names each known client kind on the icon and in Details", () => {
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

    expect(screen.getByRole("img", { name: "Extension" })).toBeDefined();
    expect(screen.getByRole("img", { name: "Mobile app" })).toBeDefined();
    expect(screen.getByRole("img", { name: "Host" })).toBeDefined();
    expect(screen.queryByText("Extension")).toBeNull();
    expect(screen.queryByText("Mobile app")).toBeNull();
    expect(screen.queryByText("Host")).toBeNull();
    openSessionDetails();
    for (const client of ["Extension", "Mobile app", "Host"]) {
      const line = screen.getByText((text) =>
        text.startsWith(`${client} · App 1.2.3 · Created `),
      );
      expect(line.closest("details")).not.toBeNull();
    }
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

    const name = screen.getByText("Session details unavailable");
    expect(name.className).toContain("wrap-anywhere");
    expect(screen.queryByText("macOS")).toBeNull();
    expect(screen.queryByText("San Francisco")).toBeNull();
  });

  it("uses a neutral icon and an aria-label for explicit and unrecognized client kinds", () => {
    sessionsState.sessions = [
      makeSession({ familyId: "family-unknown", clientKind: "unknown" }),
      makeSession({
        familyId: "family-future",
        clientKind: "future-client",
      }),
    ];
    const { container } = render(<DevicesSessionsPanel />);

    expect(screen.getAllByRole("img", { name: "Unknown client" })).toHaveLength(
      2,
    );
    expect(screen.queryByText("Unknown client")).toBeNull();
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
});
