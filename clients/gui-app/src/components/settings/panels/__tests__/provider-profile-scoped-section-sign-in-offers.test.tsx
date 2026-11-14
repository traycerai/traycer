// Providers page section, through the real ProviderProfileScopedSection.
// offersSignIns on providers.list is the only switch. Absent and false keep
// today's copy. The profile row, including a no-home presence, is the prop.
const clientMock = vi.hoisted(
  (): { current: HostClient<HostRpcRegistry> | null } => ({ current: null }),
);

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return { ...actual, useHostClient: () => clientMock.current };
});
vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host/runtime")>();
  return { ...actual, useHostClient: () => clientMock.current };
});

import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  profile,
  provider,
} from "@/components/settings/panels/permissions/__tests__/judge-test-support";
import { ProviderProfileScopedSection } from "@/components/settings/panels/provider-profile-scoped-section";
import { profileWithStanding } from "@/components/settings/panels/__tests__/provider-profile-standing-fixture";
import { TooltipProvider } from "@/components/ui/tooltip";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { useProviderLinkDialogStore } from "@/stores/providers/provider-link-dialog-store";
import { useSettingsEnvironmentPickStore } from "@/stores/settings/settings-environment-pick-store";

const HOST_ID = "host-providers-page";
const PROFILE_ID = "work";
const SIGN_IN = "Sign in";
const SIGN_IN_EVERYWHERE = "Sign in to use everywhere";
const ON_THIS_HOST = "On this host only, link to use everywhere.";
const AVAILABLE_HERE = "Available on this computer";
const NOT_ON_COMPUTER = "Not on this computer yet";
const NOT_ON_DEVICE = "Not on this device yet";
const LINE_TESTID = "profile-on-host-only";

type Offers = true | false | "10.11";
type ListResponse = ResponseOfMethod<HostRpcRegistry, "providers.list">;
type ProfilePresence = NonNullable<ProviderProfile["presence"]>;

interface RecordedCall {
  readonly method: string;
}

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  clientMock.current = null;
  useSettingsEnvironmentPickStore.setState({ pick: null });
  useProviderLinkDialogStore.setState({ target: null });
});

function signedOutAuth(): ProviderProfile["auth"] {
  return {
    status: "unauthenticated",
    badgeText: null,
    label: null,
    detail: null,
  };
}

function rowProfile(input: {
  readonly kind: "ambient" | "managed";
  readonly signedOut: boolean;
  readonly presence: ProfilePresence | null;
}): ProviderProfile {
  const base = profile(PROFILE_ID, input.kind);
  return {
    ...base,
    label: "Work",
    auth: input.signedOut ? signedOutAuth() : base.auth,
    ...(input.presence === null ? {} : { presence: input.presence }),
  };
}

function listBody(offers: Offers, onHostOnly: boolean): ListResponse {
  const body: ListResponse = {
    providers: [provider("opencode", [])],
    native: null,
    ...(onHostOnly
      ? { onHostOnly: [{ providerId: "opencode", profileId: PROFILE_ID }] }
      : {}),
  };
  if (offers === "10.11") return body;
  return { ...body, offersSignIns: offers };
}

function renderSection(input: {
  readonly offers: Offers;
  readonly row: ProviderProfile;
  readonly signedOut: boolean;
  readonly onHostOnly: boolean;
  readonly advertiseLink: boolean;
}) {
  const calls: RecordedCall[] = [];
  let listCalls = 0;
  const body = listBody(input.offers, input.onHostOnly);
  const { client } = buildEnvironmentClient({
    hostId: HOST_ID,
    handlers: {
      "providers.list": () => {
        listCalls += 1;
        return body;
      },
      "providers.startLogin": () => {
        calls.push({ method: "providers.startLogin" });
        return {
          url: null,
          started: false,
          profileId: null,
          userCode: null,
          failure: null,
          pending: null,
          pack: null,
          targetRefusal: null,
        };
      },
    },
  });
  clientMock.current = client;
  const oldComputer = input.offers === "10.11";
  const manifest = {
    "providers.list": { major: 10, minor: oldComputer ? 11 : 12 },
    ...(input.advertiseLink
      ? { "providers.link": { major: 1, minor: 1 } }
      : {}),
    "providers.startLogin": { major: 1, minor: oldComputer ? 4 : 5 },
    "providers.awaitLogin": { major: 2, minor: oldComputer ? 2 : 4 },
  } as const;
  recordNegotiatedHostManifest(HOST_ID, manifest);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const onAddProfile = vi.fn<() => void>();
  const state = provider("opencode", [input.row]);
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ProviderProfileScopedSection
          state={input.signedOut ? { ...state, auth: signedOutAuth() } : state}
          hostId={HOST_ID}
          isSelectedHostLocal
          canAddProfile
          credentialRefusal={null}
          onOpenCliSettings={() => undefined}
          startInReauth={false}
          failedAttempt={null}
          onAddProfile={onAddProfile}
          onDismissFailedAttempt={() => undefined}
          selectedProfileId={PROFILE_ID}
          onSelectedProfileIdChange={() => undefined}
          profileEnablementAvailable={false}
          profileEnablementPending={() => false}
          onSetProfileEnabled={() => undefined}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return {
    onAddProfile,
    startLogins: () => calls.length,
    listCalls: () => listCalls,
  };
}

