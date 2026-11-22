import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { resetNegotiatedManifests } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type {
  ProviderProfile,
  ProviderProfileAccentColor,
} from "@traycer/protocol/host/provider-schemas";
import { legacyProfile } from "@/components/providers/__tests__/profile-pin-fixtures";
import {
  createProfileRecordAuthFixture,
  type ProfileRecordAuthFixture,
} from "@/components/providers/__tests__/profile-record-auth-fixture";
import {
  managedProfileForTest,
  mountProfileEditDialog,
} from "@/components/providers/__tests__/profile-pin-edit-dialog-test-fixture";
import type { ProfileListHost } from "@/components/providers/__tests__/profile-pin-host-fixture";
import type { AuthService } from "@/lib/auth/auth-service";
import type { HostRpcRegistry } from "@/lib/host";
import { useAuthStore } from "@/stores/auth/auth-store";
import { readinessFor } from "@/components/providers/__tests__/profile-pin-host-fixture";

const AUTH = vi.hoisted(() => ({ service: null as AuthService | null }));

const holder = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
  hostId: null as string | null,
}));

const ENVIRONMENT_ID = "environment-profile-fixture";
const ITEMS_READ_URL = `http://localhost:5005/api/v3/environments/${ENVIRONMENT_ID}/items?kind=managed_profile`;
const ITEMS_WRITE_URL = `http://localhost:5005/api/v3/environments/${ENVIRONMENT_ID}/items/managed_profile`;
const OLD_COLOR = "#a855f7";
const NEW_COLOR = "#f97316";
const RECORD_VALUE = {
  name: "Work",
  enabled: true,
  color: OLD_COLOR,
  settings: { retained: "value" },
};

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

vi.mock("@/hooks/providers/use-refresh-providers", () => ({
  useRefreshProviders: () => () => Promise.resolve(),
}));

async function signedInAuthService(input: {
  readonly writeStatus: number;
  readonly onWriteAccepted: () => void;
}): Promise<ProfileRecordAuthFixture> {
  const fixture = await createProfileRecordAuthFixture((request) => {
    if (request.method === "GET" && request.url === ITEMS_READ_URL) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            items: [
              {
                kind: "managed_profile",
                key: "opencode:work-row",
                value: RECORD_VALUE,
                revision: 23,
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    }
    if (request.method === "PUT" && request.url === ITEMS_WRITE_URL) {
      if (input.writeStatus >= 200 && input.writeStatus < 300) {
        input.onWriteAccepted();
      }
      return Promise.resolve(
        input.writeStatus === 204
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify({ error: "private response detail" }), {
              status: input.writeStatus,
              headers: { "Content-Type": "application/json" },
            }),
      );
    }
    return Promise.resolve(new Response(null, { status: 500 }));
  });
  AUTH.service = fixture.service;
  return fixture;
}

function recordProfile(): ProviderProfile {
  return {
    ...managedProfileForTest({
      profileId: "work-row",
      label: "Work",
      otherNames: [],
    }),
    accentColor: OLD_COLOR,
  };
}

function setListedAccentColor(
  host: ProfileListHost,
  color: ProviderProfileAccentColor,
): void {
  host.answer.providers = host.answer.providers.map((provider) =>
    provider.providerId !== "opencode"
      ? provider
      : {
          ...provider,
          profiles: provider.profiles.map((profile) =>
            profile.profileId === "work-row"
              ? { ...profile, accentColor: color }
              : profile,
          ),
        },
  );
}

function pickerSwatchStyle(): string | null {
  const picker = screen.getByRole("button", {
    name: "OpenCode profile: Work",
    hidden: true,
  });
  return (
    picker
      .querySelector('[aria-hidden="true"][style]')
      ?.getAttribute("style") ?? null
  );
}

function requestJson(
  request: ProfileRecordAuthFixture["requests"][number] | undefined,
): unknown {
  if (request === undefined || typeof request.body !== "string") {
    throw new Error("expected a JSON request body");
  }
  return JSON.parse(request.body);
}

function bindHost(client: HostClient<HostRpcRegistry>, hostId: string): void {
  holder.client = client;
  holder.hostId = hostId;
}

afterEach(() => {
  AUTH.service?.dispose();
  AUTH.service = null;
  useAuthStore.getState().setSignedOut();
  holder.client = null;
  holder.hostId = null;
  resetNegotiatedManifests();
  cleanup();
  vi.unstubAllGlobals();
});

