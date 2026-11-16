import "../../../../../__tests__/test-browser-apis";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  isProviderKeyProviderId,
  type ProviderKeyProviderId,
} from "@traycer-clients/shared/host-client/provider-api-key-change";
import {
  ConfigurationSourceContext,
  type ConfigurationSource,
} from "@/components/settings/environment/configuration-source";
import { TeamProviders } from "@/components/settings/environment/team-providers";
import {
  configurationItem,
  personalPoolSource,
  poolSource,
} from "@/components/settings/environment/__tests__/team-configuration-test-support";
import {
  authnSecretRowFixture,
  createOwnEnvironmentAuthRuntime,
  DIRECTORY_URL,
  installOwnEnvironmentTransport,
  jsonResponse,
  signInOwnEnvironment,
  signInOwnEnvironmentAs,
  type OwnEnvironmentAuthRuntime,
  type OwnEnvironmentTransport,
  type OwnEnvironmentTransportRequest,
} from "@/hooks/environment/__tests__/own-environment-authn-test-support";
import { HostRuntimeContext } from "@/lib/host/runtime";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useAuthStore } from "@/stores/auth/auth-store";
import { RunnerHostProvider } from "@/providers/runner-host-provider";

const PERSONAL_ENVIRONMENT = "env-personal";
const SECOND_PERSONAL_ENVIRONMENT = "env-personal-user-2";
const TEAM_ENVIRONMENT = "env-team";
const TEST_KEY = "cursor-private-test-key";
type PoolConfigurationSource = Extract<
  ConfigurationSource,
  { readonly kind: "pool" }
>;

interface ProviderKeyWireRow {
  readonly profileId: string;
  readonly providerId: ProviderKeyProviderId;
  readonly state: "live" | "removed";
  readonly signInNumber: string;
  readonly recordRevision: string;
  readonly personIntentNumber: string;
  readonly removedAt: number | null;
}

interface TransportFixtureState {
  readonly keysByEnvironment: Map<string, readonly ProviderKeyWireRow[]>;
  readonly itemsByEnvironment: Map<string, readonly unknown[]>;
  readonly connectionsByEnvironment: Map<string, readonly unknown[]>;
  readonly disabledProfileRecords: Set<string>;
  readonly failedProfileRecords: Set<string>;
  readonly profileReads: OwnEnvironmentTransportRequest[];
  readonly writes: OwnEnvironmentTransportRequest[];
  holdNextSet: boolean;
  releasePendingSet: (() => void) | null;
}

interface ProviderPageHarness {
  readonly runtime: OwnEnvironmentAuthRuntime;
  readonly binding: OwnEnvironmentAuthRuntime["binding"];
  readonly queryClient: QueryClient;
  readonly transport: OwnEnvironmentTransport;
  readonly state: TransportFixtureState;
  readonly source: { current: ConfigurationSource };
  readonly wrapper: (props: { readonly children?: ReactNode }) => ReactNode;
  dispose: () => void;
}

let activeHarness: ProviderPageHarness | null = null;

function keyWireRow(
  environmentId: string,
  providerId: ProviderKeyProviderId,
  state: ProviderKeyWireRow["state"],
  revision: number,
): ProviderKeyWireRow {
  return {
    profileId: "profile-" + environmentId + "-" + providerId,
    providerId,
    state,
    signInNumber: "1",
    recordRevision: String(revision),
    personIntentNumber: "1",
    removedAt: state === "removed" ? revision : null,
  };
}

function keyWriteResponse(row: ProviderKeyWireRow): object {
  return {
    profileId: row.profileId,
    providerId: row.providerId,
    state: row.state,
    signInNumber: row.signInNumber,
    recordRevision: row.recordRevision,
    personIntentNumber: row.personIntentNumber,
  };
}

function profileRecordsResponse(
  rows: readonly ProviderKeyWireRow[],
): object {
  return {
    enabled: true,
    environmentRevision: "0",
    records: [],
    removed: [],
    aliases: [],
    providerKeys: rows,
  };
}

