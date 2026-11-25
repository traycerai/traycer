import type { EnvironmentDirectoryResult } from "@traycer-clients/shared/host-client/environment-directory";

type HostBindingFixture = {
  readonly hostClient: unknown;
  readonly auth: {
    readonly environmentCloud: () => EnvironmentCloud;
    readonly listEnvironments: () => Promise<EnvironmentDirectoryResult>;
  };
};

const scopeOverrides = vi.hoisted(
  (): {
    current: Record<string, unknown>;
    byHost: Map<string, Record<string, unknown>>;
  } => ({ current: {}, byHost: new Map() }),
);
vi.mock("@/components/settings/host-scope/use-host-scope", async () => {
  const { useContext } = await import("react");
  const { PersonalPageContext } =
    await import("@/components/settings/personal/personal-page-context");
  const { hostScopeFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  const useHostScope = () => {
    const page = useContext(PersonalPageContext);
    const scope =
      page === null
        ? scopeOverrides.current
        : (scopeOverrides.byHost.get(page.hostId ?? "") ??
          scopeOverrides.current);
    return hostScopeFixture(scope);
  };
  return {
    useHostScope,
    useHostScopeFor: useHostScope,
    WINDOW_HOST_SELECTION: {
      scopedHostId: null,
      setScopedHostId: () => undefined,
    },
    usePersonalHostScope: useHostScope,
  };
});

const hostBindingMock = vi.hoisted(
  (): {
    current: HostBindingFixture | null;
    byHost: Map<string, HostBindingFixture>;
  } => ({ current: null, byHost: new Map() }),
);
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  const { useContext } = await import("react");
  const { PersonalPageContext } =
    await import("@/components/settings/personal/personal-page-context");
  const useBinding = () => {
    const page = useContext(PersonalPageContext);
    return page === null
      ? hostBindingMock.current
      : (hostBindingMock.byHost.get(page.hostId ?? "") ??
          hostBindingMock.current);
  };
  return {
    ...actual,
    useHostBinding: useBinding,
    useHostClient: () => useBinding()?.hostClient,
  };
});

const hostCredentialRefusal = vi.hoisted(() => ({
  current: null as string | null,
}));
vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => hostCredentialRefusal.current,
}));

import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configEnvDeleteRequestSchema,
  configEnvDeleteResponseSchema,
  configEnvListRequestSchema,
  configEnvListResponseSchema,
} from "@traycer/protocol/host/config/index";
import {
  configEnvLocalOverrideClearRequestSchema,
  configEnvLocalOverrideResponseSchema,
  environmentLocalOverridesRequestSchema,
  environmentLocalOverridesResponseSchema,
  type LocalOverride,
} from "@traycer/protocol/host/environment-schemas";
import { environmentProposalsV12 } from "@traycer/protocol/host/environment/settings-proposals";
import {
  authnItemsResponseSchema,
  type AuthnItemRow,
} from "@traycer-clients/shared/environment/authn-environment-schemas";
import {
  environmentPath,
  type EnvironmentCloud,
} from "@traycer-clients/shared/environment/environment-cloud";
import { readConfigurationItems } from "@traycer-clients/shared/environment/configuration-settings";
import { hostScopeOptionFixture } from "@/components/settings/host-scope/host-scope-fixture";
import {
  PersonalPageContext,
  type PersonalPageContextValue,
} from "@/components/settings/personal/personal-page-context";
import { ShellSettingsPanel } from "@/components/settings/panels/shell-settings-panel";
import {
  CONFIG_SHELL_METHODS,
  buildConfigHostFixture,
  type ConfigHostFixture,
} from "@/components/settings/panels/__tests__/host-config-rpc-test-support";
import { useEnvironmentLocalOverridesRead } from "@/hooks/environment/use-environment-reads";
import { createSettingsSaveCoordinator } from "@/lib/environment/settings-save-coordinator";
import { queryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type { MockHandlerMap } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { SettingsSaveCoordinatorContext } from "@/providers/settings-save-coordinator-context";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import type {
  QueryClient as QueryClientType,
  QueryKey,
} from "@tanstack/react-query";
import { PERSONAL_PICK } from "@/lib/settings-environment-pages";
import { mutationsSettled } from "./kept-variable-actions-support";

const ACCOUNT = "00000000-0000-4000-8000-000000000291";
const PERSONAL_ENVIRONMENT = "00000000-0000-4000-8000-000000000292";
const HOST_X = "00000000-0000-4000-8000-000000000293";
const HOST_Y = "00000000-0000-4000-8000-000000000294";
const KEY = "ROW29_SHARED_VALUE";
const PERSONAL_VALUE = "personal-value";
const X_OWN_VALUE = "kept-on-x";

interface ShellRun extends ConfigHostFixture {
  readonly container: HTMLElement;
  readonly queryClient: QueryClientType;
  readonly unmountPanel: () => void;
}

interface RowObservation {
  readonly ready: Promise<void>;
  readonly stop: () => void;
}

function observeRowChange(
  container: HTMLElement,
  predicate: () => boolean,
): RowObservation {
  let observer: MutationObserver | null = null;
  const ready = new Promise<void>((resolve) => {
    const check = (): void => {
      if (!predicate()) return;
      observer?.disconnect();
      resolve();
    };
    observer = new MutationObserver(check);
    observer.observe(container, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    check();
  });
  return { ready, stop: () => observer?.disconnect() };
}

function inputValue(element: HTMLElement): string {
  if (!(element instanceof HTMLInputElement)) {
    throw new Error("expected an input");
  }
  return element.value;
}

function removeActionEnabled(container: HTMLElement): boolean {
  const button = within(container).queryByRole("button", {
    name: "Remove " + KEY,
  });
  return button instanceof HTMLButtonElement && !button.disabled;
}

function variablePayloadText(value: unknown): string | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("value" in value)
  ) {
    return null;
  }
  return typeof value.value === "string" ? value.value : null;
}

