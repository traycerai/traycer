import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  ProviderAuth,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import {
  pinProfile,
  providerState,
  removedEntry,
} from "@/components/providers/__tests__/profile-pin-fixtures";
import {
  createProfileListHost,
  readinessFor,
  type ProfileListAnswer,
  type ProfileListHost,
} from "@/components/providers/__tests__/profile-pin-host-fixture";
import { ProviderReauthBanner } from "@/components/chat/composer/provider-reauth-banner";
import {
  continueOnTerminalOffered,
  useLandingProviderReauthGate,
  useProviderReauthGate,
  type ProviderReauthGate,
} from "@/components/chat/composer/use-provider-reauth-gate";
import type { HostRpcRegistry } from "@/lib/host";

const holder = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
}));
const authServiceStub = vi.hoisted(() => ({
  recordSignInRequest: vi.fn(() => Promise.resolve({ kind: "failed" })),
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: (client: object | null) => readinessFor(client),
}));

vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-1",
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: [] }),
}));

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => holder.client,
}));
vi.mock("@/lib/host", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host")>();
  return { ...actual, useAuthService: () => authServiceStub };
});

vi.mock("@/lib/host/runtime", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host/runtime")>();
  return {
    ...actual,
    useHostBinding: () => null,
    useAuthService: () => authServiceStub,
  };
});

vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => null,
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: () => undefined }),
}));

vi.mock("@/components/report-issue/report-issue-action", () => ({
  ReportIssueAction: () => null,
}));

function managed(input: {
  readonly profileId: string;
  readonly label: string;
  readonly authStatus: "authenticated" | "unauthenticated";
  readonly personNotice: "needs-sign-in" | null;
  readonly terminalOnThisComputer: boolean;
}): ProviderProfile {
  return pinProfile({
    profileId: input.profileId,
    label: input.label,
    kind: "managed",
    enabled: true,
    authStatus: input.authStatus,
    aliases: [],
    personNotice: input.personNotice,
    terminalOnThisComputer: input.terminalOnThisComputer,
    otherNames: [],
  });
}

function hostFor(answer: ProfileListAnswer): ProfileListHost {
  const host = createProfileListHost({
    answer,
    answerProfileName: (request) => ({ label: request.label }),
    failSetEnabled: false,
  });
  holder.client = host.client;
  return host;
}

/** What both composers draw from their gate: the one banner and its one button. */
function GateBanner(props: { readonly gate: ProviderReauthGate }): ReactNode {
  const { gate } = props;
  if (gate.providerId === null || gate.reason === null) return <p>clear</p>;
  return (
    <ProviderReauthBanner
      providerId={gate.providerId}
      state={gate.state}
      reason={gate.reason}
      profileId={gate.profileId}
      profileLabel={gate.profileLabel}
      epicId={null}
      viewTabId={null}
      onContinueOnAmbient={
        continueOnTerminalOffered(gate) ? () => undefined : null
      }
    />
  );
}

/** The landing composer's gate. */
function Banner(props: { readonly profileId: string | null }): ReactNode {
  const gate = useLandingProviderReauthGate(
    holder.client,
    "codex",
    props.profileId,
    true,
  );
  return <GateBanner gate={gate} />;
}

/** The chat composer's gate: the tab's host, and a pin its own settings hold. */
function ChatBanner(props: { readonly profileId: string | null }): ReactNode {
  const gate = useProviderReauthGate(
    "codex",
    props.profileId,
    true,
    "authoritative",
  );
  return <GateBanner gate={gate} />;
}

describe("the landing reauth banner and a Terminal pin", () => {
  afterEach(() => {
    holder.client = null;
    cleanup();
  });

  it("offers Sign in and no Continue when a record row gates the Terminal pin", async () => {
    const host = hostFor({
      providers: [
        providerState({
          providerId: "codex",
          authStatus: "authenticated",
          profiles: [
            managed({
              profileId: "work-row",
              label: "Work",
              authStatus: "authenticated",
              personNotice: "needs-sign-in",
              terminalOnThisComputer: true,
            }),
          ],
        }),
      ],
      native: null,
      removedProfiles: [],
    });
    render(
      <host.Wrapper>
        <Banner profileId={null} />
      </host.Wrapper>,
    );

    await waitFor(() => {
      expect(host.listCalls.length).toBeGreaterThan(0);
      expect(screen.getByRole("button", { name: "Sign in" })).toBeDefined();
    });
    expect(
      screen.queryByRole("button", { name: "Continue on Terminal account" }),
    ).toBeNull();
  });

  it("still offers Continue on Terminal account for a signed-out managed pin", async () => {
    const host = hostFor({
      providers: [
        providerState({
          providerId: "codex",
          authStatus: "authenticated",
          profiles: [
            managed({
              profileId: "work-row",
              label: "Work",
              authStatus: "unauthenticated",
              personNotice: null,
              terminalOnThisComputer: false,
            }),
          ],
        }),
      ],
      native: null,
      removedProfiles: [],
    });
    render(
      <host.Wrapper>
        <Banner profileId="work-row" />
      </host.Wrapper>,
    );

    await waitFor(() => {
      expect(host.listCalls.length).toBeGreaterThan(0);
      expect(
        screen.getByRole("button", { name: "Continue on Terminal account" }),
      ).toBeDefined();
    });
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDefined();
  });
});

