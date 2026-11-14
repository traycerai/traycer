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
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  profile,
  provider,
} from "@/components/settings/panels/permissions/__tests__/judge-test-support";
import { ProviderProfileScopedSection } from "@/components/settings/panels/provider-profile-scoped-section";
import { TooltipProvider } from "@/components/ui/tooltip";
import { buildEnvironmentClient } from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
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

type Offers = true | false | "absent";
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
  if (offers === "absent") return body;
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
  if (input.advertiseLink) {
    recordNegotiatedHostMethods(HOST_ID, ["providers.list", "providers.link"]);
  }
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(
    hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      HOST_ID,
      "providers.list",
      { native: null },
    ),
    body,
  );
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
  });

  it.each([false, "absent"] as const)(
    "keeps today's Sign in on a signed-out terminal row when offersSignIns is %s",
    async (offers) => {
      renderSection({
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
    },
  );

  it("says Available on this computer, with no Link, when the fact is true", async () => {
    renderSection({
      offers: true,
      row: rowProfile({ kind: "managed", signedOut: false, presence: null }),
      signedOut: false,
      onHostOnly: true,
      advertiseLink: true,
    });
    const line = await screen.findByTestId(LINE_TESTID);
    expect(line.textContent).toContain(AVAILABLE_HERE);
    expect(within(line).queryByRole("button", { name: "Link" })).toBeNull();
    expect(screen.queryByText(ON_THIS_HOST)).toBeNull();
  });

  it.each([false, "absent"] as const)(
    "keeps today's on-this-host line and Link when offersSignIns is %s",
    async (offers) => {
      renderSection({
        offers,
        row: rowProfile({ kind: "managed", signedOut: false, presence: null }),
        signedOut: false,
        onHostOnly: true,
        advertiseLink: true,
      });
      const line = await screen.findByTestId(LINE_TESTID);
      expect(line.textContent).toContain(ON_THIS_HOST);
      expect(within(line).getByRole("button", { name: "Link" })).toBeTruthy();
      expect(screen.queryByText(AVAILABLE_HERE)).toBeNull();
    },
  );

  it("says Not on this computer yet when the fact is true and the profile has no home", async () => {
    renderSection({
      offers: true,
      row: rowProfile({
        kind: "managed",
        signedOut: false,
        presence: { kind: "no-home" },
      }),
      signedOut: false,
      onHostOnly: false,
      advertiseLink: false,
    });
    expect(await screen.findByText(NOT_ON_COMPUTER)).toBeTruthy();
    expect(screen.queryByText(NOT_ON_DEVICE)).toBeNull();
  });

  it.each([false, "absent"] as const)(
    "keeps today's Not on this device yet when offersSignIns is %s",
    async (offers) => {
      renderSection({
        offers,
        row: rowProfile({
          kind: "managed",
          signedOut: false,
          presence: { kind: "no-home" },
        }),
        signedOut: false,
        onHostOnly: false,
        advertiseLink: false,
      });
      expect(await screen.findByText(NOT_ON_DEVICE)).toBeTruthy();
      expect(screen.queryByText(NOT_ON_COMPUTER)).toBeNull();
    },
  );

  it("has no Link account or Link control when the fact is true", async () => {
    const harness = renderSection({
      offers: true,
      row: rowProfile({ kind: "ambient", signedOut: true, presence: null }),
      signedOut: true,
      onHostOnly: true,
      advertiseLink: true,
    });
    await screen.findByRole("button", { name: SIGN_IN_EVERYWHERE });
    expect(screen.getByRole("button", { name: "Add a profile" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Link account" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Link" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Link account" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Link" })).toBeNull();
    expect(harness.startLogins()).toBe(0);
  });
});