describe("ProviderProfileScopedSection offersSignIns", () => {
  it("offers Sign in to use everywhere on a signed-out terminal row when the fact is true", async () => {
    const harness = renderSection({
      offers: true,
      row: rowProfile({ kind: "ambient", signedOut: true, presence: null }),
      signedOut: true,
      onHostOnly: false,
      advertiseLink: false,
    });
    const button = await screen.findByRole("button", {
      name: SIGN_IN_EVERYWHERE,
    });
    fireEvent.click(button);
    expect(harness.onAddProfile).toHaveBeenCalledTimes(1);
    expect(harness.startLogins()).toBe(0);
    expect(harness.listCalls()).toBe(1);
  });

  it.each([false, "10.11"] as const)(
    "keeps today's Sign in on a signed-out terminal row when offersSignIns is %s",
    async (offers) => {
      const harness = renderSection({
        offers,
        row: rowProfile({ kind: "ambient", signedOut: true, presence: null }),
        signedOut: true,
        onHostOnly: false,
        advertiseLink: false,
      });
      expect(await screen.findByRole("button", { name: SIGN_IN })).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: SIGN_IN_EVERYWHERE }),
      ).toBeNull();
      expect(harness.listCalls()).toBe(1);
    },
  );

  it("says Available on this computer when the fact is true", async () => {
    const harness = renderSection({
      offers: true,
      row: rowProfile({ kind: "managed", signedOut: false, presence: null }),
      signedOut: false,
      onHostOnly: true,
      advertiseLink: false,
    });
    const line = await screen.findByTestId(LINE_TESTID);
    expect(line.textContent).toContain(AVAILABLE_HERE);
    expect(
      screen.queryByRole("button", { name: SIGN_IN_EVERYWHERE }),
    ).toBeNull();
    expect(harness.listCalls()).toBe(1);
  });

  it("keeps today's on-this-host line and Link on a 10.11 computer", async () => {
    const harness = renderSection({
      offers: "10.11",
      row: rowProfile({ kind: "managed", signedOut: false, presence: null }),
      signedOut: false,
      onHostOnly: true,
      advertiseLink: true,
    });
    const line = await screen.findByTestId(LINE_TESTID);
    expect(line.textContent).toContain(ON_THIS_HOST);
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    expect(useProviderLinkDialogStore.getState().target).toEqual({
      providerId: "opencode",
      profileId: PROFILE_ID,
    });
    expect(screen.queryByText(AVAILABLE_HERE)).toBeNull();
    expect(harness.listCalls()).toBe(1);
  });

  it.each([true, "10.11"] as const)(
    "shows the no-home summary and stale standing when offersSignIns is %s",
    async (offers) => {
      const harness = renderSection({
        offers,
        row: profileWithStanding(
          { material: "stale", cause: "session expired" },
          rowProfile({
            kind: "managed",
            signedOut: false,
            presence: { kind: "no-home" },
          }),
        ),
        signedOut: false,
        onHostOnly: false,
        advertiseLink: false,
      });
      if (offers === true) {
        expect(await screen.findByText(NOT_ON_COMPUTER)).toBeTruthy();
        expect(screen.queryByText(NOT_ON_DEVICE)).toBeNull();
      } else {
        expect(await screen.findByText(NOT_ON_DEVICE)).toBeTruthy();
        expect(screen.queryByText(NOT_ON_COMPUTER)).toBeNull();
      }
      expect(screen.getByText("Stale")).toBeTruthy();
      expect(harness.listCalls()).toBe(1);
    },
  );
});