function noHostSource(environmentId: string): PoolConfigurationSource {
  const source = personalPoolSource();
  if (source.kind !== "pool") {
    throw new Error("Personal settings require a pool source");
  }
  return {
    ...source,
    environmentId,
    transportReadOnly: false,
  };
}

function teamSource(
  environmentId: string,
  role: "admin" | "editor" | "viewer" | null,
): PoolConfigurationSource {
  const source = poolSource(role ?? "viewer");
  if (source.kind !== "pool") {
    throw new Error("Team settings require a pool source");
  }
  return {
    ...source,
    environmentId,
    effectiveRole: role,
  };
}

function routeRequest(
  request: OwnEnvironmentTransportRequest,
  state: TransportFixtureState,
): Response | Promise<Response> | undefined {
  if (request.url.toString() === DIRECTORY_URL) {
    return jsonResponse(200, { environments: [] });
  }

  const match =
    /^\/api\/v3\/environments\/([^/]+)\/(.+)$/u.exec(request.url.pathname);
  const environmentId = match?.[1];
  const route = match?.[2];
  if (environmentId === undefined || route === undefined) return undefined;

  if (route === "profile-records" && request.method === "GET") {
    state.profileReads.push(request);
    if (state.failedProfileRecords.has(environmentId)) {
      return jsonResponse(503, {});
    }
    if (state.disabledProfileRecords.has(environmentId)) {
      return jsonResponse(200, { enabled: false });
    }
    return jsonResponse(
      200,
      profileRecordsResponse(state.keysByEnvironment.get(environmentId) ?? []),
    );
  }

  if (
    route.startsWith("provider-keys/") &&
    (request.method === "PUT" || request.method === "DELETE")
  ) {
    state.writes.push(request);
    const providerId = route.slice("provider-keys/".length);
    if (!isProviderKeyProviderId(providerId)) return jsonResponse(404, {});
    const revision = state.writes.length;
    const next = keyWireRow(
      environmentId,
      providerId,
      request.method === "PUT" ? "live" : "removed",
      revision,
    );
    if (request.method === "PUT" && state.holdNextSet) {
      state.holdNextSet = false;
      const pending = Promise.withResolvers<Response>();
      state.releasePendingSet = () => {
        state.keysByEnvironment.set(environmentId, [next]);
        pending.resolve(jsonResponse(200, keyWriteResponse(next)));
        state.releasePendingSet = null;
      };
      return pending.promise;
    }
    state.keysByEnvironment.set(environmentId, [next]);
    return jsonResponse(200, keyWriteResponse(next));
  }

  if (request.method !== "GET") return undefined;
  if (route === "hosts") return jsonResponse(200, { hosts: [] });
  if (route === "items") {
    return jsonResponse(200, {
      items: state.itemsByEnvironment.get(environmentId) ?? [],
    });
  }
  if (route === "revision") return jsonResponse(200, { revision: 0 });
  if (route === "secrets/harness-connections") {
    return jsonResponse(200, {
      connections: state.connectionsByEnvironment.get(environmentId) ?? [],
    });
  }
  if (route === "secrets") {
    return jsonResponse(200, {
      secrets: [
        authnSecretRowFixture({
          id: "legacy-cursor-key",
          name: "CURSOR_API_KEY",
          kind: "provider",
        }),
      ],
      removed: [],
    });
  }
  return undefined;
}