function localVariableOverride(key: string, value: string): LocalOverride {
  return {
    target: { kind: "variable", key },
    os: "macos",
    value,
    setAt: 1,
  };
}

function ShellPanelWithLiveLocalOverrides(props: {
  readonly page: PersonalPageContextValue;
}) {
  const { page } = props;
  const { data } = useEnvironmentLocalOverridesRead(
    page.client,
    page.hostId,
    true,
  );
  return (
    <PersonalPageContext.Provider
      value={{ ...page, localOverrides: data?.overrides ?? [] }}
    >
      <ShellSettingsPanel />
    </PersonalPageContext.Provider>
  );
}

function makePersonalRow(key: string, value: string): AuthnItemRow {
  return {
    kind: "variable",
    key,
    os: "any",
    value: { value },
    revision: 3,
    updatedAt: 3,
    writtenBy: { source: "live", hostId: null, hostName: null },
  };
}

function hostListKey(hostId: string): QueryKey {
  return queryKeys.hostMethod(hostId, "config.env.list", {});
}

function hostLocalOverridesKey(hostId: string): QueryKey {
  return queryKeys.hostMethod(hostId, "environment.localOverrides", {});
}

function queryUpdatedSuccessfullyBeyond(
  client: QueryClientType,
  queryKey: QueryKey,
  after: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let unsubscribe = (): void => undefined;
    const check = (): void => {
      const query = client.getQueryCache().find({ queryKey, exact: true });
      if (query === undefined || query.state.fetchStatus !== "idle") return;
      if (query.state.dataUpdateCount <= after && query.state.error === null)
        return;
      unsubscribe();
      resolve(
        query.state.dataUpdateCount > after && query.state.error === null,
      );
    };
    unsubscribe = client.getQueryCache().subscribe(check);
    check();
  });
}

