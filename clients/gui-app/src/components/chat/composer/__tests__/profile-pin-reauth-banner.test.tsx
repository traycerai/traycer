import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import {
  pinProfile,
  providerState,
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
} from "@/components/chat/composer/use-provider-reauth-gate";
import type { HostRpcRegistry } from "@/lib/host";

const holder = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
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

vi.mock("@/lib/host/runtime", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/host/runtime")>();
  return {
    ...actual,
    useHostBinding: () => null,
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

function Banner(props: { readonly profileId: string | null }): ReactNode {
  const gate = useLandingProviderReauthGate(
    holder.client,
    "codex",
    props.profileId,
    true,
  );
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
