import "../../../../../__tests__/test-browser-apis";
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
    signOut();
  });

  it("renders the sessions section description with the expanded client list", () => {
    render(<DevicesSessionsPanel />);

    expect(
      screen.getByText(
        "Browser, desktop, CLI, extension, and host access for this account.",
      ),
    ).toBeDefined();
  });

  it("labels the active credential as this session", () => {
    sessionsState.sessions = [
      makeSession({ familyId: "family-current", current: true }),
    ];

    render(<DevicesSessionsPanel />);

    expect(screen.getByText("This session")).toBeDefined();
    expect(screen.queryByText("This device")).toBeNull();
  });

  it("includes session location in the display line", () => {
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

    expect(
      screen.getByText("Office laptop / macOS / App 2.0.0 / Berlin"),
    ).toBeDefined();
  });

  it("omits null or blank location without a stray separator", () => {
    sessionsState.sessions = [
      makeSession({
        familyId: "family-null-loc",
        displayLabel: "CLI session",
        platform: "linux",
        appVersion: null,
        location: null,
      }),
      makeSession({
        familyId: "family-blank-loc",
        displayLabel: "Web session",
        platform: "Windows",
        appVersion: null,
        location: "   ",
      }),
    ];
    render(<DevicesSessionsPanel />);

    expect(screen.getByText("CLI session / linux")).toBeDefined();
    expect(screen.getByText("Web session / Windows")).toBeDefined();
    expect(screen.queryByText(/ \/ $/)).toBeNull();
    expect(screen.queryByText(/\/\s*\//)).toBeNull();
  });

  it("uses a neutral icon and honest labels for explicit and unrecognized client kinds", () => {
    sessionsState.sessions = [
      makeSession({ familyId: "family-unknown", clientKind: "unknown" }),
      makeSession({
        familyId: "family-future",
        clientKind: "future-client",
      }),
    ];
    const { container } = render(<DevicesSessionsPanel />);

    expect(screen.getAllByText("Unknown client")).toHaveLength(2);
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