describe("the landing reauth banner while the Terminal account is signed out", () => {
  afterEach(() => {
    holder.client = null;
    cleanup();
  });

  function signedOutManagedPin(terminal: {
    readonly providerAuth: ProviderAuth["status"];
    readonly ambientAuth: ProviderAuth["status"] | null;
  }): ProfileListHost {
    return hostFor({
      providers: [
        providerState({
          providerId: "codex",
          authStatus: terminal.providerAuth,
          profiles: [
            ...(terminal.ambientAuth === null
              ? []
              : [
                  pinProfile({
                    profileId: "terminal-row",
                    label: "Terminal account",
                    kind: "ambient",
                    enabled: true,
                    authStatus: terminal.ambientAuth,
                    aliases: [],
                    personNotice: null,
                    terminalOnThisComputer: true,
                    otherNames: [],
                  }),
                ]),
            managed({
              profileId: "work-row",
              label: "Work",
              authStatus: "unauthenticated",
              personNotice: null,
              terminalOnThisComputer: false,
            }),
          ],
        }),
      ],
      native: null,
      removedProfiles: [],
    });
  }

  it("shows only Sign in for a signed-out managed pin", async () => {
    const host = signedOutManagedPin({
      providerAuth: "unauthenticated",
      ambientAuth: null,
    });
    render(
      <host.Wrapper>
        <Banner profileId="work-row" />
      </host.Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sign in" })).toBeDefined();
    });
    expect(
      screen.queryByRole("button", { name: "Continue on Terminal account" }),
    ).toBeNull();
  });

  it("hides the button when the Terminal row is signed out though the provider summary lags", async () => {
    const host = signedOutManagedPin({
      providerAuth: "authenticated",
      ambientAuth: "unauthenticated",
    });
    render(
      <host.Wrapper>
        <Banner profileId="work-row" />
      </host.Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sign in" })).toBeDefined();
    });
    expect(
      screen.queryByRole("button", { name: "Continue on Terminal account" }),
    ).toBeNull();
  });

  it("hides the button while the Terminal account's sign-in is unknown", async () => {
    const host = signedOutManagedPin({
      providerAuth: "unknown",
      ambientAuth: "unknown",
    });
    render(
      <host.Wrapper>
        <Banner profileId="work-row" />
      </host.Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sign in" })).toBeDefined();
    });
    expect(
      screen.queryByRole("button", { name: "Continue on Terminal account" }),
    ).toBeNull();
  });

  it("hides the button in the chat composer while the Terminal account's sign-in is unknown", async () => {
    const host = signedOutManagedPin({
      providerAuth: "unknown",
      ambientAuth: "unknown",
    });
    render(
      <host.Wrapper>
        <ChatBanner profileId="work-row" />
      </host.Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sign in" })).toBeDefined();
    });
    expect(
      screen.queryByRole("button", { name: "Continue on Terminal account" }),
    ).toBeNull();
  });

  it("offers the button in the chat composer once the Terminal account is signed in", async () => {
    const host = signedOutManagedPin({
      providerAuth: "authenticated",
      ambientAuth: "authenticated",
    });
    render(
      <host.Wrapper>
        <ChatBanner profileId="work-row" />
      </host.Wrapper>,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Continue on Terminal account" }),
      ).toBeDefined();
    });
  });

  it("offers the button again once the Terminal account is signed in", async () => {
    const host = signedOutManagedPin({
      providerAuth: "authenticated",
      ambientAuth: "authenticated",
    });
    render(
      <host.Wrapper>
        <Banner profileId="work-row" />
      </host.Wrapper>,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Continue on Terminal account" }),
      ).toBeDefined();
    });
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDefined();
  });

  it("shows only Manage in Settings for a removed account", async () => {
    const host = hostFor({
      providers: [
        providerState({
          providerId: "codex",
          authStatus: "unauthenticated",
          profiles: [],
        }),
      ],
      native: null,
      removedProfiles: [
        removedEntry({
          providerId: "codex",
          profileId: "gone-row",
          aliases: [],
        }),
      ],
    });
    render(
      <host.Wrapper>
        <Banner profileId="gone-row" />
      </host.Wrapper>,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Manage in Settings" }),
      ).toBeDefined();
    });
    expect(
      screen.queryByRole("button", { name: "Continue on Terminal account" }),
    ).toBeNull();
  });
});