function createHarness(source: ConfigurationSource): ProviderPageHarness {
  useAuthStore.setState({ status: "signed-out" });
  useSelectionAuthorityStore.getState().reset();

  const runtime = createOwnEnvironmentAuthRuntime();
  const binding = { ...runtime.binding, hostId: null };
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  const state: TransportFixtureState = {
    keysByEnvironment: new Map(),
    itemsByEnvironment: new Map(),
    connectionsByEnvironment: new Map(),
    disabledProfileRecords: new Set(),
    failedProfileRecords: new Set(),
    profileReads: [],
    writes: [],
    holdNextSet: false,
    releasePendingSet: null,
  };
  const sourceState = { current: source };
  const transport = installOwnEnvironmentTransport(
    (request) => routeRequest(request, state),
    { environments: [] },
  );

  const wrapper = (props: { readonly children?: ReactNode }) => (
    <RunnerHostProvider runnerHost={runtime.runnerHost}>
      <QueryClientProvider client={queryClient}>
        <HostRuntimeContext.Provider value={binding}>
          <ConfigurationSourceContext.Provider value={sourceState.current}>
            {props.children}
          </ConfigurationSourceContext.Provider>
        </HostRuntimeContext.Provider>
      </QueryClientProvider>
    </RunnerHostProvider>
  );

  const harness: ProviderPageHarness = {
    runtime,
    binding,
    queryClient,
    transport,
    state,
    source: sourceState,
    wrapper,
    dispose: () => {
      transport.restore();
      queryClient.clear();
      runtime.dispose();
    },
  };
  activeHarness = harness;
  return harness;
}

async function renderPage(
  harness: ProviderPageHarness,
): Promise<ReturnType<typeof render>> {
  await signInOwnEnvironment(harness.runtime);
  return render(<TeamProviders />, { wrapper: harness.wrapper });
}

async function selectProvider(name: "Cursor" | "OpenRouter"): Promise<void> {
  const rail = await screen.findByRole("navigation", { name: "Providers" });
  await userEvent.click(
    within(rail).getByRole("button", { name: new RegExp(name) }),
  );
}

function profileReadsFor(
  harness: ProviderPageHarness,
  environmentId: string,
): readonly OwnEnvironmentTransportRequest[] {
  return harness.state.profileReads.filter(
    (request) =>
      request.url.pathname ===
      "/api/v3/environments/" + environmentId + "/profile-records",
  );
}

function hasSuccessfulEnvironmentRead(
  harness: ProviderPageHarness,
  method: string,
): boolean {
  return harness.queryClient
    .getQueryCache()
    .getAll()
    .some(
      (query) =>
        query.queryKey.includes(method) && query.state.status === "success",
    );
}

afterEach(() => {
  cleanup();
  activeHarness?.dispose();
  activeHarness = null;
  useAuthStore.setState({ status: "signed-out", shareableTeams: [] });
  useSelectionAuthorityStore.getState().reset();
});

