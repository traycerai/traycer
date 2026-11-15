import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import type { HostRpcRegistry } from "@/lib/host";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProfileEditDialog } from "@/components/settings/panels/provider-profile-edit-dialog";
import { apiKeyState } from "@/components/settings/panels/__tests__/provider-api-key-section-fixture";
import { teamProviderProfile } from "@/components/settings/environment/__tests__/team-providers-test-support";
import {
  captureConsoleOutput,
  captureMutationObservers,
  containsSyntheticInput,
  createSecretRetentionHarness,
  hasExactObjectKeys,
  mutationStateContainsSyntheticInput,
  restoreConsoleCaptures,
  restoreMutationCacheObservers,
  type MutationObserverReference,
  type SecretRetentionHarness,
} from "@/hooks/providers/__tests__/secret-retention-test-support";

const FAKE_KEY = "synthetic-profile-api-key";
const UNAVAILABLE = "Profile key input is unavailable.";
const active = vi.hoisted(() => ({
  client: null as HostClient<HostRpcRegistry> | null,
  readers: new Array<() => unknown>(),
  hostRequestContainsKey: false,
  hostRequestHasKeyField: false,
  hostRequestScopeMatches: false,
  hostRequestShapeMatches: false,
}));
const profileHooks = vi.hoisted(() => ({
  mutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/lib/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host")>();
  return {
    ...actual,
    useHostClient: (): HostClient<HostRpcRegistry> => {
      if (active.client === null)
        throw new Error("Profile API key test client is unavailable");
      return active.client;
    },
  };
});
vi.mock("@/hooks/use-submitted-secret-input", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/use-submitted-secret-input")>();
  return {
    ...actual,
    useSubmittedSecretInput: <Value,>(message: string) => {
      const input = actual.useSubmittedSecretInput<Value>(message);
      active.readers.push(input.read);
      return input;
    },
  };
});
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: () => true,
}));
vi.mock("@/hooks/host/use-host-credential-refusal", () => ({
  useHostCredentialRefusal: () => null,
}));
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({ data: undefined }),
}));
vi.mock("@/hooks/providers/use-remove-provider-profile-mutation", () => ({
  useRemoveProviderProfile: () => profileHooks.mutation(),
}));
vi.mock("@/hooks/providers/use-profile-record-person-action-mutation", () => ({
  useProfileRecordPersonAction: () => profileHooks.mutation(),
}));
vi.mock("@/hooks/providers/use-name-profile-record-mutation", () => ({
  useNameProfileRecordForClient: () => profileHooks.mutation(),
}));
vi.mock("@/hooks/providers/use-rename-provider-profile-mutation", () => ({
  useRenameProviderProfile: () => profileHooks.mutation(),
}));
vi.mock("@/hooks/providers/use-account-profile-recolor", () => ({
  useAccountProfileRecolorForClient: () => profileHooks.mutation(),
}));
vi.mock("@/hooks/providers/use-sign-out-provider-profile-mutation", () => ({
  useSignOutProviderProfile: () => profileHooks.mutation(),
}));
vi.mock("@/hooks/providers/use-providers-answer-profile-name-mutation", () => ({
  useProvidersAnswerProfileNameForClient: () => profileHooks.mutation(),
}));
vi.mock("@/hooks/providers/use-refresh-providers", () => ({
  useRefreshProviders: () => () => Promise.resolve(),
}));
vi.mock("@/components/settings/environment/team-pick-label", () => ({
  usePickedTeamLabel: () => null,
}));
vi.mock("@/components/settings/panels/provider-profile-reauth-panel", () => ({
  ProviderProfileReauthPanel: (props: {
    readonly onCancel: () => void;
  }): ReactNode => (
    <button type="button" onClick={props.onCancel}>
      Back
    </button>
  ),
}));
vi.mock("@/lib/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics")>();
  return {
    ...actual,
    Analytics: {
      getInstance: () => ({
        track: vi.fn(),
        identify: vi.fn(),
        reset: vi.fn(),
      }),
    },
  };
});

interface Row {
  readonly action: "set" | "clear";
  readonly fail: boolean;
  readonly configured: boolean;
}

const rows: readonly Row[] = [
  { action: "set", fail: false, configured: false },
  { action: "set", fail: true, configured: false },
  { action: "clear", fail: false, configured: true },
  { action: "clear", fail: true, configured: true },
];

const harnesses: SecretRetentionHarness[] = [];
const queryClients: QueryClient[] = [];

function rowProfile(configured: boolean): ProviderProfile {
  return {
    ...teamProviderProfile({
      profileId: "profile-secret-retention",
      label: "Retention profile",
      authStatus: "authenticated",
      personNotice: null,
      apiKeyConfigured: configured,
    }),
    apiKey: { supported: true as const, configured },
  };
}