afterEach(() => {
  cleanup();
  resetNegotiatedManifests();
  scopeOverrides.current = {};
  scopeOverrides.byHost.clear();
  hostBindingMock.current = null;
  hostBindingMock.byHost.clear();
  hostCredentialRefusal.current = null;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("a kept Shell variable on two computers", () => {
  it("clears X's Keep to Personal while Y and Personal stay unchanged", async () => {
    const personalDirectory: EnvironmentDirectoryResult = {
      kind: "ok",
      list: {
        environments: [
          {
            environmentId: PERSONAL_ENVIRONMENT,
            ownerKind: "user",
            ownerId: ACCOUNT,
            roomId: "room-row29-personal",
            label: "Personal",
          },
        ],
      },
    };
    const personalRows = new Map<string, AuthnItemRow>([
      [KEY, makePersonalRow(KEY, PERSONAL_VALUE)],
    ]);
    let sharedCloudWrites = 0;
    const cloud: EnvironmentCloud = {
      authnBaseUrl: "https://authn.test/",
      bearer: { kind: "cloud", getBearerToken: () => "fixture-bearer" },
      onOriginSignIn: () => true,
      transport: (request) => {
        try {
          return Promise.resolve(
            (() => {
              const url = new URL(request.url);
              const environment = "/" + environmentPath(PERSONAL_ENVIRONMENT);
              if (
                request.method === "GET" &&
                url.pathname === environment + "/items"
              ) {
                const kind = url.searchParams.get("kind");
                const body = authnItemsResponseSchema.parse({
                  items: [...personalRows.values()].filter(
                    (row) => row.kind === kind,
                  ),
                });
                return { status: 200, text: JSON.stringify(body) };
              }
              if (
                url.pathname.startsWith(environment + "/items") &&
                request.method === "DELETE"
              ) {
                sharedCloudWrites += 1;
                return { status: 204, text: "" };
              }
              if (
                url.pathname.startsWith(environment + "/items") &&
                request.method !== "GET"
              ) {
                sharedCloudWrites += 1;
                throw new Error("unexpected shared item write");
              }
              throw new Error("unexpected Personal settings route");
            })(),
          );
        } catch (error) {
          return Promise.reject(
            error instanceof Error
              ? error
              : new Error("Personal settings transport failed"),
          );
        }
      },
    };
    const valuesByHost = new Map<string, Map<string, string>>([
      [HOST_X, new Map([[KEY, PERSONAL_VALUE]])],
      [HOST_Y, new Map([[KEY, PERSONAL_VALUE]])],
    ]);
    const overridesByHost = new Map<string, LocalOverride[]>([
      [HOST_X, [localVariableOverride(KEY, X_OWN_VALUE)]],
      [HOST_Y, []],
    ]);
    let clearCount = 0;
    const clearTarget = { matchesExpectedRequest: false };
    let sharedDeleteCount = 0;
    const handlersFor = (hostId: string): MockHandlerMap<HostRpcRegistry> => ({
      "environment.localOverrides": (request) => {
        environmentLocalOverridesRequestSchema.parse(request);
        return environmentLocalOverridesResponseSchema.parse({
          overrides: overridesByHost.get(hostId) ?? [],
        });
      },
      "environment.proposals": (request) => {
        environmentProposalsV12.requestSchema.parse(request);
        return environmentProposalsV12.responseSchema.parse({ proposals: [] });
      },
      "config.env.list": (request) => {
        configEnvListRequestSchema.parse(request);
        const values = valuesByHost.get(hostId);
        if (values === undefined) throw new Error("missing host values");
        return configEnvListResponseSchema.parse({
          entries: [...values.entries()].map(([key, value]) => ({
            key,
            value,
          })),
        });
      },
      "config.env.delete": (request) => {
        const parsed = configEnvDeleteRequestSchema.parse(request);
        sharedDeleteCount += 1;
        personalRows.delete(parsed.key);
        for (const values of valuesByHost.values()) values.delete(parsed.key);
        return configEnvDeleteResponseSchema.parse({
          key: parsed.key,
          deleted: true,
        });
      },
      "config.env.localOverride.clear": (request) => {
        const parsed = configEnvLocalOverrideClearRequestSchema.parse(request);
        clearCount += 1;
        clearTarget.matchesExpectedRequest =
          hostId === HOST_X &&
          parsed.target.kind === "variable" &&
          parsed.target.key === KEY;
        overridesByHost.set(hostId, []);
        const values = valuesByHost.get(hostId);
        if (values === undefined) throw new Error("missing host values");
        const personal = personalRows.get(KEY);
        const personalValue =
          personal?.kind === "variable"
            ? variablePayloadText(personal.value)
            : null;
        if (personalValue === null) values.delete(KEY);
        else values.set(KEY, personalValue);
        return configEnvLocalOverrideResponseSchema.parse({
          outcome: "saved",
          overrides: [],
        });
      },
    });

    useAuthStore.getState().setSignedIn(
      {
        userId: ACCOUNT,
        userName: "Row 29",
        email: "row29@example.test",
      },
      { userId: ACCOUNT, username: "row29" },
      [],
    );
    const fixtureByHost = new Map<string, ConfigHostFixture>();
    const coordinator = createSettingsSaveCoordinator({
      accountId: () => ACCOUNT,
      cloud: () => cloud,
      readProposals: async (hostId) => {
        const fixture = fixtureByHost.get(hostId);
        if (fixture === undefined) return null;
        const request = environmentProposalsV12.requestSchema.parse({});
        const response = await fixture.client.request(
          "environment.proposals",
          request,
        );
        return environmentProposalsV12.responseSchema.parse(response);
      },
      now: () => 10,
      schedule: () => () => undefined,
    });
    const runnerHost: IRunnerHost = new MockRunnerHost({
      signInUrl: "https://example.invalid/signin",
      authnBaseUrl: "https://example.invalid",
      localHost: null,
      hosts: [],
      workspaceFolderPickerPaths: undefined,
      hasLocalHost: undefined,
      traycerCli: undefined,
    });
    const renderHost = (hostId: string, hostName: string): ShellRun => {
      const fixture = buildConfigHostFixture({
        hostId,
        isLocalMachine: true,
        cli: new MockTraycerCli(),
        overrideHandlers: handlersFor(hostId),
      });
      fixtureByHost.set(hostId, fixture);
      recordNegotiatedHostMethods(hostId, [
        ...CONFIG_SHELL_METHODS,
        "environment.localOverrides",
        "environment.proposals",
        "config.env.localOverride.clear",
      ]);
      const scope = {
        host: hostScopeOptionFixture({ hostId, name: hostName }),
        hostId,
        status: "ready",
        client: fixture.client,
      };
      const binding: HostBindingFixture = {
        hostClient: fixture.client,
        auth: {
          environmentCloud: () => cloud,
          listEnvironments: () => Promise.resolve(personalDirectory),
        },
      };
      scopeOverrides.current = scope;
      scopeOverrides.byHost.set(hostId, scope);
      hostBindingMock.current = binding;
      hostBindingMock.byHost.set(hostId, binding);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const page: PersonalPageContextValue = {
        section: "shell",
        pick: PERSONAL_PICK,
        state: { kind: "unknown" },
        hostName,
        localOverrides: [],
        hostId,
        client: fixture.client,
        notices: [],
        review: [],
      };
      const rendered = render(
        <QueryClientProvider client={queryClient}>
          <SettingsSaveCoordinatorContext.Provider value={coordinator}>
            <RunnerHostProvider runnerHost={runnerHost}>
              <ShellPanelWithLiveLocalOverrides page={page} />
            </RunnerHostProvider>
          </SettingsSaveCoordinatorContext.Provider>
        </QueryClientProvider>,
      );
      return {
        ...fixture,
        container: rendered.container,
        queryClient,
        unmountPanel: () => rendered.unmount(),
      };
    };

    const x = renderHost(HOST_X, "Computer X");
    const y = renderHost(HOST_Y, "Computer Y");

    let xInitialRow: RowObservation | null = null;
    let yInitialField: RowObservation | null = null;
    let xPlainRowCommitted: RowObservation | null = null;
    try {
      const xListKey = hostListKey(HOST_X);
      const xOverridesKey = hostLocalOverridesKey(HOST_X);
      const yListKey = hostListKey(HOST_Y);
      xInitialRow = observeRowChange(
        x.container,
        () =>
          within(x.container).queryByTestId("env-row-own-value") !== null &&
          removeActionEnabled(x.container),
      );
      await xInitialRow.ready;
      yInitialField = observeRowChange(
        y.container,
        () => within(y.container).queryByLabelText("Value for " + KEY) !== null,
      );
      await yInitialField.ready;
      const xFieldBefore = within(x.container).getByLabelText(
        "Value for " + KEY,
      );
      const yFieldBefore = within(y.container).getByLabelText(
        "Value for " + KEY,
      );
      expect(inputValue(xFieldBefore) === PERSONAL_VALUE).toBe(true);
      expect(inputValue(yFieldBefore) === PERSONAL_VALUE).toBe(true);
      const xKeptNote = within(x.container).getByTestId("env-row-own-value");
      const xKeptNoteMatches =
        xKeptNote.textContent ===
        `Computer X uses: ${X_OWN_VALUE} · Use everywhere`;
      expect(xKeptNoteMatches).toBe(true);

      const xListAfterClear = queryUpdatedSuccessfullyBeyond(
        x.queryClient,
        xListKey,
        x.queryClient.getQueryState(xListKey)?.dataUpdateCount ?? 0,
      );
      const xOverridesAfterClear = queryUpdatedSuccessfullyBeyond(
        x.queryClient,
        xOverridesKey,
        x.queryClient.getQueryState(xOverridesKey)?.dataUpdateCount ?? 0,
      );
      xPlainRowCommitted = observeRowChange(
        x.container,
        () =>
          within(x.container).queryByTestId("env-row-own-value") === null &&
          within(x.container).queryByLabelText("Value for " + KEY) !== null &&
          removeActionEnabled(x.container),
      );
      const yListAfterXClear = queryUpdatedSuccessfullyBeyond(
        y.queryClient,
        yListKey,
        y.queryClient.getQueryState(yListKey)?.dataUpdateCount ?? 0,
      );
      const deleteSettled = mutationsSettled(x.queryClient);
      fireEvent.click(
        within(x.container).getByRole("button", {
          name: "Remove " + KEY,
        }),
      );
      await deleteSettled;
      const clearUsedForX =
        clearCount === 1 && clearTarget.matchesExpectedRequest;
      expect(clearUsedForX).toBe(true);
      const [xListUpdated, xOverridesUpdated] = await Promise.all([
        xListAfterClear,
        xOverridesAfterClear,
      ]);
      expect(xListUpdated).toBe(true);
      expect(xOverridesUpdated).toBe(true);
      await xPlainRowCommitted.ready;
      const yRefresh = y.queryClient.invalidateQueries({
        queryKey: yListKey,
      });
      const [yListUpdated] = await Promise.all([yListAfterXClear, yRefresh]);
      expect(yListUpdated).toBe(true);

      const xRowIsPlain =
        within(x.container).queryByTestId("env-row-own-value") === null &&
        removeActionEnabled(x.container);
      expect(xRowIsPlain).toBe(true);
      const xShowsPersonalValue =
        inputValue(within(x.container).getByLabelText("Value for " + KEY)) ===
        PERSONAL_VALUE;
      expect(xShowsPersonalValue).toBe(true);
      const yStillShowsItsValue =
        inputValue(within(y.container).getByLabelText("Value for " + KEY)) ===
        PERSONAL_VALUE;
      expect(yStillShowsItsValue).toBe(true);
      const xSettledList = configEnvListResponseSchema.parse(
        x.queryClient.getQueryData(xListKey),
      );
      const xReadPersonalValue = xSettledList.entries.some(
        (entry) => entry.key === KEY && entry.value === PERSONAL_VALUE,
      );
      expect(xReadPersonalValue).toBe(true);
      const ySettledList = configEnvListResponseSchema.parse(
        y.queryClient.getQueryData(yListKey),
      );
      const yReadUnchangedValue = ySettledList.entries.some(
        (entry) => entry.key === KEY && entry.value === PERSONAL_VALUE,
      );
      expect(yReadUnchangedValue).toBe(true);

      const personalAfter = await readConfigurationItems(
        cloud,
        PERSONAL_ENVIRONMENT,
      );
      const personalStillHasValue = personalAfter.items.some(
        (item) =>
          item.kind === "variable" &&
          item.key === KEY &&
          variablePayloadText(item.value) === PERSONAL_VALUE,
      );
      expect(personalStillHasValue).toBe(true);
      const onlyXClearAndNoSharedDelete =
        clearCount === 1 &&
        clearTarget.matchesExpectedRequest &&
        sharedDeleteCount === 0 &&
        sharedCloudWrites === 0;
      expect(onlyXClearAndNoSharedDelete).toBe(true);
    } finally {
      coordinator.stop();
      xInitialRow?.stop();
      yInitialField?.stop();
      xPlainRowCommitted?.stop();
      x.unmountPanel();
      y.unmountPanel();
    }
  });
});
