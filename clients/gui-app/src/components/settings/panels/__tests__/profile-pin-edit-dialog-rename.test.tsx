import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  readinessFor,
  type ProfileListHost,
} from "@/components/providers/__tests__/profile-pin-host-fixture";
import { legacyProfile } from "@/components/providers/__tests__/profile-pin-fixtures";
import type { HostRpcRegistry } from "@/lib/host";
import type { AuthService } from "@/lib/auth/auth-service";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  createProfileRecordAuthFixture,
  type ProfileRecordAuthFixture,
} from "@/components/providers/__tests__/profile-record-auth-fixture";
import {
  managedProfileForTest,
  mountProfileEditDialog,
} from "@/components/providers/__tests__/profile-pin-edit-dialog-test-fixture";

const AUTH = vi.hoisted(() => ({ service: null as AuthService | null }));

const holder = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
  hostId: null as string | null,
}));

vi.mock("@/components/ui/dropdown-menu", async () =>
  (
    await import("@/components/providers/__tests__/profile-dropdown-menu-mock")
  ).profileDropdownMenuMock(),
);

vi.mock("@/hooks/rate-limits/use-profile-usage-presentation", () => ({
  useProfileUsagePresentation: () => null,
}));

vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: () => holder.client,
    useAuthService: () => AUTH.service,
  };
});

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => holder.client,
  useHostDirectoryEntryForHostId: () => null,
}));

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: (client: object | null) => readinessFor(client),
}));

vi.mock(
  "@/components/settings/personal/personal-page-context",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/settings/personal/personal-page-context")
      >();
    return {
      ...actual,
      usePersonalPageHost: () => ({
        hostId: holder.hostId,
        client: holder.client,
      }),
    };
  },
);

vi.mock("@/hooks/providers/use-remove-provider-profile-mutation", () => ({
  useRemoveProviderProfile: () => ({
    mutate: () => undefined,
    isPending: false,
    error: null,
  }),
}));

vi.mock("@/hooks/providers/use-recolor-provider-profile-mutation", () => ({
  useRecolorProviderProfile: () => ({
    mutate: () => undefined,
    isPending: false,
    error: null,
  }),
}));

vi.mock("@/hooks/providers/use-refresh-providers", () => ({
  useRefreshProviders: () => () => Promise.resolve(),
}));

const PROFILE_RECORD_URL =
  "http://localhost:5005/api/v3/environments/environment-profile-fixture/profile-records/work-row/name";

const recordNameTransport = {
  onNameAccepted: (_name: string): void => undefined,
};