function renderDialog(queryClient: QueryClient, profile: ProviderProfile) {
  const state = {
    ...apiKeyState("opencode"),
    apiKey: { supported: false, configured: false, source: null },
    profiles: [profile],
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ProfileEditDialog
          state={state}
          profile={profile}
          profiles={[profile]}
          canOauth
          oauthUnavailableHint={null}
          startInReauth={false}
          isLocalHost
          open
          onOpenChange={() => undefined}
          remainingProfilesAfterRemoval={[]}
          onSelectedProfileIdChange={() => undefined}
          profileEnablementAvailable
          profileEnablementPending={() => false}
          onSetProfileEnabled={() => undefined}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function operationMethod(action: Row["action"]): string {
  return action === "set"
    ? "providers.setProfileApiKey"
    : "providers.clearProfileApiKey";
}

function mutationFor(queryClient: QueryClient, action: Row["action"]) {
  return queryClient
    .getMutationCache()
    .getAll()
    .find(
      (mutation) =>
        mutation.options.mutationKey?.[0] === operationMethod(action),
    );
}

function readAfterSettle(reader: (() => unknown) | undefined): boolean {
  if (reader === undefined) return false;
  try {
    reader();
    return false;
  } catch (error) {
    return error instanceof Error && error.message === UNAVAILABLE;
  }
}

afterEach(() => {
  cleanup();
  active.client = null;
  active.readers.length = 0;
  active.hostRequestContainsKey = false;
  active.hostRequestHasKeyField = false;
  active.hostRequestScopeMatches = false;
  active.hostRequestShapeMatches = false;
  restoreConsoleCaptures();
  restoreMutationCacheObservers();
  for (const queryClient of queryClients.splice(0)) queryClient.clear();
  for (const harness of harnesses.splice(0)) harness.client.dispose();
});

for (const row of rows) {
  it(`keeps the profile key out of mutation state and restores the draft after ${row.action} settles ${row.fail ? "with refusal" : "successfully"}`, async () => {
    const consoleCapture = captureConsoleOutput();
    const deferred = { complete: null as (() => void) | null };
    const queryClientHarness = createSecretRetentionHarness({
      "providers.setProfileApiKey": (params) => {
        active.hostRequestContainsKey = params.apiKey === FAKE_KEY;
        active.hostRequestHasKeyField = Object.hasOwn(params, "apiKey");
        active.hostRequestScopeMatches =
          params.providerId === "opencode" &&
          params.profileId === "profile-secret-retention";
        active.hostRequestShapeMatches = hasExactObjectKeys(params, [
          "providerId",
          "profileId",
          "apiKey",
        ]);
        return new Promise((resolve, reject) => {
          deferred.complete = () => {
            if (row.fail) {
              reject(new Error("Safe profile key refusal"));
              return;
            }
            resolve({
              profileId: params.profileId,
              apiKey: { supported: true, configured: true },
            });
          };
        });
      },
      "providers.clearProfileApiKey": (params) => {
        active.hostRequestContainsKey = false;
        active.hostRequestHasKeyField = Object.hasOwn(params, "apiKey");
        active.hostRequestScopeMatches =
          params.providerId === "opencode" &&
          params.profileId === "profile-secret-retention";
        active.hostRequestShapeMatches = hasExactObjectKeys(params, [
          "providerId",
          "profileId",
        ]);
        return new Promise((resolve, reject) => {
          deferred.complete = () => {
            if (row.fail) {
              reject(new Error("Safe profile key refusal"));
              return;
            }
            resolve({
              profileId: params.profileId,
              apiKey: { supported: true, configured: false },
            });
          };
        });
      },
    });
    harnesses.push(queryClientHarness);
    queryClients.push(queryClientHarness.queryClient);
    active.client =
      queryClientHarness.client.createRequester(mockLocalHostEntry);
    const observers: MutationObserverReference[] = [];
    captureMutationObservers(queryClientHarness.queryClient, observers);
    const { unmount } = renderDialog(
      queryClientHarness.queryClient,
      rowProfile(row.configured),
    );

    const keyField = screen.getByLabelText<HTMLInputElement>("API key");
    fireEvent.change(keyField, { target: { value: FAKE_KEY } });
    let buttonName = "Remove key";
    if (row.action === "set") {
      buttonName = row.configured ? "Replace key" : "Add key";
    }
    fireEvent.click(screen.getByRole("button", { name: buttonName }));
    await waitFor(() =>
      expect(
        queryClientHarness.messenger.calls.some(
          (call) => call.method === operationMethod(row.action),
        ),
      ).toBe(true),
    );
    const submittedReader = active.readers.at(0);
    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    expect(screen.queryByLabelText("API key")).toBeNull();

    const observedMutation = mutationFor(
      queryClientHarness.queryClient,
      row.action,
    );
    if (observedMutation === undefined)
      throw new Error("Profile API key mutation was not retained");
    const mutationFn = observedMutation.options.mutationFn;
    if (mutationFn === undefined)
      throw new Error("Profile API key mutation has no function");
    act(() => {
      const complete = deferred.complete;
      if (complete === null)
        throw new Error("Profile API key response was not prepared");
      complete();
    });
    await waitFor(() =>
      expect(observedMutation.state.status).toBe(
        row.fail ? "error" : "success",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    const recoveredField =
      await screen.findByLabelText<HTMLInputElement>("API key");
    const draftWasRecovered =
      recoveredField.value === (row.fail ? FAKE_KEY : "");
    expect(draftWasRecovered).toBe(true);
    const helperUnavailable =
      row.action === "set" ? readAfterSettle(submittedReader) : false;

    let replayUnavailable = false;
    let replayContainsKey = false;
    if (row.action === "set") {
      const requestCountBeforeReplayValue =
        queryClientHarness.messenger.calls.filter(
          (call) => call.method === operationMethod(row.action),
        ).length;
      try {
        await mutationFn(
          {
            providerId: "opencode",
            profileId: "profile-secret-retention",
          },
          {
            client: queryClientHarness.queryClient,
            meta: observedMutation.options.meta,
            mutationKey: observedMutation.options.mutationKey ?? [],
          },
        );
      } catch (error) {
        replayUnavailable =
          error instanceof Error && error.message === UNAVAILABLE;
        replayContainsKey = containsSyntheticInput(error, [FAKE_KEY]);
      }
      const replaySentNoRequest =
        queryClientHarness.messenger.calls.filter(
          (call) => call.method === operationMethod(row.action),
        ).length === requestCountBeforeReplayValue;
      const preUnmountStateContainsKey = mutationStateContainsSyntheticInput(
        queryClientHarness.queryClient,
        observers,
        [FAKE_KEY],
      );
      unmount();
      expect({
        requestContainsKey: active.hostRequestContainsKey,
        requestHasSecretField: active.hostRequestHasKeyField,
        requestScopeMatches: active.hostRequestScopeMatches,
        requestShapeMatches: active.hostRequestShapeMatches,
        variablesContainOnlyIdentifiers: hasExactObjectKeys(
          observedMutation.state.variables,
          ["providerId", "profileId"],
        ),
        retainedStateContainsKey: preUnmountStateContainsKey,
        logsContainKey: containsSyntheticInput(consoleCapture.output, [
          FAKE_KEY,
        ]),
        helperUnavailable,
        replayUnavailable,
        replayContainsKey,
        replaySentNoRequest,
        postUnmountStateContainsKey: mutationStateContainsSyntheticInput(
          queryClientHarness.queryClient,
          observers,
          [FAKE_KEY],
        ),
      }).toEqual({
        requestContainsKey: true,
        requestHasSecretField: true,
        requestScopeMatches: true,
        requestShapeMatches: true,
        variablesContainOnlyIdentifiers: true,
        retainedStateContainsKey: false,
        logsContainKey: false,
        helperUnavailable: true,
        replayUnavailable: true,
        replayContainsKey: false,
        replaySentNoRequest: true,
        postUnmountStateContainsKey: false,
      });
      return;
    }

    const preUnmountStateContainsKey = mutationStateContainsSyntheticInput(
      queryClientHarness.queryClient,
      observers,
      [FAKE_KEY],
    );
    unmount();
    expect({
      requestContainsKey: active.hostRequestContainsKey,
      requestHasSecretField: active.hostRequestHasKeyField,
      requestScopeMatches: active.hostRequestScopeMatches,
      requestShapeMatches: active.hostRequestShapeMatches,
      variablesContainOnlyIdentifiers: hasExactObjectKeys(
        observedMutation.state.variables,
        ["providerId", "profileId"],
      ),
      retainedStateContainsKey: preUnmountStateContainsKey,
      logsContainKey: containsSyntheticInput(consoleCapture.output, [FAKE_KEY]),
      postUnmountStateContainsKey: mutationStateContainsSyntheticInput(
        queryClientHarness.queryClient,
        observers,
        [FAKE_KEY],
      ),
    }).toEqual({
      requestContainsKey: false,
      requestHasSecretField: false,
      requestScopeMatches: true,
      requestShapeMatches: true,
      variablesContainOnlyIdentifiers: true,
      retainedStateContainsKey: false,
      logsContainKey: false,
      postUnmountStateContainsKey: false,
    });
  });
}