describe("ProfileEditDialog colour", () => {
  it("writes a record colour through the app and shows the refreshed list", async () => {
    let host: ProfileListHost | null = null;
    const auth = await signedInAuthService({
      writeStatus: 204,
      onWriteAccepted: () => {
        if (host === null) {
          throw new Error("expected the computer fixture");
        }
        setListedAccentColor(host, NEW_COLOR);
      },
    });
    const profile = recordProfile();
    host = mountProfileEditDialog({
      profiles: [profile],
      profile,
      methods: [
        "providers.list",
        "providers.answerProfileName",
        "providers.setEnabled",
      ],
      offersSignIns: false,
      answerProfileName: (request) => ({ label: request.label }),
      bindHost,
    });
    await screen.findByText(ENVIRONMENT_ID);
    await screen.findByRole("button", { name: `Use color ${NEW_COLOR}` });
    fireEvent.click(
      screen.getByRole("button", { name: `Use color ${NEW_COLOR}` }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(auth.requests).toHaveLength(2));
    expect(auth.requests.map(({ url, method }) => ({ url, method }))).toEqual([
      { url: ITEMS_READ_URL, method: "GET" },
      { url: ITEMS_WRITE_URL, method: "PUT" },
    ]);
    expect(requestJson(auth.requests[1])).toEqual({
      key: "opencode:work-row",
      os: null,
      value: { ...RECORD_VALUE, color: NEW_COLOR },
      revision: 23,
      upload: null,
    });
    expect(host.rpcCalls.map((call) => call.method)).not.toContain(
      "providers.setEnabled",
    );
    expect(host.rpcCalls.map((call) => call.method)).not.toContain(
      "providers.answerProfileName",
    );
    await waitFor(() => expect(host.listCalls.length).toBeGreaterThan(1));
    await waitFor(() =>
      expect(pickerSwatchStyle()).toBe(`--swatch: ${NEW_COLOR};`),
    );
  });

  it("keeps a local row on the computer call", async () => {
    const auth = await signedInAuthService({
      writeStatus: 204,
      onWriteAccepted: () => undefined,
    });
    const profile: ProviderProfile = {
      ...legacyProfile({
        profileId: "work-row",
        label: "Work",
        kind: "managed",
        enabled: true,
        authStatus: "authenticated",
      }),
      accentColor: OLD_COLOR,
    };
    const host = mountProfileEditDialog({
      profiles: [profile],
      profile,
      methods: ["providers.list", "providers.setEnabled"],
      offersSignIns: undefined,
      answerProfileName: (request) => ({ label: request.label }),
      bindHost,
    });
    await screen.findByRole("button", { name: `Use color ${NEW_COLOR}` });
    fireEvent.click(
      screen.getByRole("button", { name: `Use color ${NEW_COLOR}` }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(host.setEnabledCalls).toHaveLength(1));
    expect(host.setEnabledCalls[0]?.profileAction).toEqual({
      type: "recolor",
      profileId: "work-row",
      accentColor: NEW_COLOR,
      environmentProfileId: null,
    });
    await waitFor(() => expect(host.listCalls.length).toBeGreaterThan(1));
    await waitFor(() =>
      expect(pickerSwatchStyle()).toBe(`--swatch: ${NEW_COLOR};`),
    );
    expect(auth.requests).toEqual([]);
    expect(host.rpcCalls.map((call) => call.method)).not.toContain(
      "environment.status",
    );
    expect(host.rpcCalls.map((call) => call.method)).not.toContain(
      "environment.host.read",
    );
  });

  it("shows the existing refusal after one record write and refresh", async () => {
    const auth = await signedInAuthService({
      writeStatus: 403,
      onWriteAccepted: () => undefined,
    });
    const profile = recordProfile();
    const host = mountProfileEditDialog({
      profiles: [profile],
      profile,
      methods: [
        "providers.list",
        "providers.answerProfileName",
        "providers.setEnabled",
      ],
      offersSignIns: undefined,
      answerProfileName: (request) => ({ label: request.label }),
      bindHost,
    });
    await screen.findByText(ENVIRONMENT_ID);
    fireEvent.click(
      screen.getByRole("button", { name: `Use color ${NEW_COLOR}` }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText("You don't have permission to do that."),
    ).toBeTruthy();
    await waitFor(() => expect(auth.requests).toHaveLength(2));
    expect(auth.requests.map(({ url, method }) => ({ url, method }))).toEqual([
      { url: ITEMS_READ_URL, method: "GET" },
      { url: ITEMS_WRITE_URL, method: "PUT" },
    ]);
    expect(screen.queryByText("private response detail")).toBeNull();
    expect(screen.queryByText("Couldn't recolor profile.")).toBeNull();
    await waitFor(() => expect(host.listCalls.length).toBeGreaterThan(1));
    expect(pickerSwatchStyle()).toBe(`--swatch: ${OLD_COLOR};`);
    expect(host.rpcCalls.map((call) => call.method)).not.toContain(
      "providers.setEnabled",
    );
  });
});