async function signedInAuthService(
  denied: boolean,
): Promise<ProfileRecordAuthFixture> {
  const fixture = await createProfileRecordAuthFixture((request) => {
    if (!denied && request.url === PROFILE_RECORD_URL) {
      recordNameTransport.onNameAccepted("Desk");
    }
    return Promise.resolve(
      new Response(
        JSON.stringify(
          denied
            ? {
                statusCode: 403,
                error: "private response detail",
                code: "environment_action_forbidden",
              }
            : {
                profileId: "work-row",
                harnessId: "opencode",
                recordRevision: "18",
                name: "Desk",
              },
        ),
        {
          status: denied ? 403 : 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
  });
  AUTH.service = fixture.service;
  return fixture;
}

function mount(input: {
  readonly profiles: readonly ProviderProfile[];
  readonly profile: ProviderProfile;
  readonly methods: readonly string[];
  readonly offersSignIns: boolean | undefined;
}): ProfileListHost {
  return mountProfileEditDialog({
    profiles: input.profiles,
    profile: input.profile,
    methods: input.methods,
    offersSignIns: input.offersSignIns,
    answerProfileName: (request) => ({ label: request.label }),
    bindHost: (client, hostId) => {
      holder.client = client;
      holder.hostId = hostId;
    },
  });
}

function nameField(): HTMLInputElement {
  const field = screen.getByRole("textbox", { name: "Profile name" });
  if (!(field instanceof HTMLInputElement)) {
    throw new Error("expected the profile name field");
  }
  return field;
}

const side = managedProfileForTest({
  profileId: "side-row",
  label: "Side",
  otherNames: [],
});

describe("ProfileEditDialog rename", () => {
  afterEach(() => {
    AUTH.service?.dispose();
    AUTH.service = null;
    useAuthStore.getState().setSignedOut();
    holder.client = null;
    holder.hostId = null;
    recordNameTransport.onNameAccepted = () => undefined;
    resetNegotiatedManifests();
    cleanup();
    vi.unstubAllGlobals();
  });

  it("a record with empty aliases uses the app name route when sign-in offers are absent", async () => {
    const auth = await signedInAuthService(false);
    const named = managedProfileForTest({
      profileId: "work-row",
      label: "Work",
      otherNames: [],
    });
    const host = mount({
      profiles: [side, named],
      profile: named,
      methods: [
        "providers.list",
        "providers.answerProfileName",
        "providers.setEnabled",
      ],
      offersSignIns: undefined,
    });
    recordNameTransport.onNameAccepted = (name) => {
      host.answer.providers = host.answer.providers.map((provider) =>
        provider.providerId !== "opencode"
          ? provider
          : {
              ...provider,
              profiles: provider.profiles.map((profile) =>
                profile.profileId === "work-row"
                  ? { ...profile, label: name, otherNames: [] }
                  : profile,
              ),
            },
      );
    };
    await screen.findByText("environment-profile-fixture");
    await screen.findByRole("textbox", { name: "Profile name" });
    fireEvent.change(nameField(), { target: { value: "Desk" } });
    fireEvent.click(
      screen.getByRole<HTMLButtonElement>("button", { name: "Save changes" }),
    );
    await waitFor(() => {
      expect(auth.requests).toEqual([
        {
          url: PROFILE_RECORD_URL,
          method: "POST",
          body: JSON.stringify({ harnessId: "opencode", name: "Desk" }),
        },
      ]);
    });
    expect(host.rpcCalls.map((call) => call.method)).not.toContain(
      "providers.answerProfileName",
    );
    expect(host.rpcCalls.map((call) => call.method)).not.toContain(
      "providers.setEnabled",
    );
    await waitFor(() => expect(host.listCalls.length).toBeGreaterThan(1));
    await waitFor(() => {
      expect(
        screen
          .getByRole("button", {
            name: /^OpenCode profile: /,
            hidden: true,
          })
          .getAttribute("aria-label"),
      ).toBe("OpenCode profile: Desk");
    });
  });

  it("a record with other names also uses the app name route", async () => {
    const auth = await signedInAuthService(false);
    const named = managedProfileForTest({
      profileId: "work-row",
      label: "Work",
      otherNames: ["Home"],
    });
    const host = mount({
      profiles: [side, named],
      profile: named,
      methods: ["providers.list", "providers.answerProfileName"],
      offersSignIns: false,
    });
    recordNameTransport.onNameAccepted = (name) => {
      host.answer.providers = host.answer.providers.map((provider) =>
        provider.providerId !== "opencode"
          ? provider
          : {
              ...provider,
              profiles: provider.profiles.map((profile) =>
                profile.profileId === "work-row"
                  ? { ...profile, label: name, otherNames: [] }
                  : profile,
              ),
            },
      );
    };
    await screen.findByText("Home");
    fireEvent.change(nameField(), { target: { value: "Desk" } });
    fireEvent.click(
      screen.getByRole<HTMLButtonElement>("button", { name: "Save changes" }),
    );
    await waitFor(() => {
      expect(auth.requests).toEqual([
        {
          url: PROFILE_RECORD_URL,
          method: "POST",
          body: JSON.stringify({ harnessId: "opencode", name: "Desk" }),
        },
      ]);
    });
    expect(host.rpcCalls.map((call) => call.method)).not.toContain(
      "providers.answerProfileName",
    );
    expect(host.rpcCalls.map((call) => call.method)).not.toContain(
      "providers.setEnabled",
    );
    await waitFor(() => expect(host.listCalls.length).toBeGreaterThan(1));
    await waitFor(() => {
      expect(
        screen
          .getByRole("button", {
            name: /^OpenCode profile: /,
            hidden: true,
          })
          .getAttribute("aria-label"),
      ).toBe("OpenCode profile: Desk");
    });
    expect(screen.queryByText("Also named Home")).toBeNull();
    expect(screen.queryByText("Home")).toBeNull();
  });

  it("a local row keeps its computer rename call", async () => {
    const auth = await signedInAuthService(false);
    const local = legacyProfile({
      profileId: "work-row",
      label: "Work",
      kind: "managed",
      enabled: true,
      authStatus: "authenticated",
    });
    const host = mount({
      profiles: [side, local],
      profile: local,
      methods: ["providers.list"],
      offersSignIns: undefined,
    });
    await screen.findByRole("textbox", { name: "Profile name" });
    fireEvent.change(nameField(), { target: { value: "Desk" } });
    fireEvent.click(
      screen.getByRole<HTMLButtonElement>("button", { name: "Save changes" }),
    );
    await waitFor(() => {
      expect(host.setEnabledCalls).toHaveLength(1);
    });
    expect(host.setEnabledCalls[0]?.profileAction).toEqual({
      type: "rename",
      profileId: "work-row",
      label: "Desk",
    });
    await waitFor(() => {
      expect(
        screen
          .getByRole("button", {
            name: /^OpenCode profile: /,
            hidden: true,
          })
          .getAttribute("aria-label"),
      ).toBe("OpenCode profile: Desk");
    });
    expect(auth.requests).toEqual([]);
  });

  it("a local row without answerProfileName keeps the rename fallback", async () => {
    const auth = await signedInAuthService(false);
    const local = {
      ...legacyProfile({
        profileId: "work-row",
        label: "Work",
        kind: "managed",
        enabled: true,
        authStatus: "authenticated",
      }),
      otherNames: ["Home"],
    };
    const host = mount({
      profiles: [side, local],
      profile: local,
      methods: ["providers.list"],
      offersSignIns: undefined,
    });
    await screen.findByText("Home");
    fireEvent.change(nameField(), { target: { value: "Desk" } });
    fireEvent.click(
      screen.getByRole<HTMLButtonElement>("button", { name: "Save changes" }),
    );
    await waitFor(() => {
      expect(host.setEnabledCalls).toHaveLength(1);
    });
    expect(host.setEnabledCalls[0]?.profileAction).toEqual({
      type: "rename",
      profileId: "work-row",
      label: "Desk",
    });
    expect(auth.requests).toEqual([]);
  });

  it("shows the existing refusal sentence without exposing the server error", async () => {
    const auth = await signedInAuthService(true);
    const named = managedProfileForTest({
      profileId: "work-row",
      label: "Work",
      otherNames: [],
    });
    const host = mount({
      profiles: [side, named],
      profile: named,
      methods: [
        "providers.list",
        "providers.answerProfileName",
        "providers.setEnabled",
      ],
      offersSignIns: undefined,
    });
    await screen.findByText("environment-profile-fixture");
    await screen.findByRole("textbox", { name: "Profile name" });
    fireEvent.change(nameField(), { target: { value: "Desk" } });
    fireEvent.click(
      screen.getByRole<HTMLButtonElement>("button", { name: "Save changes" }),
    );
    await screen.findByText("You don't have permission to do that.");
    expect(screen.queryByText("private response detail")).toBeNull();
    expect(host.rpcCalls.map((call) => call.method)).not.toContain(
      "providers.setEnabled",
    );
    expect(host.rpcCalls.map((call) => call.method)).not.toContain(
      "providers.answerProfileName",
    );
    expect(auth.requests).toEqual([
      {
        url: PROFILE_RECORD_URL,
        method: "POST",
        body: JSON.stringify({ harnessId: "opencode", name: "Desk" }),
      },
    ]);
    expect(host.listCalls.length).toBeGreaterThan(1);
  });
});