describe("TeamProviders cloud API keys", () => {
  it("saves, reads back, and clears a Personal provider key", async () => {
    const harness = createHarness(noHostSource(PERSONAL_ENVIRONMENT));
    const view = await renderPage(harness);
    expect(harness.binding.hostId).toBeNull();
    expect(harness.binding.hostClient.getActiveHostId()).toBeNull();

    await selectProvider("Cursor");
    const input = await screen.findByLabelText("API key");
    expect(input.getAttribute("type")).toBe("password");
    expect(screen.getByText("Not set")).toBeTruthy();
    await waitFor(() => {
      expect(
        hasSuccessfulEnvironmentRead(harness, "environment.secrets.list"),
      ).toBe(true);
    });
    const rail = screen.getByRole("navigation", { name: "Providers" });
    expect(
      within(rail).getByRole("button", { name: /Cursor/ }).textContent,
    ).not.toContain("key");
    await userEvent.type(input, TEST_KEY);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Key set")).toBeTruthy();
    await waitFor(() => {
      expect(harness.state.writes).toHaveLength(1);
      expect(
        profileReadsFor(harness, PERSONAL_ENVIRONMENT).length,
      ).toBeGreaterThan(1);
    });
    expect(harness.state.writes[0]?.url.pathname).toBe(
      "/api/v3/environments/" + PERSONAL_ENVIRONMENT + "/provider-keys/cursor",
    );
    expect(harness.state.writes[0]?.method).toBe("PUT");
    expect(harness.state.writes[0]?.body).toBe(
      JSON.stringify({ key: TEST_KEY, onlyIfAbsent: false }),
    );
    expect(harness.state.writes[0]?.headers.get("authorization")).toBe(
      "Bearer user-1-token",
    );
    expect(
      profileReadsFor(harness, PERSONAL_ENVIRONMENT)[0]?.headers.get(
        "authorization",
      ),
    ).toBe("Bearer user-1-token");
    await waitFor(() => expect(input).toHaveProperty("value", ""));
    expect(
      within(rail).getByRole("button", { name: /Cursor/ }).textContent,
    ).toContain("key");

    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(await screen.findByText("Not set")).toBeTruthy();
    await waitFor(() => {
      expect(harness.state.writes).toHaveLength(2);
      expect(
        profileReadsFor(harness, PERSONAL_ENVIRONMENT).length,
      ).toBeGreaterThan(2);
      expect(
        harness.queryClient
          .getMutationCache()
          .getAll()
          .every((mutation) => mutation.state.status !== "pending"),
      ).toBe(true);
    });
    expect(harness.state.writes.map((request) => request.method)).toEqual([
      "PUT",
      "DELETE",
    ]);
    expect(harness.state.writes[1]?.body).toBeNull();
    expect(harness.state.writes[1]?.headers.get("authorization")).toBe(
      "Bearer user-1-token",
    );
    expect(
      within(rail).getByRole("button", { name: /Cursor/ }).textContent,
    ).not.toContain("key");
    expect(
      harness.queryClient
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.variables),
    ).toEqual([{ action: "set" }, { action: "clear" }]);
    expect(
      JSON.stringify(
        harness.queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain(TEST_KEY);
    view.unmount();
  });

  it("keeps B's draft when A's save settles late", async () => {
    const harness = createHarness(noHostSource(PERSONAL_ENVIRONMENT));
    harness.state.holdNextSet = true;
    const view = await renderPage(harness);
    expect(harness.binding.hostId).toBeNull();
    expect(harness.binding.hostClient.getActiveHostId()).toBeNull();

    await selectProvider("Cursor");
    await userEvent.type(await screen.findByLabelText("API key"), TEST_KEY);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(harness.state.releasePendingSet).not.toBeNull());

    const variables = harness.queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state.variables);
    expect(variables).toEqual([{ action: "set" }]);
    expect(JSON.stringify(variables)).not.toContain(TEST_KEY);
    expect(harness.state.writes[0]?.url.pathname).toBe(
      "/api/v3/environments/" + PERSONAL_ENVIRONMENT + "/provider-keys/cursor",
    );
    expect(harness.state.writes[0]?.body).toBe(
      JSON.stringify({ key: TEST_KEY, onlyIfAbsent: false }),
    );
    const saveWhilePending = screen.getByRole("button", { name: "Save" });
    expect(saveWhilePending.getAttribute("disabled")).not.toBeNull();
    await userEvent.click(saveWhilePending);
    expect(harness.state.writes).toHaveLength(1);

    const rail = screen.getByRole("navigation", { name: "Providers" });
    await userEvent.click(
      within(rail).getByRole("button", { name: /OpenRouter/ }),
    );
    expect(
      within(rail)
        .getByRole("button", { name: /OpenRouter/ })
        .getAttribute("aria-current"),
    ).toBe("true");

    await act(async () => {
      await harness.runtime.auth.signOut();
      useAuthStore.setState({ status: "signed-out" });
    });
    const previousEnvironmentReads = profileReadsFor(
      harness,
      PERSONAL_ENVIRONMENT,
    ).length;
    harness.source.current = noHostSource(SECOND_PERSONAL_ENVIRONMENT);
    await signInOwnEnvironmentAs(
      harness.runtime,
      "user-2",
      "user-2-token",
    );
    view.rerender(<TeamProviders />);

    await selectProvider("Cursor");
    const nextInput = await screen.findByLabelText("API key");
    await userEvent.type(nextInput, "user-two-unsent-draft");
    expect(nextInput).toHaveProperty("value", "user-two-unsent-draft");

    const release = harness.state.releasePendingSet;
    if (release === null) throw new Error("the Personal save was not held");
    await act(async () => {
      release();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        harness.queryClient
          .getMutationCache()
          .getAll()
          .every((mutation) => mutation.state.status !== "pending"),
      ).toBe(true);
      expect(nextInput).toHaveProperty("value", "user-two-unsent-draft");
    });
    expect(profileReadsFor(harness, PERSONAL_ENVIRONMENT)).toHaveLength(
      previousEnvironmentReads,
    );
    await waitFor(() => {
      expect(
        profileReadsFor(harness, SECOND_PERSONAL_ENVIRONMENT).length,
      ).toBeGreaterThan(0);
    });
    expect(
      profileReadsFor(harness, SECOND_PERSONAL_ENVIRONMENT)[0]?.headers.get(
        "authorization",
      ),
    ).toBe("Bearer user-2-token");
    expect(harness.state.writes).toHaveLength(1);
    expect(harness.state.writes[0]?.url.pathname).toBe(
      "/api/v3/environments/" + PERSONAL_ENVIRONMENT + "/provider-keys/cursor",
    );
    expect(harness.state.writes[0]?.headers.get("authorization")).toBe(
      "Bearer user-1-token",
    );
    expect(await screen.findByText("Not set")).toBeTruthy();
  });

  it("allows the existing Editor role to set a team key", async () => {
    const harness = createHarness(teamSource(TEAM_ENVIRONMENT, "editor"));
    await renderPage(harness);
    expect(harness.binding.hostId).toBeNull();
    expect(harness.binding.hostClient.getActiveHostId()).toBeNull();

    await selectProvider("Cursor");
    await userEvent.type(await screen.findByLabelText("API key"), TEST_KEY);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Key set")).toBeTruthy();
    expect(harness.state.writes).toHaveLength(1);
    expect(harness.state.writes[0]?.url.pathname).toBe(
      "/api/v3/environments/" + TEAM_ENVIRONMENT + "/provider-keys/cursor",
    );
  });

  it("preserves legacy standing with disabled profile records", async () => {
    const environmentId = "env-profile-records-disabled";
    const harness = createHarness(teamSource(environmentId, "editor"));
    harness.state.disabledProfileRecords.add(environmentId);
    await renderPage(harness);

    await selectProvider("Cursor");
    await waitFor(() => {
      expect(
        within(
          screen.getByRole("navigation", { name: "Providers" }),
        ).getByRole("button", { name: /Cursor/ }).textContent,
      ).toContain("key");
    });
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(profileReadsFor(harness, environmentId).length).toBeGreaterThan(0);
    expect(harness.state.writes).toEqual([]);
  });

  it("keeps legacy keys out of the rail when reads fail", async () => {
    const environmentId = "env-profile-records-unreadable";
    const harness = createHarness(teamSource(environmentId, "editor"));
    harness.state.failedProfileRecords.add(environmentId);
    await renderPage(harness);

    await selectProvider("Cursor");
    expect(await screen.findByText(/Couldn't read .* keys\./u)).toBeTruthy();
    await waitFor(() => {
      expect(
        hasSuccessfulEnvironmentRead(harness, "environment.secrets.list"),
      ).toBe(true);
    });
    const rail = screen.getByRole("navigation", { name: "Providers" });
    expect(
      within(rail).getByRole("button", { name: /Cursor/ }).textContent,
    ).not.toContain("key");
    expect(harness.state.writes).toEqual([]);
  });

  it("keeps navigation live on read-only Personal settings", async () => {
    const source = {
      ...noHostSource(PERSONAL_ENVIRONMENT),
      transportReadOnly: true,
    };
    const harness = createHarness(source);
    harness.state.keysByEnvironment.set(PERSONAL_ENVIRONMENT, [
      keyWireRow(PERSONAL_ENVIRONMENT, "cursor", "live", 1),
    ]);
    await renderPage(harness);

    await selectProvider("Cursor");
    const input = await screen.findByLabelText("API key");
    const save = screen.getByRole("button", { name: "Save" });
    const clear = screen.getByRole("button", { name: "Clear" });
    expect(await screen.findByText("Key set")).toBeTruthy();
    expect(input.getAttribute("disabled")).not.toBeNull();
    expect(save.getAttribute("disabled")).not.toBeNull();
    expect(clear.getAttribute("disabled")).not.toBeNull();

    const rail = screen.getByRole("navigation", { name: "Providers" });
    const openRouter = within(rail).getByRole("button", { name: /OpenRouter/ });
    expect(openRouter.getAttribute("disabled")).toBeNull();
    await userEvent.click(openRouter);
    expect(openRouter.getAttribute("aria-current")).toBe("true");
    expect(harness.state.writes).toEqual([]);
  });

  it("fails closed for both Viewer and unknown team roles", async () => {
    const harness = createHarness(teamSource("env-viewer", "viewer"));
    harness.state.keysByEnvironment.set("env-viewer", [
      keyWireRow("env-viewer", "cursor", "live", 1),
    ]);
    const view = await renderPage(harness);

    await selectProvider("Cursor");
    let input = await screen.findByLabelText("API key");
    expect(await screen.findByText("Key set")).toBeTruthy();
    expect(input.getAttribute("disabled")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Save" }).getAttribute("disabled"),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Clear" }).getAttribute("disabled"),
    ).not.toBeNull();

    harness.source.current = teamSource("env-unknown-role", null);
    harness.state.keysByEnvironment.set("env-unknown-role", [
      keyWireRow("env-unknown-role", "cursor", "live", 2),
    ]);
    view.rerender(<TeamProviders />);
    await selectProvider("Cursor");
    input = await screen.findByLabelText("API key");
    expect(await screen.findByText("Key set")).toBeTruthy();
    expect(input.getAttribute("disabled")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Save" }).getAttribute("disabled"),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Clear" }).getAttribute("disabled"),
    ).not.toBeNull();
    expect(harness.state.writes).toEqual([]);
    view.unmount();
  });

  it.each([
    {
      configuredBy: "managed profile",
      environmentId: "env-profile-precedence",
      provider: "Cursor" as const,
      items: [
        configurationItem({
          kind: "managed_profile",
          key: "cursor:profile-1",
          value: {
            name: "Work",
            color: null,
            harnessId: "cursor",
            accountIdentity: "ada@example.com",
            needsLink: false,
            enabled: true,
          },
        }),
      ],
      connections: [],
    },
    {
      configuredBy: "linked plan",
      environmentId: "env-plan-precedence",
      provider: "OpenRouter" as const,
      items: [],
      connections: [
        {
          profileId: "plan-openrouter",
          harnessId: "openrouter",
          bindingVersion: null,
          kind: "harness",
          status: "connected",
          linkedBy: { displayName: "Ada", you: false },
        },
      ],
    },
  ])(
    "preserves $configuredBy precedence when provider-key records are empty",
    async ({ environmentId, provider, items, connections }) => {
      const harness = createHarness(teamSource(environmentId, "editor"));
      harness.state.itemsByEnvironment.set(environmentId, items);
      harness.state.connectionsByEnvironment.set(environmentId, connections);
      await renderPage(harness);

      const rail = await screen.findByRole("navigation", {
        name: "Providers",
      });
      await waitFor(() => {
        expect(
          within(rail)
            .getByRole("button", { name: new RegExp(provider) })
            .getAttribute("aria-current"),
        ).toBe("true");
      });
      expect(await screen.findByText("Not set")).toBeTruthy();
      expect(profileReadsFor(harness, environmentId).length).toBeGreaterThan(0);
      expect(harness.state.writes).toEqual([]);
      if (provider === "OpenRouter") {
        expect(
          within(rail).getByRole("button", { name: /OpenRouter/ }).textContent,
        ).toContain("plan");
      } else {
        expect(
          within(rail)
            .getByRole("button", { name: /Cursor/ })
            .getAttribute("aria-current"),
        ).toBe("true");
      }
    },
  );
});

