import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { ProfileCopyOutcome } from "@traycer/protocol/host/profile-copy-schemas";
import {
  profileCopyDraftRequestSchema,
  profileCopyRetryRequestSchema,
} from "@traycer/protocol/host/profile-copy-schemas";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import {
  profileSyncBatchSchema,
  profileSyncListSchema,
  profileSyncSaveRuleSchema,
  profileSyncStopRuleSchema,
  profileSyncSelectionSchema,
  profileSyncStartSchema,
} from "@traycer/protocol/host/profile-sync-schemas";
import type {
  ProfileSyncBatch,
  ProfileSyncItem,
  ProfileSyncRule,
  ProfileSyncSaveRule,
  ProfileSyncSelection,
} from "@traycer/protocol/host/profile-sync-schemas";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProfileCopyFlowHost } from "@/components/settings/panels/profile-copy/profile-copy-flow-host";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { clearProfileCopyObservations } from "@/hooks/providers/profile-copy/profile-copy-observations";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import { useProfileCopyOperationsStore } from "@/stores/settings/profile-copy-operations-store";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import {
  DEST_HOST_ID,
  DEST_HOST_TWO_ID,
  ATTEMPT_ID,
  ATTEMPT_TWO_ID,
  hostDirectoryEntry,
  PREVIEW_REVISION,
  profileCopyAttempt,
  profileCopyOutcome,
  recordedOutcome,
  SCOPED_HOST_ID,
  SOURCE_HOST_ID,
  SOURCE_PROFILE_ID,
} from "@/lib/profile-copy/__tests__/profile-copy-test-fixtures";
import {
  claudeProviderState,
  hostOption,
  managedProfile,
} from "../../profile-copy/__tests__/profile-copy-component-fixtures";

const harness = vi.hoisted(
  (): {
    spine: HostClient<HostRpcRegistry> | null;
    hosts: HostScopeOption[];
  } => ({
    spine: null,
    hosts: [],
  }),
);

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    if (hostId === null || harness.spine === null) return null;
    return harness.spine.createRequesterForHostId(hostId);
  },
}));

vi.mock("@/components/settings/host-scope/use-host-options", () => ({
  useHostOptions: () => ({
    hosts: harness.hosts,
    activeHostId: SCOPED_HOST_ID,
    isLoading: false,
    directoryResolved: true,
    directoryFailed: false,
    listsResolved: true,
    listsFailed: false,
    retryLists: () => undefined,
    nowMs: 0,
  }),
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openSettings: () => undefined }),
}));

const RULE_ID = "99999999-9999-4999-8999-999999999999";
const SAVED_RULE: ProfileSyncRule = {
  ruleId: RULE_ID,
  sourceHostId: SOURCE_HOST_ID,
  destinationHostId: DEST_HOST_ID,
  scope: { kind: "selected", providers: ["codex"] },
  paused: false,
  revision: 1,
  lastCheckedAt: null,
  batchId: null,
  status: "waiting",
};

function resetStores(): void {
  // reset() also forgets the account-scoped uncertain start ids.
  useProfileCopyFlowStore.getState().reset();
  useProfileCopyFlowStore.setState({
    view: null,
    session: 0,
    activeLogin: null,
    directBlocks: {},
  });
  useProfileCopyOperationsStore.setState({ handles: [] });
  useSettingsHostScopeStore.getState().setScopedHostId(null);
  clearProfileCopyObservations();
}

// Per-test knobs for the start and resolve answers; reset in beforeEach.
let startFailures = 0;
// The revision the preview answers with; a test moves it to model a re-check.
let previewRevision: string = PREVIEW_REVISION;
let startBatchSource: string | null = null;
let listFails = false;
let listBatches: readonly ProfileSyncBatch[] = [];
let previewSelection: ProfileSyncSelection | null = null;
let startBatchMutator: ((batch: ProfileSyncBatch) => ProfileSyncBatch) | null =
  null;
let listRules: readonly ProfileSyncRule[] | null = null;
let lastStarted: ProfileSyncBatch | null = null;
let updateStarted: ((batch: ProfileSyncBatch) => ProfileSyncBatch) | null =
  null;
let retryResult: "current" | "stale-revision" | "unavailable" = "current";
let retryOutcome: ProfileCopyOutcome | null = null;
let retryThrows = false;
let resolveThrows = false;
let saveRuleThrows = false;
// While set, a saveRule answer waits for it: the save stays in flight.
let saveRuleGate: Promise<void> | null = null;
// Likewise for the start and stop answers.
let startGate: Promise<void> | null = null;
let retryGate: Promise<void> | null = null;
let resolveGate: Promise<void> | null = null;
// Overrides what sync.resolve answers; otherwise it echoes the captured batch.
let resolveAnswer:
  | ((
      request: RequestOfMethod<
        HostRpcRegistry,
        "providers.profileCopy.sync.resolve"
      >,
    ) => ProfileSyncBatch)
  | null = null;
// The destination's draft: what draftStatus reads and how verify answers.
let draftStatusOutcome: ProfileCopyOutcome | null = null;
let verifyGate: Promise<void> | null = null;
let verifyResult: "current" | "stale-revision" | "unavailable" = "current";
let verifyThrows = false;
let stopRuleGate: Promise<void> | null = null;
let stopRuleThrows = false;

interface MountOptions {
  readonly rules: readonly ProfileSyncRule[];
  readonly providers: readonly ProviderCliState[];
  readonly previewItems: (
    selection: ProfileSyncSelection,
  ) => readonly ProfileSyncItem[];
  readonly startItems: (
    selection: ProfileSyncSelection,
  ) => readonly ProfileSyncItem[];
}

function defaultProviders(): readonly ProviderCliState[] {
  return [
    claudeProviderState([managedProfile(SOURCE_PROFILE_ID, "Work")]),
    {
      ...claudeProviderState([
        managedProfile("55555555-5555-4555-8555-555555555555", "Personal"),
      ]),
      providerId: "codex",
    },
  ];
}

/** A listed (not previewed) transfer: no nested preview, no outcome. */
function listedItem(destinationHostId: string): ProfileSyncItem {
  return {
    ...syncItem(1, destinationHostId, "synced", [
      previewDestination(destinationHostId, "automatic"),
    ]),
    preview: null,
  };
}

function noItems(): readonly ProfileSyncItem[] {
  return [];
}

function mount(
  rules: readonly ProfileSyncRule[],
): MockHostMessenger<HostRpcRegistry> {
  return mountWith({
    rules,
    providers: defaultProviders(),
    previewItems: noItems,
    startItems: noItems,
  });
}

function mountWith(options: MountOptions): MockHostMessenger<HostRpcRegistry> {
  const queryClient = createAppQueryClient();
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-sync",
    handlers: {
      "providers.list": () => ({
        providers: [...options.providers],
        native: null,
      }),
      "providers.profileCopy.sync.list": () => {
        if (listFails) {
          throw new HostRpcError({
            code: "RPC_ERROR",
            message: "history unavailable",
            requestId: "req-sync",
            method: "providers.profileCopy.sync.list",
            fatalDetails: null,
          });
        }
        return {
          batches: [
            ...listBatches,
            ...(lastStarted !== null && updateStarted !== null
              ? [updateStarted(lastStarted)]
              : []),
          ],
          rules: [...(listRules ?? options.rules)],
        };
      },
      "providers.profileCopy.sync.preview": (params) => ({
        selection: previewSelection ?? params,
        revision: previewRevision,
        items: [...options.previewItems(params)],
      }),
      "providers.profileCopy.sync.start": (
        params,
      ): ProfileSyncBatch | Promise<ProfileSyncBatch> => {
        if (startFailures > 0) {
          startFailures -= 1;
          // An answer lost on the wire: the host may or may not have started.
          throw new HostRpcError({
            code: "RPC_ERROR",
            message: "start unconfirmed",
            requestId: "req-sync",
            method: "providers.profileCopy.sync.start",
            fatalDetails: null,
          });
        }
        const started: ProfileSyncBatch = {
          batchId: params.batchId,
          sourceHostId: startBatchSource ?? params.selection.sourceHostId,
          createdAt: 1,
          automatic: false,
          items: [...options.startItems(params.selection)],
        };
        const answered =
          startBatchMutator === null ? started : startBatchMutator(started);
        if (startGate !== null) return startGate.then(() => answered);
        lastStarted = answered;
        return answered;
      },
      "providers.profileCopy.draftStatus": (params) => ({
        result: "current" as const,
        outcome:
          draftStatusOutcome ?? profileCopyOutcome({ attempt: params.attempt }),
      }),
      "providers.profileCopy.verify": (
        params,
      ):
        | ResponseOfMethod<HostRpcRegistry, "providers.profileCopy.verify">
        | Promise<
            ResponseOfMethod<HostRpcRegistry, "providers.profileCopy.verify">
          > => {
        const answer = () => {
          if (verifyThrows) {
            throw new HostRpcError({
              code: "RPC_ERROR",
              message: "verify unreachable",
              requestId: "req-sync",
              method: "providers.profileCopy.verify",
              fatalDetails: null,
            });
          }
          return {
            result: verifyResult,
            outcome:
              draftStatusOutcome ??
              profileCopyOutcome({ attempt: params.attempt }),
          };
        };
        return verifyGate === null ? answer() : verifyGate.then(answer);
      },
      "providers.profileCopy.retry": ():
        | ResponseOfMethod<HostRpcRegistry, "providers.profileCopy.retry">
        | Promise<
            ResponseOfMethod<HostRpcRegistry, "providers.profileCopy.retry">
          > => {
        if (retryGate !== null) {
          return retryGate.then(() => ({
            result: retryResult,
            outcome: retryOutcome ?? profileCopyOutcome({}),
          }));
        }
        if (retryThrows) {
          throw new HostRpcError({
            code: "RPC_ERROR",
            message: "retry unreachable",
            requestId: "req-sync",
            method: "providers.profileCopy.retry",
            fatalDetails: null,
          });
        }
        return {
          result: retryResult,
          outcome: retryOutcome ?? profileCopyOutcome({}),
        };
      },
      "providers.profileCopy.sync.saveRule": (
        params,
      ): ProfileSyncRule | Promise<ProfileSyncRule> => {
        if (saveRuleGate !== null) {
          return saveRuleGate.then((): ProfileSyncRule => {
            if (saveRuleThrows) {
              throw new HostRpcError({
                code: "RPC_ERROR",
                message: "save unreachable",
                requestId: "req-sync",
                method: "providers.profileCopy.sync.saveRule",
                fatalDetails: null,
              });
            }
            return {
              ...SAVED_RULE,
              ruleId: params.ruleId,
              sourceHostId: params.sourceHostId,
              destinationHostId: params.destinationHostId,
              scope: params.scope,
              paused: params.paused,
              revision: params.expectedRevision + 1,
            };
          });
        }
        if (saveRuleThrows) {
          throw new HostRpcError({
            code: "RPC_ERROR",
            message: "save unreachable",
            requestId: "req-sync",
            method: "providers.profileCopy.sync.saveRule",
            fatalDetails: null,
          });
        }
        return {
          ...SAVED_RULE,
          ruleId: params.ruleId,
          sourceHostId: params.sourceHostId,
          destinationHostId: params.destinationHostId,
          scope: params.scope,
          paused: params.paused,
          revision: params.expectedRevision + 1,
        };
      },
      "providers.profileCopy.sync.stopRule": ():
        | ResponseOfMethod<
            HostRpcRegistry,
            "providers.profileCopy.sync.stopRule"
          >
        | Promise<
            ResponseOfMethod<
              HostRpcRegistry,
              "providers.profileCopy.sync.stopRule"
            >
          > => {
        // Evaluated when the answer settles, so a held stop can still fail.
        const answer = () => {
          if (stopRuleThrows) {
            throw new HostRpcError({
              code: "RPC_ERROR",
              message: "stop unreachable",
              requestId: "req-sync",
              method: "providers.profileCopy.sync.stopRule",
              fatalDetails: null,
            });
          }
          return { batches: [], rules: [] };
        };
        return stopRuleGate === null ? answer() : stopRuleGate.then(answer);
      },
      "providers.profileCopy.sync.resolve": (
        params,
      ): ProfileSyncBatch | Promise<ProfileSyncBatch> => {
        // The batch as it stood at dispatch, which is what a host answers
        // from: read now, so a later omission from the list changes nothing.
        const listed = listBatches.find((b) => b.batchId === params.batchId);
        const started =
          lastStarted !== null && lastStarted.batchId === params.batchId
            ? lastStarted
            : null;
        // For a started batch prefer its newest listed state (receipt B over A).
        const newest =
          started !== null && updateStarted !== null
            ? updateStarted(started)
            : started;
        const captured = [...(listed?.items ?? newest?.items ?? [])];
        const answer = (): ProfileSyncBatch => {
          if (resolveThrows) {
            throw new HostRpcError({
              code: "RPC_ERROR",
              message: "resolve unreachable",
              requestId: "req-sync",
              method: "providers.profileCopy.sync.resolve",
              fatalDetails: null,
            });
          }
          if (resolveAnswer !== null) return resolveAnswer(params);
          return {
            batchId: params.batchId,
            sourceHostId: params.sourceHostId,
            createdAt: 1,
            automatic: false,
            items: captured,
          };
        };
        return resolveGate === null ? answer() : resolveGate.then(answer);
      },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      harness.hosts.find((host) => host.hostId === hostId)?.entry ??
      hostDirectoryEntry(hostId, hostId),
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "tok-sync",
    }),
  );
  harness.spine = spine;
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ProfileCopyFlowHost />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return messenger;
}

function openSync(providerId: "claude" | null): void {
  act(() => {
    useProfileCopyFlowStore.getState().open({
      kind: "sync",
      sourceHostId: SOURCE_HOST_ID,
      providerId,
    });
  });
}

function previewCalls(messenger: MockHostMessenger<HostRpcRegistry>) {
  return messenger.calls.filter(
    (call) => call.method === "providers.profileCopy.sync.preview",
  );
}

// jsdom lacks these Element methods; cmdk needs scrollIntoView and Radix
// Select reads pointer capture. Install them for every test and put back
// exactly what was there (a descriptor, or nothing) afterwards.
const ELEMENT_SHIMS = [
  "scrollIntoView",
  "hasPointerCapture",
  "setPointerCapture",
  "releasePointerCapture",
] as const;

function installElementShims(): () => void {
  const originals = ELEMENT_SHIMS.map((name) =>
    Object.getOwnPropertyDescriptor(Element.prototype, name),
  );
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  return () => {
    ELEMENT_SHIMS.forEach((name, index) => {
      const original = originals[index];
      if (original === undefined)
        Reflect.deleteProperty(Element.prototype, name);
      else Object.defineProperty(Element.prototype, name, original);
    });
  };
}

function resetModuleKnobs(): void {
  startFailures = 0;
  previewRevision = PREVIEW_REVISION;
  startBatchSource = null;
  listFails = false;
  listBatches = [];
  previewSelection = null;
  startBatchMutator = null;
  listRules = null;
  lastStarted = null;
  updateStarted = null;
  retryResult = "current";
  retryOutcome = null;
  retryThrows = false;
  resolveThrows = false;
  saveRuleThrows = false;
  saveRuleGate = null;
  startGate = null;
  retryGate = null;
  resolveGate = null;
  resolveAnswer = null;
  draftStatusOutcome = null;
  verifyGate = null;
  verifyResult = "current";
  verifyThrows = false;
  stopRuleGate = null;
  stopRuleThrows = false;
}

let restoreElementShims: (() => void) | null = null;

// File scope, so every describe starts from the same world.
beforeEach(() => {
  resetModuleKnobs();
  resetStores();
  harness.spine = null;
  harness.hosts = [
    hostOption(SOURCE_HOST_ID, "Studio Mac", true),
    hostOption(DEST_HOST_ID, "Linux box", false),
    hostOption(DEST_HOST_TWO_ID, "Old Mac", false),
  ];
  restoreElementShims = installElementShims();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  resetStores();
  resetModuleKnobs();
  harness.spine = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restoreElementShims?.();
  restoreElementShims = null;
});

describe("ProfileSyncModal", () => {
  it("selects no destination by default and asks for none before one is chosen", async () => {
    const messenger = mount([]);
    openSync(null);
    const boxes = await screen.findAllByRole("checkbox");
    expect(boxes.length).toBeGreaterThanOrEqual(2);
    for (const box of boxes)
      expect(box.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Choose destination devices.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Sync now" }).hasAttribute("disabled"),
    ).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(previewCalls(messenger)).toHaveLength(0);
  });

  it("never offers the source host as a destination", async () => {
    mount([]);
    openSync(null);
    await screen.findByRole("checkbox", { name: /Linux box/ });
    expect(screen.queryByRole("checkbox", { name: /Studio Mac/ })).toBeNull();
  });

  it("opens from a provider with only that provider selected, else with every provider", async () => {
    mount([]);
    openSync("claude");
    const trigger = await screen.findByRole("button", {
      name: "Choose providers",
    });
    expect(trigger.textContent).toMatch(/Claude/);
    expect(trigger.textContent).not.toMatch(/Codex/);
    cleanup();
    resetStores();
    mount([]);
    openSync(null);
    const all = await screen.findByRole("button", { name: "Choose providers" });
    expect(all.textContent).toMatch(/Claude/);
    expect(all.textContent).toMatch(/Codex/);
  });

  it("previews the multi-provider selection against the captured source after 400ms", async () => {
    const messenger = mount([]);
    openSync("claude");
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose providers" }),
    );
    fireEvent.click(await screen.findByText("Codex"));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Linux box/ }));
    expect(previewCalls(messenger)).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    // Settings moves to another host mid-flow; the request must still go to the capture.
    act(() => {
      useSettingsHostScopeStore.getState().setScopedHostId("other-host");
    });
    await waitFor(() =>
      expect(previewCalls(messenger).length).toBeGreaterThan(0),
    );
    const call = previewCalls(messenger)[0];
    expect(call.authority.endpoint.hostId).toBe(SOURCE_HOST_ID);
    expect(call.params).toMatchObject({
      sourceHostId: SOURCE_HOST_ID,
      scope: { kind: "selected", providers: ["claude", "codex"] },
      destinationHostIds: [DEST_HOST_ID],
    });
  });

  it("loads a saved rule's scope into the editor instead of resetting to every provider", async () => {
    mount([SAVED_RULE]);
    openSync(null);
    fireEvent.mouseDown(
      await screen.findByRole("tab", { name: /Automatic sync/ }),
      { button: 0 },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const trigger = await screen.findByRole("button", {
      name: "Choose providers",
    });
    expect(trigger.textContent).toMatch(/Codex/);
    expect(trigger.textContent).not.toMatch(/Claude/);
    const all = screen.getByRole("checkbox", {
      name: /All supported providers, including future providers/,
    });
    expect(all.getAttribute("aria-checked")).toBe("false");
  });
});

const STAMP = "c".repeat(64);
const CATALOG_PROFILE_A = "11111111-aaaa-4aaa-8aaa-111111111111";
const CATALOG_PROFILE_B = "22222222-bbbb-4bbb-8bbb-222222222222";

type PreviewDestination = NonNullable<
  ProfileSyncItem["preview"]
>["destinations"][number];

function previewDestination(
  destinationHostId: string,
  disposition: "automatic" | "already-present",
): PreviewDestination {
  return {
    destinationHostId,
    feasibility: {
      automatic: {
        status: "available" as const,
        admissionRevision: "b".repeat(64),
      },
      manual: {
        status: "unavailable" as const,
        reason: "manual-login-unavailable" as const,
      },
    },
    disposition,
    reason: null,
    existingProfileId: null,
    destinationProviderEnabled: true,
  };
}

/** The item for another source profile, with its nested preview source to match. */
function withSourceProfile(
  item: ProfileSyncItem,
  sourceProfileId: string,
): ProfileSyncItem {
  return {
    ...item,
    sourceProfileId,
    preview:
      item.preview === null
        ? null
        : {
            ...item.preview,
            source: { ...item.preview.source, sourceProfileId },
          },
  };
}

function syncItem(
  index: number,
  destinationHostId: string,
  state: ProfileSyncItem["state"],
  destinations: PreviewDestination[],
): ProfileSyncItem {
  return {
    providerId: "claude",
    sourceProfileId: SOURCE_PROFILE_ID,
    name: `Profile ${String(index)}`,
    destinationHostId,
    operationId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    preview: {
      source: {
        sourceHostId: SOURCE_HOST_ID,
        sourceProfileId: SOURCE_PROFILE_ID,
        providerId: "claude",
      },
      previewRevision: PREVIEW_REVISION,
      destinations,
    },
    outcome: null,
    state,
    sourceSettings: {
      name: `Profile ${String(index)}`,
      color: "#ef4444",
      enabled: true,
    },
    sourceIdentityStamp: STAMP,
    identityChanged: false,
    destinationSettings: null,
    baseline: null,
  };
}

function startCalls(messenger: MockHostMessenger<HostRpcRegistry>) {
  return messenger.calls.filter(
    (call) => call.method === "providers.profileCopy.sync.start",
  );
}

async function pickDestinations(names: readonly RegExp[]): Promise<void> {
  for (const name of names) {
    fireEvent.click(await screen.findByRole("checkbox", { name }));
  }
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
}

describe("ProfileSyncModal review regressions", () => {
  it("describes each destination from its own preview row and leaves already-present out of the review count", async () => {
    mountWith({
      rules: [],
      providers: defaultProviders(),
      previewItems: () => [
        // The matching destination is second: reading the first row would say
        // "already has this account" for a profile that WILL be copied.
        syncItem(1, DEST_HOST_ID, "ready", [
          previewDestination(DEST_HOST_TWO_ID, "already-present"),
          previewDestination(DEST_HOST_ID, "automatic"),
        ]),
        syncItem(2, DEST_HOST_TWO_ID, "already-present", [
          previewDestination(DEST_HOST_TWO_ID, "already-present"),
        ]),
        // A second profile on the same device: its own logical transfer.
        withSourceProfile(
          syncItem(3, DEST_HOST_TWO_ID, "ready", [
            previewDestination(DEST_HOST_TWO_ID, "automatic"),
          ]),
          "33333333-3333-4333-8333-333333333334",
        ),
      ],
      startItems: noItems,
    });
    openSync(null);
    await pickDestinations([/Linux box/, /Old Mac/]);
    const summaries = await screen.findAllByText(/\d+ profiles ·/);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.textContent).toMatch(/1 profiles · Ready/);
    // Two rows, one already present: nothing here needs review.
    expect(summaries[1]?.textContent).toMatch(/2 profiles · Ready/);
    expect(summaries[1]?.textContent).not.toMatch(/need review/);
    const firstDetails = summaries[0].closest("details");
    if (firstDetails === null)
      throw new Error("expected the Linux box details");
    expect(within(firstDetails).queryByText(/already has this/)).toBeNull();
  });

  it("counts only real attention as needing review: queued and in-progress rows are in flight, and Sync now stays available", async () => {
    // Rows already in flight carry no preview of their own, so each shows its
    // state label rather than a copy-preview sentence.
    const inFlight = (
      index: number,
      destinationHostId: string,
      state: "queued" | "copying",
      sourceProfileId: string,
    ): ProfileSyncItem => ({
      ...withSourceProfile(
        syncItem(index, destinationHostId, state, [
          previewDestination(destinationHostId, "automatic"),
        ]),
        sourceProfileId,
      ),
      preview: null,
    });
    const PROFILE_B = "33333333-3333-4333-8333-333333333334";
    const PROFILE_C = "33333333-3333-4333-8333-333333333335";
    mountWith({
      rules: [],
      providers: defaultProviders(),
      previewItems: () => [
        inFlight(1, DEST_HOST_ID, "queued", SOURCE_PROFILE_ID),
        inFlight(2, DEST_HOST_ID, "copying", PROFILE_B),
        // The one row that genuinely needs the user.
        {
          ...inFlight(3, DEST_HOST_ID, "queued", PROFILE_C),
          state: "needs-action",
          identityChanged: true,
        },
        inFlight(4, DEST_HOST_TWO_ID, "queued", SOURCE_PROFILE_ID),
        inFlight(5, DEST_HOST_TWO_ID, "copying", PROFILE_B),
      ],
      startItems: noItems,
    });
    openSync(null);
    await pickDestinations([/Linux box/, /Old Mac/]);
    const summaries = await screen.findAllByText(/\d+ profiles ·/);
    expect(summaries).toHaveLength(2);
    // Linux box: only the needs-action row is counted.
    expect(summaries[0]?.textContent).toMatch(/3 profiles · 1 need review/);
    // Old Mac: queued and in progress alone need no review.
    expect(summaries[1]?.textContent).toMatch(/2 profiles · Ready/);
    expect(summaries[1]?.textContent).not.toMatch(/need review/);
    const oldMac = summaries[1].closest("details");
    if (oldMac === null) throw new Error("expected the Old Mac details");
    expect(within(oldMac).getByText("Queued")).toBeTruthy();
    expect(within(oldMac).getByText("In progress")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Sync now" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("an empty start answer keeps the selection, says nothing was started and refetches the preview", async () => {
    const messenger = mountWith({
      rules: [],
      providers: defaultProviders(),
      previewItems: () => [
        syncItem(1, DEST_HOST_ID, "ready", [
          previewDestination(DEST_HOST_ID, "automatic"),
        ]),
      ],
      startItems: noItems,
    });
    openSync(null);
    await pickDestinations([/Linux box/]);
    await screen.findByText("1 profile transfers selected");
    const before = previewCalls(messenger).length;
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(
      await screen.findByText(
        "Nothing was started. Check the selection and try again.",
      ),
    ).toBeTruthy();
    expect(startCalls(messenger)).toHaveLength(1);
    // Still the selection view: no results screen, the destination stays chosen.
    expect(screen.queryByRole("button", { name: /Back/ })).toBeNull();
    expect(
      screen
        .getByRole("checkbox", { name: /Linux box/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await waitFor(() =>
      expect(previewCalls(messenger).length).toBeGreaterThan(before),
    );
    // The refetch settled on the SAME preview revision. A retry must not reuse
    // the batch id of the start that started nothing, or the host would replay
    // that empty batch instead of starting the selection.
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Sync now" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(startCalls(messenger)).toHaveLength(2));
    const batchIds = startCalls(messenger).map(
      (call) => profileSyncStartSchema.parse(call.params).batchId,
    );
    expect(batchIds[0]).toBeTruthy();
    expect(batchIds[1]).toBeTruthy();
    expect(batchIds[1]).not.toBe(batchIds[0]);
  });

  describe("source catalog limits the selectable providers", () => {
    function catalogWithUnsupported(): readonly ProviderCliState[] {
      return [
        claudeProviderState([
          managedProfile(CATALOG_PROFILE_A, "Work"),
          managedProfile(CATALOG_PROFILE_B, "Personal"),
        ]),
        {
          ...claudeProviderState([
            managedProfile("55555555-5555-4555-8555-555555555555", "Main"),
          ]),
          providerId: "codex",
        },
        {
          ...claudeProviderState([
            managedProfile("66666666-6666-4666-8666-666666666666", "One"),
            managedProfile("77777777-7777-4777-8777-777777777777", "Two"),
            managedProfile("88888888-8888-4888-8888-888888888888", "Three"),
          ]),
          providerId: "opencode",
        },
      ];
    }

    it("starts with only the catalog's transferable providers selected, with the matching count", async () => {
      mountWith({
        rules: [],
        providers: catalogWithUnsupported(),
        previewItems: noItems,
        startItems: noItems,
      });
      openSync(null);
      const trigger = await screen.findByRole("button", {
        name: "Choose providers",
      });
      await waitFor(() => expect(trigger.textContent).toMatch(/Claude/));
      expect(trigger.textContent).toMatch(/Codex/);
      expect(trigger.textContent).not.toMatch(/Grok|Antigravity|Gemini|Open/);
      // Three profiles across the two (the opencode ones cannot be transferred).
      expect(screen.getByText(/2 selected/).textContent).toMatch(/3 profiles/);
    });

    it("offers only those providers, and Select all / Clear stay inside them", async () => {
      mountWith({
        rules: [],
        providers: catalogWithUnsupported(),
        previewItems: noItems,
        startItems: noItems,
      });
      openSync(null);
      fireEvent.click(
        await screen.findByRole("button", { name: "Choose providers" }),
      );
      expect(await screen.findAllByRole("option")).toHaveLength(2);
      fireEvent.click(screen.getByRole("button", { name: "Clear" }));
      expect(screen.getByText(/0 selected/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Select all" }));
      expect(screen.getByText(/2 selected/).textContent).toMatch(/3 profiles/);
    });

    it("sends only the catalog providers in the preview and the start", async () => {
      const messenger = mountWith({
        rules: [],
        providers: catalogWithUnsupported(),
        previewItems: () => [
          syncItem(1, DEST_HOST_ID, "ready", [
            previewDestination(DEST_HOST_ID, "automatic"),
          ]),
        ],
        startItems: noItems,
      });
      openSync(null);
      await screen.findByRole("button", { name: "Choose providers" });
      await pickDestinations([/Linux box/]);
      await screen.findByText("1 profile transfers selected");
      expect(previewCalls(messenger).at(-1)?.params).toMatchObject({
        scope: { kind: "selected", providers: ["claude", "codex"] },
      });
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      await waitFor(() => expect(startCalls(messenger)).toHaveLength(1));
      expect(startCalls(messenger)[0]?.params).toMatchObject({
        selection: {
          scope: { kind: "selected", providers: ["claude", "codex"] },
        },
      });
    });

    it("a new automatic rule defaults to the same catalog providers", async () => {
      mountWith({
        rules: [],
        providers: catalogWithUnsupported(),
        previewItems: noItems,
        startItems: noItems,
      });
      openSync(null);
      fireEvent.mouseDown(
        await screen.findByRole("tab", { name: /Automatic sync/ }),
        {
          button: 0,
        },
      );
      fireEvent.click(
        await screen.findByRole("button", { name: "Add device" }),
      );
      const trigger = await screen.findByRole("button", {
        name: "Choose providers",
      });
      await waitFor(() => expect(trigger.textContent).toMatch(/Claude/));
      expect(trigger.textContent).toMatch(/Codex/);
      expect(trigger.textContent).not.toMatch(/Grok|Antigravity|Gemini|Open/);
      fireEvent.click(trigger);
      expect(await screen.findAllByRole("option")).toHaveLength(2);
    });
  });

  describe("round 2: request ids, captured source and run capacity", () => {
    const READY_ITEM = (): ProfileSyncItem[] => [
      syncItem(1, DEST_HOST_ID, "ready", [
        previewDestination(DEST_HOST_ID, "automatic"),
      ]),
    ];

    async function settled(
      messenger: MockHostMessenger<HostRpcRegistry>,
      previewsBefore: number,
    ): Promise<void> {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      await waitFor(() => {
        expect(previewCalls(messenger).length).toBeGreaterThan(previewsBefore);
        expect(
          screen
            .getByRole("button", { name: "Sync now" })
            .hasAttribute("disabled"),
        ).toBe(false);
      });
    }

    it("two different selections on the same preview revision send different batch ids after an unconfirmed first start", async () => {
      startFailures = 1;
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: READY_ITEM,
        startItems: noItems,
      });
      openSync(null);
      await pickDestinations([/Linux box/]);
      await screen.findByText("1 profile transfers selected");
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      expect(await screen.findByText(/could not be confirmed/)).toBeTruthy();
      const before = previewCalls(messenger).length;
      fireEvent.click(await screen.findByRole("checkbox", { name: /Old Mac/ }));
      await settled(messenger, before);
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      await waitFor(() => expect(startCalls(messenger)).toHaveLength(2));
      const [firstCall, secondCall] = startCalls(messenger);
      const first = profileSyncStartSchema.parse(firstCall.params);
      const second = profileSyncStartSchema.parse(secondCall.params);
      expect(first.revision).toBe(second.revision);
      expect(first.selection.destinationHostIds).toEqual([DEST_HOST_ID]);
      expect(second.selection.destinationHostIds).toEqual([
        DEST_HOST_ID,
        DEST_HOST_TWO_ID,
      ]);
      expect(second.batchId).not.toBe(first.batchId);
    });

    it("an unconfirmed start retried for the same selection keeps its batch id", async () => {
      startFailures = 1;
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: READY_ITEM,
        startItems: noItems,
      });
      openSync(null);
      await pickDestinations([/Linux box/]);
      await screen.findByText("1 profile transfers selected");
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      expect(await screen.findByText(/could not be confirmed/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      await waitFor(() => expect(startCalls(messenger)).toHaveLength(2));
      const [firstCall, secondCall] = startCalls(messenger);
      const first = profileSyncStartSchema.parse(firstCall.params);
      const second = profileSyncStartSchema.parse(secondCall.params);
      expect(first.batchId).toBeTruthy();
      expect(second.batchId).toBe(first.batchId);
    });

    it("refuses a returned run for another source: no actions, and nothing dispatches to either device", async () => {
      // A run that is internally consistent for ANOTHER source (batch B and
      // the nested outcome's attempt both name B) must still not act on A.
      startBatchSource = DEST_HOST_ID;
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: READY_ITEM,
        startItems: () => [
          {
            ...syncItem(1, DEST_HOST_TWO_ID, "unconfirmed", [
              previewDestination(DEST_HOST_TWO_ID, "automatic"),
            ]),
            preview: null,
            outcome: profileCopyOutcome({
              attempt: profileCopyAttempt({
                sourceHostId: DEST_HOST_ID,
                destinationHostId: DEST_HOST_TWO_ID,
                operationId: "00000000-0000-4000-8000-000000000001",
              }),
              state: "failed",
            }),
          },
        ],
      });
      openSync(null);
      await pickDestinations([/Linux box/]);
      await screen.findByText("1 profile transfers selected");
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      expect(
        await screen.findByText(
          "The device returned a run for another source. Check sync history again.",
        ),
      ).toBeTruthy();
      for (const name of [/Check status/, /Retry/, /Review/])
        expect(screen.queryByRole("button", { name })).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      const dispatched = messenger.calls.filter(
        (call) =>
          call.method !== "providers.profileCopy.sync.start" &&
          call.method !== "providers.profileCopy.sync.preview" &&
          call.method !== "providers.profileCopy.sync.list" &&
          call.method !== "providers.list",
      );
      expect(dispatched).toEqual([]);
    });

    describe("run capacity of 512 profile transfers", () => {
      const LIMIT_TEXT =
        "Choose fewer providers or devices: a run supports up to 512 profile transfers.";

      function catalog(profiles: number): readonly ProviderCliState[] {
        return [
          claudeProviderState(
            Array.from({ length: profiles }, (_unused, index) =>
              managedProfile(
                `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
                `Profile ${String(index + 1)}`,
              ),
            ),
          ),
        ];
      }

      function deviceName(index: number): RegExp {
        return new RegExp(`Device ${String(index)}(?!\\d)`);
      }

      async function chooseDevices(count: number): Promise<void> {
        for (let index = 1; index <= count; index += 1) {
          fireEvent.click(
            await screen.findByRole("checkbox", { name: deviceName(index) }),
          );
        }
        await act(async () => {
          await vi.advanceTimersByTimeAsync(400);
        });
      }

      beforeEach(() => {
        harness.hosts = [
          hostOption(SOURCE_HOST_ID, "Studio Mac", true),
          ...Array.from({ length: 16 }, (_unused, index) =>
            hostOption(
              `capacity-host-${String(index + 1)}`,
              `Device ${String(index + 1)}`,
              false,
            ),
          ),
        ];
      });

      it("33 profiles to 16 devices is refused before any preview or start, with an explanation", async () => {
        const messenger = mountWith({
          rules: [],
          providers: catalog(33),
          previewItems: noItems,
          startItems: noItems,
        });
        openSync(null);
        await screen.findByRole("button", { name: "Choose providers" });
        await chooseDevices(16);
        expect(await screen.findByText(LIMIT_TEXT)).toBeTruthy();
        expect(previewCalls(messenger)).toHaveLength(0);
        expect(
          screen
            .getByRole("button", { name: "Sync now" })
            .hasAttribute("disabled"),
        ).toBe(true);
        fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
        expect(startCalls(messenger)).toHaveLength(0);
      });

      it("dropping to 15 devices lifts the refusal and previews", async () => {
        const messenger = mountWith({
          rules: [],
          providers: catalog(33),
          previewItems: noItems,
          startItems: noItems,
        });
        openSync(null);
        await screen.findByRole("button", { name: "Choose providers" });
        await chooseDevices(16);
        await screen.findByText(LIMIT_TEXT);
        fireEvent.click(
          await screen.findByRole("checkbox", { name: deviceName(16) }),
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(400);
        });
        await waitFor(() =>
          expect(previewCalls(messenger).length).toBeGreaterThan(0),
        );
        expect(screen.queryByText(LIMIT_TEXT)).toBeNull();
        const lastPreview = previewCalls(messenger).at(-1);
        expect(lastPreview).toBeDefined();
        const requested = profileSyncSelectionSchema.parse(lastPreview?.params);
        expect(requested.destinationHostIds).toHaveLength(15);
        expect(requested.destinationHostIds).not.toContain("capacity-host-16");
      });

      it("exactly 32 profiles to 16 devices (512) is allowed", async () => {
        const messenger = mountWith({
          rules: [],
          providers: catalog(32),
          previewItems: noItems,
          startItems: noItems,
        });
        openSync(null);
        await screen.findByRole("button", { name: "Choose providers" });
        await chooseDevices(16);
        await waitFor(() =>
          expect(previewCalls(messenger).length).toBeGreaterThan(0),
        );
        expect(screen.queryByText(LIMIT_TEXT)).toBeNull();
      });
    });
  });

  describe("round 3: sync history gate and host removal", () => {
    function perDestination(
      selection: ProfileSyncSelection,
    ): readonly ProfileSyncItem[] {
      return selection.destinationHostIds.map((id, index) =>
        syncItem(index + 1, id, "ready", [previewDestination(id, "automatic")]),
      );
    }

    function refreshHosts(): void {
      // The host options are read by the flow body above the modal: re-render
      // it with a fresh view object, leaving `session` (and so the modal's
      // selection state) untouched.
      act(() => {
        useProfileCopyFlowStore.setState((state) => ({
          view: state.view === null ? null : { ...state.view },
        }));
      });
    }

    it("shows no empty-rules state, Add device or editor until the sync history loads, then the authoritative rule", async () => {
      listFails = true;
      mountWith({
        rules: [SAVED_RULE],
        providers: defaultProviders(),
        previewItems: noItems,
        startItems: noItems,
      });
      openSync(null);
      fireEvent.mouseDown(
        await screen.findByRole("tab", { name: /Automatic sync/ }),
        { button: 0 },
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      const retry = await screen.findByRole("button", { name: "Try again" });
      expect(screen.queryByText(/No automatic rules yet/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Add device" })).toBeNull();
      expect(screen.queryByText("Add automatic sync")).toBeNull();
      listFails = false;
      fireEvent.click(retry);
      expect(
        await screen.findByRole("heading", { name: "Linux box" }),
      ).toBeTruthy();
      expect(screen.queryByText(/No automatic rules yet/)).toBeNull();
      expect(screen.getByRole("button", { name: "Add device" })).toBeTruthy();
    });

    it("drops a removed destination from the count, the preview and the start, and keeps an offline device selectable", async () => {
      const offline = hostOption("offline-host", "Sleeping box", false);
      harness.hosts = [
        ...harness.hosts,
        {
          ...offline,
          connectable: false,
          health: { ...offline.health, live: false },
        },
      ];
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: perDestination,
        startItems: noItems,
      });
      openSync(null);
      await pickDestinations([/Linux box/, /Old Mac/, /Sleeping box/]);
      await screen.findByText("3 profile transfers selected");
      harness.hosts = harness.hosts.filter(
        (host) => host.hostId !== DEST_HOST_TWO_ID,
      );
      refreshHosts();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(
        await screen.findByText("2 profile transfers selected"),
      ).toBeTruthy();
      expect(screen.queryByRole("checkbox", { name: /Old Mac/ })).toBeNull();
      const lastPreview = previewCalls(messenger).at(-1);
      expect(lastPreview).toBeDefined();
      const requested = profileSyncSelectionSchema.parse(lastPreview?.params);
      expect(requested.destinationHostIds).toEqual([
        DEST_HOST_ID,
        "offline-host",
      ]);
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      await waitFor(() => expect(startCalls(messenger)).toHaveLength(1));
      const started = profileSyncStartSchema.parse(
        startCalls(messenger)[0].params,
      );
      expect(started.selection.destinationHostIds).toEqual([
        DEST_HOST_ID,
        "offline-host",
      ]);
    });

    it("a removed selected device no longer counts toward the 16-device limit", async () => {
      harness.hosts = [
        hostOption(SOURCE_HOST_ID, "Studio Mac", true),
        ...Array.from({ length: 17 }, (_unused, index) =>
          hostOption(
            `limit-host-${String(index + 1)}`,
            `Device ${String(index + 1)}`,
            false,
          ),
        ),
      ];
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: noItems,
        startItems: noItems,
      });
      openSync(null);
      for (let index = 1; index <= 16; index += 1) {
        fireEvent.click(
          await screen.findByRole("checkbox", {
            name: new RegExp(`Device ${String(index)}(?!\\d)`),
          }),
        );
      }
      const seventeenth = await screen.findByRole("checkbox", {
        name: /Device 17(?!\d)/,
      });
      expect(seventeenth.hasAttribute("disabled")).toBe(true);
      harness.hosts = harness.hosts.filter(
        (host) => host.hostId !== "limit-host-16",
      );
      refreshHosts();
      const reopened = await screen.findByRole("checkbox", {
        name: /Device 17(?!\d)/,
      });
      expect(reopened.hasAttribute("disabled")).toBe(false);
      // Choosing it prunes the removed device from the outgoing request too.
      fireEvent.click(reopened);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      await waitFor(() => {
        const last = previewCalls(messenger).at(-1);
        expect(last).toBeDefined();
        const requested = profileSyncSelectionSchema.parse(last?.params);
        expect(requested.destinationHostIds).toContain("limit-host-17");
      });
      const finalPreview = profileSyncSelectionSchema.parse(
        previewCalls(messenger).at(-1)?.params,
      );
      expect(finalPreview.destinationHostIds).not.toContain("limit-host-16");
      expect(finalPreview.destinationHostIds).toHaveLength(16);
    });
  });

  describe("round 4: echoed selection, recent runs and failure scoping", () => {
    const READY = (): ProfileSyncItem[] => [
      syncItem(1, DEST_HOST_ID, "ready", [
        previewDestination(DEST_HOST_ID, "automatic"),
      ]),
    ];

    async function settledAfter(
      messenger: MockHostMessenger<HostRpcRegistry>,
      previewsBefore: number,
    ): Promise<void> {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      await waitFor(() => {
        expect(previewCalls(messenger).length).toBeGreaterThan(previewsBefore);
        expect(
          screen
            .getByRole("button", { name: "Sync now" })
            .hasAttribute("disabled"),
        ).toBe(false);
      });
    }

    it("a valid preview that echoes a different selection never enables Sync now or dispatches, and keeps the local choices", async () => {
      previewSelection = {
        sourceHostId: SOURCE_HOST_ID,
        scope: { kind: "all" },
        destinationHostIds: [DEST_HOST_TWO_ID],
      };
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        // Ready, and consistent with the ECHOED selection (Old Mac), so only
        // the mismatch with the requested one can disable Sync now.
        previewItems: () => [
          syncItem(1, DEST_HOST_TWO_ID, "ready", [
            previewDestination(DEST_HOST_TWO_ID, "automatic"),
          ]),
        ],
        startItems: noItems,
      });
      openSync(null);
      await pickDestinations([/Linux box/]);
      await waitFor(() =>
        expect(previewCalls(messenger).length).toBeGreaterThan(0),
      );
      expect(
        await screen.findByText(
          "The device returned a different selection. Check again.",
        ),
      ).toBeTruthy();
      const sync = screen.getByRole("button", { name: "Sync now" });
      expect(sync.hasAttribute("disabled")).toBe(true);
      fireEvent.click(sync);
      expect(startCalls(messenger)).toHaveLength(0);
      expect(
        screen
          .getByRole("checkbox", { name: /Linux box/ })
          .getAttribute("aria-checked"),
      ).toBe("true");
      expect(
        screen
          .getByRole("checkbox", { name: /Old Mac/ })
          .getAttribute("aria-checked"),
      ).toBe("false");
    });

    it("shows the five newest recent runs, newest first, whatever order the host lists them in", async () => {
      const base = 1_700_000_000_000;
      const minutes = [3, 7, 1, 6, 2, 5, 4];
      listBatches = minutes.map((minute): ProfileSyncBatch => ({
        batchId: `00000000-0000-4000-8000-${String(minute).padStart(12, "0")}`,
        sourceHostId: SOURCE_HOST_ID,
        createdAt: base + minute * 60_000,
        automatic: false,
        items: [listedItem(DEST_HOST_ID)],
      }));
      mount([]);
      openSync(null);
      await screen.findByText("Recent runs");
      const rows = screen
        .getAllByRole("button", { name: /profile transfers/ })
        .map((row) => row.textContent);
      expect(rows).toHaveLength(5);
      [7, 6, 5, 4, 3].forEach((minute, index) => {
        expect(rows[index]).toContain(
          new Date(base + minute * 60_000).toLocaleString(),
        );
      });
    });

    it("an uncertain start's failure text follows its own selection: hidden on another choice, back on return, with the same batch id", async () => {
      startFailures = 1;
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: READY,
        startItems: noItems,
      });
      openSync(null);
      await pickDestinations([/Linux box/]);
      await screen.findByText("1 profile transfers selected");
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      expect(await screen.findByText(/could not be confirmed/)).toBeTruthy();
      const before = previewCalls(messenger).length;
      fireEvent.click(screen.getByRole("checkbox", { name: /Old Mac/ }));
      await settledAfter(messenger, before);
      expect(screen.queryByText(/could not be confirmed/)).toBeNull();
      // Back on the original choices the cached preview is reused, so no new
      // preview request is expected: wait for the rendered state instead.
      fireEvent.click(screen.getByRole("checkbox", { name: /Old Mac/ }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(await screen.findByText(/could not be confirmed/)).toBeTruthy();
      await waitFor(() =>
        expect(
          screen
            .getByRole("button", { name: "Sync now" })
            .hasAttribute("disabled"),
        ).toBe(false),
      );
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      await waitFor(() => expect(startCalls(messenger)).toHaveLength(2));
      const [firstCall, secondCall] = startCalls(messenger);
      const first = profileSyncStartSchema.parse(firstCall.params);
      const second = profileSyncStartSchema.parse(secondCall.params);
      expect(second.selection).toEqual(first.selection);
      expect(second.batchId).toBe(first.batchId);
    });

    it("an uncertain start's failure text is dropped once Check again returns a new revision, and the next start gets a new batch id", async () => {
      startFailures = 1;
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: READY,
        startItems: noItems,
      });
      try {
        openSync(null);
        await pickDestinations([/Linux box/]);
        await screen.findByText("1 profile transfers selected");
        fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
        expect(await screen.findByText(/could not be confirmed/)).toBeTruthy();
        const before = previewCalls(messenger).length;
        previewRevision = "b".repeat(64);
        fireEvent.click(screen.getByRole("button", { name: "Check again" }));
        await waitFor(() =>
          expect(previewCalls(messenger).length).toBeGreaterThan(before),
        );
        await waitFor(() =>
          expect(screen.queryByText(/could not be confirmed/)).toBeNull(),
        );
        await waitFor(() =>
          expect(
            screen
              .getByRole("button", { name: "Sync now" })
              .hasAttribute("disabled"),
          ).toBe(false),
        );
        fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
        await waitFor(() => expect(startCalls(messenger)).toHaveLength(2));
        const [firstCall, secondCall] = startCalls(messenger);
        const first = profileSyncStartSchema.parse(firstCall.params);
        const second = profileSyncStartSchema.parse(secondCall.params);
        expect(second.selection).toEqual(first.selection);
        expect(first.revision).toBe(PREVIEW_REVISION);
        expect(second.revision).toBe("b".repeat(64));
        expect(second.batchId).not.toBe(first.batchId);
      } finally {
        previewRevision = PREVIEW_REVISION;
      }
    });
    describe.each([
      [
        "a rejected response",
        "The device returned a run for another source. Check sync history again.",
        () => {
          startBatchSource = DEST_HOST_ID;
        },
      ],
      [
        "an empty answer",
        "Nothing was started. Check the selection and try again.",
        () => undefined,
      ],
    ])(
      "the notice for %s follows its submitted revision",
      (_label, notice, arrange) => {
        async function startAndCheck(
          nextRevision: string,
        ): Promise<MockHostMessenger<HostRpcRegistry>> {
          arrange();
          const messenger = mountWith({
            rules: [],
            providers: defaultProviders(),
            previewItems: READY,
            startItems: noItems,
          });
          try {
            openSync(null);
            await pickDestinations([/Linux box/]);
            await screen.findByText("1 profile transfers selected");
            fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
            expect(await screen.findByText(notice)).toBeTruthy();
            await waitFor(() =>
              expect(
                screen
                  .getByRole("button", { name: "Check again" })
                  .hasAttribute("disabled"),
              ).toBe(false),
            );
            const before = previewCalls(messenger).length;
            previewRevision = nextRevision;
            fireEvent.click(
              screen.getByRole("button", { name: "Check again" }),
            );
            await waitFor(() =>
              expect(previewCalls(messenger).length).toBeGreaterThan(before),
            );
            await waitFor(() =>
              expect(
                screen
                  .getByRole("button", { name: "Sync now" })
                  .hasAttribute("disabled"),
              ).toBe(false),
            );
          } finally {
            previewRevision = PREVIEW_REVISION;
          }
          return messenger;
        }

        it("stays when Check again returns the same revision", async () => {
          await startAndCheck(PREVIEW_REVISION);
          expect(screen.getByText(notice)).toBeTruthy();
        });

        it("disappears when Check again returns a new revision for the same selection", async () => {
          await startAndCheck("b".repeat(64));
          expect(screen.queryByText(notice)).toBeNull();
        });
      },
    );
  });

  describe("round 6: run ownership, automatic results link and rule capacity", () => {
    const SELECTION_ALERT =
      "The device returned a run outside this selection. Check sync history again.";
    const AUTO_BATCH = "00000000-0000-4000-8000-0000000000c1";

    const queuedItem = (): ProfileSyncItem => ({
      ...syncItem(1, DEST_HOST_ID, "queued", [
        previewDestination(DEST_HOST_ID, "automatic"),
      ]),
      preview: null,
    });

    const outsideSelection: ReadonlyArray<
      readonly [string, (batch: ProfileSyncBatch) => ProfileSyncBatch]
    > = [
      [
        "batch id",
        (batch) => ({
          ...batch,
          batchId: "00000000-0000-4000-8000-0000000000ff",
        }),
      ],
      [
        "provider",
        (batch) => ({
          ...batch,
          items: batch.items.map((entry) => ({
            ...entry,
            providerId: "codex" as const,
          })),
        }),
      ],
      [
        "destination",
        (batch) => ({
          ...batch,
          items: batch.items.map((entry) => ({
            ...entry,
            destinationHostId: DEST_HOST_TWO_ID,
          })),
        }),
      ],
      [
        "profile",
        (batch) => ({
          ...batch,
          items: batch.items.map((entry) => ({
            ...entry,
            sourceProfileId: "00000000-0000-4000-8000-0000000000ee",
          })),
        }),
      ],
    ];

    async function startSelected(): Promise<void> {
      openSync("claude");
      await pickDestinations([/Linux box/]);
      await screen.findByText("1 profile transfers selected");
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    }

    function mountStart(): MockHostMessenger<HostRpcRegistry> {
      return mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: () => [
          syncItem(1, DEST_HOST_ID, "ready", [
            previewDestination(DEST_HOST_ID, "automatic"),
          ]),
        ],
        startItems: () => [queuedItem()],
      });
    }

    it.each(outsideSelection)(
      "refuses a same-source run with a different %s and keeps the selection",
      async (_label, mutate) => {
        startBatchMutator = mutate;
        mountStart();
        await startSelected();
        expect(await screen.findByText(SELECTION_ALERT)).toBeTruthy();
        expect(screen.queryByRole("button", { name: "← Back" })).toBeNull();
        expect(
          screen
            .getByRole("checkbox", { name: /Linux box/ })
            .getAttribute("aria-checked"),
        ).toBe("true");
      },
    );

    it("opens a matching run as before", async () => {
      mountStart();
      await startSelected();
      expect(
        await screen.findByRole("button", { name: "← Back" }),
      ).toBeTruthy();
      expect(screen.queryByText(SELECTION_ALERT)).toBeNull();
    });

    function autoBatch(overrides: Partial<ProfileSyncBatch>): ProfileSyncBatch {
      return {
        batchId: AUTO_BATCH,
        sourceHostId: SOURCE_HOST_ID,
        createdAt: 1,
        automatic: true,
        items: [
          {
            ...syncItem(1, DEST_HOST_ID, "synced", [
              previewDestination(DEST_HOST_ID, "automatic"),
            ]),
            preview: null,
          },
        ],
        ...overrides,
      };
    }

    async function openAutomatic(): Promise<void> {
      openSync(null);
      fireEvent.mouseDown(
        await screen.findByRole("tab", { name: /Automatic sync/ }),
        { button: 0 },
      );
    }

    it("offers View results for a rule only when its link resolves to a listed same-source automatic batch for its destination, and opens it", async () => {
      listBatches = [autoBatch({})];
      mount([{ ...SAVED_RULE, batchId: AUTO_BATCH }]);
      await openAutomatic();
      await screen.findByRole("heading", { name: "Linux box" });
      fireEvent.click(
        await screen.findByRole("button", { name: "View results" }),
      );
      expect(
        await screen.findByRole("button", { name: "← Back" }),
      ).toBeTruthy();
    });

    it.each([
      ["dangling", [] as ProfileSyncBatch[]],
      ["not automatic", [autoBatch({ automatic: false })]],
      [
        "another destination",
        [
          autoBatch({
            items: [
              {
                ...syncItem(1, DEST_HOST_TWO_ID, "synced", [
                  previewDestination(DEST_HOST_TWO_ID, "automatic"),
                ]),
                preview: null,
              },
            ],
          }),
        ],
      ],
      ["empty items", [autoBatch({ items: [] })]],
    ])("hides View results for a %s link", async (_label, batches) => {
      listBatches = batches;
      mount([{ ...SAVED_RULE, batchId: AUTO_BATCH }]);
      await openAutomatic();
      await screen.findByRole("heading", { name: "Linux box" });
      expect(screen.queryByRole("button", { name: "View results" })).toBeNull();
    });

    it("errors on a list holding another source's batch and shows no rules, results or foreign actions", async () => {
      const foreign = [autoBatch({ sourceHostId: "foreign-source-host" })];
      const rules = [{ ...SAVED_RULE, batchId: AUTO_BATCH }];
      // Wire-valid: only the captured-source check can refuse this list.
      expect(
        profileSyncListSchema.safeParse({ batches: foreign, rules }).success,
      ).toBe(true);
      listBatches = foreign;
      mount(rules);
      await openAutomatic();
      expect(
        await screen.findByText(/Couldn't reach Studio Mac right now/),
      ).toBeTruthy();
      for (const name of [
        "Edit",
        "Pause",
        "Stop…",
        "Add device",
        "View results",
      ])
        expect(screen.queryByRole("button", { name })).toBeNull();
      expect(screen.queryByRole("heading", { name: "Linux box" })).toBeNull();
    });

    function ruleSet(count: number): ProfileSyncRule[] {
      return Array.from({ length: count }, (_unused, index) => ({
        ...SAVED_RULE,
        ruleId: `00000000-0000-4000-8000-${String(index + 1000).padStart(12, "0")}`,
        destinationHostId: `rule-dest-${String(index)}`,
      }));
    }

    it("at 64 rules Add device is disabled with the explanation, and existing rules stay manageable", async () => {
      mount(ruleSet(64));
      await openAutomatic();
      expect(
        await screen.findByText(
          "Automatic sync supports up to 64 device rules. Stop a rule to add another device.",
        ),
      ).toBeTruthy();
      expect(
        screen
          .getByRole("button", { name: "Add device" })
          .hasAttribute("disabled"),
      ).toBe(true);
      expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(64);
      expect(screen.getAllByRole("button", { name: "Pause" })).toHaveLength(64);
      expect(screen.getAllByRole("button", { name: "Stop…" })).toHaveLength(64);
    });

    it("at 63 rules with an unused destination Add device is enabled and no capacity text shows", async () => {
      mount(ruleSet(63));
      await openAutomatic();
      await screen.findByText("Keep profiles in sync");
      expect(
        screen
          .getByRole("button", { name: "Add device" })
          .hasAttribute("disabled"),
      ).toBe(false);
      expect(screen.queryByText(/supports up to 64 device rules/)).toBeNull();
    });

    it("an open new-rule editor cannot save once the list reaches 64 rules", async () => {
      const messenger = mount(ruleSet(63));
      await openAutomatic();
      fireEvent.click(
        await screen.findByRole("button", { name: "Add device" }),
      );
      fireEvent.keyDown(
        await screen.findByRole("combobox", { name: "Destination device" }),
        { key: "ArrowDown" },
      );
      fireEvent.click(await screen.findByRole("option", { name: /Linux box/ }));
      const save = await screen.findByRole("button", {
        name: "Enable automatic sync",
      });
      expect(save.hasAttribute("disabled")).toBe(false);
      listRules = ruleSet(64);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      await waitFor(() =>
        expect(
          screen
            .getByRole("button", { name: "Enable automatic sync" })
            .hasAttribute("disabled"),
        ).toBe(true),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Enable automatic sync" }),
      );
      expect(
        messenger.calls.filter(
          (call) => call.method === "providers.profileCopy.sync.saveRule",
        ),
      ).toHaveLength(0);
    });

    it("refuses the whole rules view when any rule names another source", async () => {
      const rules = [
        SAVED_RULE,
        {
          ...SAVED_RULE,
          ruleId: "00000000-0000-4000-8000-0000000000d1",
          sourceHostId: DEST_HOST_ID,
          destinationHostId: DEST_HOST_TWO_ID,
        },
      ];
      expect(
        profileSyncListSchema.safeParse({ batches: [], rules }).success,
      ).toBe(true);
      const messenger = mount(rules);
      await openAutomatic();
      expect(
        await screen.findByText(/Couldn't reach Studio Mac right now/),
      ).toBeTruthy();
      for (const name of ["Edit", "Pause", "Stop…", "Add device"])
        expect(screen.queryByRole("button", { name })).toBeNull();
      expect(screen.queryByRole("heading", { name: "Linux box" })).toBeNull();
      // Nothing was written on the strength of a refused list.
      expect(
        messenger.calls.filter(
          (call) =>
            call.method === "providers.profileCopy.sync.saveRule" ||
            call.method === "providers.profileCopy.sync.stopRule",
        ),
      ).toHaveLength(0);
    });

    it("lists only the captured source's runs under Recent runs, and keeps them when a later list names another source", async () => {
      const local = [1, 2].map((minute): ProfileSyncBatch => ({
        batchId: `00000000-0000-4000-8000-00000000010${String(minute)}`,
        sourceHostId: SOURCE_HOST_ID,
        createdAt: minute * 60_000,
        automatic: false,
        items: [listedItem(DEST_HOST_ID)],
      }));
      listBatches = local;
      mount([]);
      openSync(null);
      await screen.findByText("Recent runs");
      expect(
        screen.getAllByRole("button", { name: /profile transfers/ }),
      ).toHaveLength(2);
      // A later list also carries a run of another source (wire-valid).
      listBatches = [
        ...local,
        {
          batchId: "00000000-0000-4000-8000-000000000199",
          sourceHostId: DEST_HOST_ID,
          createdAt: 9 * 60_000,
          automatic: false,
          // Belongs to another source, so its destination is a third device.
          items: [listedItem(DEST_HOST_TWO_ID)],
        },
      ];
      expect(
        profileSyncListSchema.safeParse({ batches: listBatches, rules: [] })
          .success,
      ).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(
        await screen.findByText(/Couldn't reach Studio Mac right now/),
      ).toBeTruthy();
      // The last valid local history is still what Recent runs shows.
      expect(
        screen.getAllByRole("button", { name: /profile transfers/ }),
      ).toHaveLength(2);
    });
  });

  describe("round 7: paused status and retry notices", () => {
    it("renders Paused for status paused even when the paused flag is false", async () => {
      mount([{ ...SAVED_RULE, paused: false, status: "paused" }]);
      openSync(null);
      fireEvent.mouseDown(
        await screen.findByRole("tab", { name: /Automatic sync/ }),
        { button: 0 },
      );
      await screen.findByRole("heading", { name: "Linux box" });
      expect(screen.getByText("Paused")).toBeTruthy();
    });

    const RETRY_OPERATION = "00000000-0000-4000-8000-000000000001";
    const STALE_TEXT = "This changed since you last looked. Review it again.";
    const UNAVAILABLE_TEXT =
      "Retry isn't possible right now. Linux box may be offline, a sign-in there may still be holding a shared resource, or this copy was cancelled.";

    function quarantined(
      attemptId: string,
      revision: number,
    ): ProfileCopyOutcome {
      return recordedOutcome({
        attempt: profileCopyAttempt({
          operationId: RETRY_OPERATION,
          attemptId,
        }),
        revision,
        state: "quarantined",
      });
    }

    async function openRetry(): Promise<MockHostMessenger<HostRpcRegistry>> {
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: () => [
          syncItem(1, DEST_HOST_ID, "ready", [
            previewDestination(DEST_HOST_ID, "automatic"),
          ]),
        ],
        startItems: () => [
          {
            ...syncItem(1, DEST_HOST_ID, "needs-action", []),
            preview: null,
            outcome: quarantined(ATTEMPT_ID, 3),
          },
        ],
      });
      openSync(null);
      await pickDestinations([/Linux box/]);
      await screen.findByText("1 profile transfers selected");
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
      return messenger;
    }

    function advanceList(): Promise<void> {
      return act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
    }

    it("keeps the stale notice while the attempt has not advanced past the response, and hides it on a later revision", async () => {
      retryResult = "stale-revision";
      retryOutcome = quarantined(ATTEMPT_ID, 3);
      await openRetry();
      expect(await screen.findByText(STALE_TEXT)).toBeTruthy();
      // A refetch of the same revision must not clear it.
      updateStarted = (batch) => ({
        ...batch,
        items: batch.items.map((entry) => ({
          ...entry,
          outcome: quarantined(ATTEMPT_ID, 3),
        })),
      });
      await advanceList();
      expect(screen.getByText(STALE_TEXT)).toBeTruthy();
      updateStarted = (batch) => ({
        ...batch,
        items: batch.items.map((entry) => ({
          ...entry,
          outcome: quarantined(ATTEMPT_ID, 4),
        })),
      });
      await advanceList();
      await waitFor(() => expect(screen.queryByText(STALE_TEXT)).toBeNull());
    });

    it("shows the unavailable notice and hides it once another attempt is displayed", async () => {
      retryResult = "unavailable";
      retryOutcome = quarantined(ATTEMPT_ID, 3);
      await openRetry();
      expect(await screen.findByText(UNAVAILABLE_TEXT)).toBeTruthy();
      updateStarted = (batch) => ({
        ...batch,
        items: batch.items.map((entry) => ({
          ...entry,
          outcome: quarantined(ATTEMPT_TWO_ID, 3),
        })),
      });
      await advanceList();
      await waitFor(() =>
        expect(screen.queryByText(UNAVAILABLE_TEXT)).toBeNull(),
      );
    });

    it("keeps the results open while a retry is in flight, then shows the stale notice, re-enables exits and reuses the retry request id", async () => {
      let release: () => void = () => undefined;
      retryGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      retryResult = "stale-revision";
      retryOutcome = quarantined(ATTEMPT_ID, 3);
      const messenger = await openRetry();
      const retryCalls = () =>
        messenger.calls.filter(
          (call) => call.method === "providers.profileCopy.retry",
        );
      try {
        await waitFor(() => expect(retryCalls()).toHaveLength(1));
        fireEvent.click(screen.getByRole("button", { name: "Done" }));
        fireEvent.click(screen.getByRole("button", { name: "← Back" }));
        fireEvent.keyDown(document.activeElement ?? document.body, {
          key: "Escape",
        });
        expect(useProfileCopyFlowStore.getState().view).not.toBeNull();
        expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "← Back" })).toBeTruthy();
      } finally {
        release();
      }
      expect(await screen.findByText(STALE_TEXT)).toBeTruthy();
      // Settled: the exits are available again and the notice stays.
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Done" }).hasAttribute("disabled"),
        ).toBe(false),
      );
      expect(screen.getByText(STALE_TEXT)).toBeTruthy();
      // The same unchanged attempt and revision retries under the same id.
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(retryCalls()).toHaveLength(2));
      const [first, second] = retryCalls().map((call) =>
        profileCopyRetryRequestSchema.parse(call.params),
      );
      expect(second.retryRequestId).toBe(first.retryRequestId);
    });

    it("shows no notice for a current retry", async () => {
      retryResult = "current";
      retryOutcome = quarantined(ATTEMPT_ID, 3);
      const messenger = await openRetry();
      await waitFor(() =>
        expect(
          messenger.calls.filter(
            (call) => call.method === "providers.profileCopy.retry",
          ).length,
        ).toBeGreaterThan(0),
      );
      expect(screen.queryByText(STALE_TEXT)).toBeNull();
      expect(screen.queryByText(UNAVAILABLE_TEXT)).toBeNull();
    });
  });

  describe("round 8: recent history and action errors", () => {
    const REACH_ERROR = /Couldn't reach Studio Mac right now/;

    function listed(minute: number, itemCount: number): ProfileSyncBatch {
      return {
        batchId: `00000000-0000-4000-8000-00000000${String(minute).padStart(4, "0")}`,
        sourceHostId: SOURCE_HOST_ID,
        createdAt: 1_700_000_000_000 + minute * 60_000,
        automatic: false,
        items: Array.from({ length: itemCount }, (_unused, index) => ({
          ...syncItem(index + 1, DEST_HOST_ID, "synced", [
            previewDestination(DEST_HOST_ID, "automatic"),
          ]),
          preview: null,
        })),
      };
    }

    it("picks the five newest NON-EMPTY runs, newest first", async () => {
      listBatches = [
        listed(1, 1),
        listed(2, 1),
        listed(3, 1),
        listed(4, 1),
        listed(5, 1),
        listed(6, 0),
        listed(7, 0),
        listed(8, 0),
      ];
      mount([]);
      openSync(null);
      await screen.findByText("Recent runs");
      const rows = screen
        .getAllByRole("button", { name: /profile transfers/ })
        .map((row) => row.textContent);
      expect(rows).toHaveLength(5);
      [5, 4, 3, 2, 1].forEach((minute, index) => {
        expect(rows[index]).toContain(
          new Date(1_700_000_000_000 + minute * 60_000).toLocaleString(),
        );
      });
    });

    it("hides the Recent runs heading when every listed run is empty", async () => {
      listBatches = [listed(1, 0), listed(2, 0)];
      mount([]);
      openSync(null);
      await screen.findByRole("checkbox", { name: /Linux box/ });
      await waitFor(() =>
        expect(
          screen.queryByText(/Loading profiles and sync history/),
        ).toBeNull(),
      );
      expect(screen.queryByText("Recent runs")).toBeNull();
    });

    function quarantinedAt(
      attemptId: string,
      revision: number,
    ): ProfileCopyOutcome {
      return recordedOutcome({
        attempt: profileCopyAttempt({
          operationId: "00000000-0000-4000-8000-000000000001",
          attemptId,
        }),
        revision,
        state: "quarantined",
      });
    }

    function actionItem(): ProfileSyncItem {
      return {
        ...syncItem(1, DEST_HOST_ID, "unconfirmed", []),
        preview: null,
        outcome: quarantinedAt(ATTEMPT_ID, 3),
      };
    }

    async function startWithActions(): Promise<void> {
      mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: () => [
          syncItem(1, DEST_HOST_ID, "ready", [
            previewDestination(DEST_HOST_ID, "automatic"),
          ]),
        ],
        startItems: () => [actionItem()],
      });
      openSync(null);
      await pickDestinations([/Linux box/]);
      await screen.findByText("1 profile transfers selected");
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    }

    function advanceTo(
      change: (item: ProfileSyncItem) => ProfileSyncItem,
    ): Promise<void> {
      updateStarted = (batch) => ({
        ...batch,
        items: batch.items.map(change),
      });
      return act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
    }

    const actions: ReadonlyArray<readonly [string, string, () => void]> = [
      [
        "Check status",
        "resolve",
        () => {
          resolveThrows = true;
        },
      ],
      [
        "Retry",
        "retry",
        () => {
          retryThrows = true;
        },
      ],
    ];
    const advances: ReadonlyArray<
      readonly [string, (item: ProfileSyncItem) => ProfileSyncItem]
    > = [
      [
        "a later revision",
        (item) => ({ ...item, outcome: quarantinedAt(ATTEMPT_ID, 4) }),
      ],
      [
        "a replacement attempt",
        (item) => ({ ...item, outcome: quarantinedAt(ATTEMPT_TWO_ID, 3) }),
      ],
      [
        "a state advance with the same outcome revision",
        (item) => ({ ...item, state: "synced" as const }),
      ],
    ];

    for (const [button, verb, fail] of actions) {
      it(`keeps a ${verb} transport error while the listed item is unchanged`, async () => {
        fail();
        await startWithActions();
        fireEvent.click(await screen.findByRole("button", { name: button }));
        expect(await screen.findByText(REACH_ERROR)).toBeTruthy();
        await advanceTo((item) => item);
        expect(screen.getByText(REACH_ERROR)).toBeTruthy();
      });

      for (const [label, change] of advances) {
        it(`clears a ${verb} transport error once the same operation shows ${label}`, async () => {
          fail();
          await startWithActions();
          fireEvent.click(await screen.findByRole("button", { name: button }));
          expect(await screen.findByText(REACH_ERROR)).toBeTruthy();
          await advanceTo(change);
          await waitFor(() =>
            expect(screen.queryByText(REACH_ERROR)).toBeNull(),
          );
        });
      }
    }
  });

  describe("round 9: listed rule control errors follow the polled rule", () => {
    const REACH_ERROR = /Couldn't reach Studio Mac right now/;

    async function openRules(): Promise<void> {
      mount([SAVED_RULE]);
      openSync(null);
      fireEvent.mouseDown(
        await screen.findByRole("tab", { name: /Automatic sync/ }),
        { button: 0 },
      );
      await screen.findByRole("heading", { name: "Linux box" });
    }

    function pollRules(rules: readonly ProfileSyncRule[]): Promise<void> {
      listRules = rules;
      return act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
    }

    it("keeps a Pause error at the same rule revision and hides it once a later revision is listed", async () => {
      saveRuleThrows = true;
      await openRules();
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      expect(await screen.findByText(REACH_ERROR)).toBeTruthy();
      await pollRules([SAVED_RULE]);
      expect(screen.getByText(REACH_ERROR)).toBeTruthy();
      await pollRules([
        { ...SAVED_RULE, paused: true, status: "paused", revision: 2 },
      ]);
      await waitFor(() => expect(screen.queryByText(REACH_ERROR)).toBeNull());
    });

    it("keeps a Stop error while the rule is listed unchanged and hides it once the rule is gone", async () => {
      stopRuleThrows = true;
      await openRules();
      fireEvent.click(screen.getByRole("button", { name: "Stop…" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Stop automatic sync" }),
      );
      expect(await screen.findByText(REACH_ERROR)).toBeTruthy();
      await pollRules([SAVED_RULE]);
      expect(screen.getByText(REACH_ERROR)).toBeTruthy();
      await pollRules([]);
      await waitFor(() => expect(screen.queryByText(REACH_ERROR)).toBeNull());
    });
  });

  describe("round 10: effective pause, editor drift and vanished runs", () => {
    const CHANGED_TEXT =
      "This rule changed while you were editing. Go back and reopen it to review the latest settings.";
    const STOPPED_TEXT = "This rule was stopped while you were editing.";

    function saveCalls(messenger: MockHostMessenger<HostRpcRegistry>) {
      return messenger.calls.filter(
        (call) => call.method === "providers.profileCopy.sync.saveRule",
      );
    }

    async function openAutomaticTab(): Promise<void> {
      openSync(null);
      fireEvent.mouseDown(
        await screen.findByRole("tab", { name: /Automatic sync/ }),
        { button: 0 },
      );
      await screen.findByRole("heading", { name: "Linux box" });
    }

    const pauseCases: ReadonlyArray<
      readonly [string, ProfileSyncRule, string, boolean]
    > = [
      [
        "an active rule",
        { ...SAVED_RULE, paused: false, status: "active" },
        "Pause",
        true,
      ],
      [
        "a rule with paused:true",
        { ...SAVED_RULE, paused: true, status: "paused" },
        "Resume",
        false,
      ],
      [
        "a rule with status paused but paused:false",
        { ...SAVED_RULE, paused: false, status: "paused" },
        "Resume",
        false,
      ],
    ];
    it.each(pauseCases)(
      "%s offers the effective action and saves the matching paused flag",
      async (_label, rule, button, expectedPaused) => {
        const messenger = mount([rule]);
        await openAutomaticTab();
        fireEvent.click(screen.getByRole("button", { name: button }));
        await waitFor(() => expect(saveCalls(messenger)).toHaveLength(1));
        const sent = profileSyncSaveRuleSchema.parse(
          saveCalls(messenger)[0].params,
        );
        expect(sent.paused).toBe(expectedPaused);
        expect(sent.expectedRevision).toBe(rule.revision);
      },
    );

    async function openEditorWithDraft(): Promise<
      MockHostMessenger<HostRpcRegistry>
    > {
      const messenger = mount([SAVED_RULE]);
      await openAutomaticTab();
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      // The user's draft: every provider instead of the saved codex-only scope.
      fireEvent.click(
        await screen.findByRole("checkbox", {
          name: /All supported providers/,
        }),
      );
      return messenger;
    }

    async function pollRulesNow(
      rules: readonly ProfileSyncRule[],
    ): Promise<void> {
      listRules = rules;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
    }

    it("keeps the draft but blocks Save when the open rule changed, and reopening saves against the latest revision", async () => {
      const messenger = await openEditorWithDraft();
      const latest: ProfileSyncRule = {
        ...SAVED_RULE,
        scope: { kind: "selected", providers: ["claude"] },
        paused: true,
        status: "paused",
        revision: 2,
      };
      await pollRulesNow([latest]);
      expect(await screen.findByText(CHANGED_TEXT)).toBeTruthy();
      expect(
        screen
          .getByRole("checkbox", { name: /All supported providers/ })
          .getAttribute("aria-checked"),
      ).toBe("true");
      const save = screen.getByRole("button", { name: "Save changes" });
      expect(save.hasAttribute("disabled")).toBe(true);
      fireEvent.click(save);
      expect(saveCalls(messenger)).toHaveLength(0);
      fireEvent.click(screen.getByRole("button", { name: "← Automatic sync" }));
      fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
      const trigger = await screen.findByRole("button", {
        name: "Choose providers",
      });
      expect(trigger.textContent).toMatch(/Claude/);
      expect(trigger.textContent).not.toMatch(/Codex/);
      const reopened = screen.getByRole("button", { name: "Save changes" });
      expect(reopened.hasAttribute("disabled")).toBe(false);
      fireEvent.click(reopened);
      await waitFor(() => expect(saveCalls(messenger)).toHaveLength(1));
      const sent = profileSyncSaveRuleSchema.parse(
        saveCalls(messenger)[0].params,
      );
      expect(sent.expectedRevision).toBe(2);
      expect(sent.paused).toBe(true);
      expect(sent.scope).toEqual({ kind: "selected", providers: ["claude"] });
    });

    it("says the rule was stopped, offers only Back, and never recreates it", async () => {
      const messenger = await openEditorWithDraft();
      await pollRulesNow([]);
      expect(await screen.findByText(STOPPED_TEXT)).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "← Automatic sync" }),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
      expect(saveCalls(messenger)).toHaveLength(0);
    });

    it("keeps the opened run when it leaves the bounded history, until the user goes Back to the preserved selection", async () => {
      listBatches = [
        {
          batchId: "00000000-0000-4000-8000-0000000000a9",
          sourceHostId: SOURCE_HOST_ID,
          createdAt: 1_700_000_000_000,
          automatic: false,
          items: [listedItem(DEST_HOST_ID)],
        },
      ];
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: () => [
          syncItem(1, DEST_HOST_ID, "ready", [
            previewDestination(DEST_HOST_ID, "automatic"),
          ]),
        ],
        startItems: noItems,
      });
      openSync(null);
      await pickDestinations([/Linux box/]);
      await screen.findByText("1 profile transfers selected");
      fireEvent.click(
        await screen.findByRole("button", { name: /profile transfers/ }),
      );
      expect(
        await screen.findByRole("button", { name: "← Back" }),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
      const previewsBefore = previewCalls(messenger).length;
      // Leaving the bounded list is omission, not deletion.
      listBatches = [];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(screen.getByRole("button", { name: "← Back" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
      // The selection is not previewed behind the viewed result.
      expect(previewCalls(messenger).length).toBe(previewsBefore);
      fireEvent.click(screen.getByRole("button", { name: "← Back" }));
      expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
      expect(
        screen
          .getByRole("checkbox", { name: /Linux box/ })
          .getAttribute("aria-checked"),
      ).toBe("true");
      expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      // The cached preview for the unchanged selection may be reused, so the
      // rendered state, not a new request, is what proves it resumed.
      await waitFor(() =>
        expect(
          screen
            .getByRole("button", { name: "Sync now" })
            .hasAttribute("disabled"),
        ).toBe(false),
      );
      expect(screen.getByText("1 profile transfers selected")).toBeTruthy();
    });
  });

  describe("round 11: reordered choices are the same selection", () => {
    it("keeps the batch id of an uncertain start when the same providers and devices are re-picked in another order", async () => {
      startFailures = 1;
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: () => [
          syncItem(1, DEST_HOST_ID, "ready", [
            previewDestination(DEST_HOST_ID, "automatic"),
          ]),
        ],
        startItems: noItems,
      });
      openSync(null);
      await pickDestinations([/Linux box/, /Old Mac/]);
      await screen.findByText("1 profile transfers selected");
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      expect(await screen.findByText(/could not be confirmed/)).toBeTruthy();
      // Reorder the devices: take Linux box out and put it back after Old Mac.
      fireEvent.click(screen.getByRole("checkbox", { name: /Linux box/ }));
      fireEvent.click(screen.getByRole("checkbox", { name: /Linux box/ }));
      // Reorder the providers the same way.
      fireEvent.click(screen.getByRole("button", { name: "Choose providers" }));
      fireEvent.click(await screen.findByRole("option", { name: /Claude/ }));
      fireEvent.click(await screen.findByRole("option", { name: /Claude/ }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(await screen.findByText(/could not be confirmed/)).toBeTruthy();
      await waitFor(() =>
        expect(
          screen
            .getByRole("button", { name: "Sync now" })
            .hasAttribute("disabled"),
        ).toBe(false),
      );
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      await waitFor(() => expect(startCalls(messenger)).toHaveLength(2));
      const [firstCall, secondCall] = startCalls(messenger);
      const first = profileSyncStartSchema.parse(firstCall.params);
      const second = profileSyncStartSchema.parse(secondCall.params);
      expect(second.selection).toEqual(first.selection);
      expect(second.batchId).toBe(first.batchId);
      // The wire form is canonical, whatever order the user picked in.
      expect(first.selection.destinationHostIds).toEqual(
        [...first.selection.destinationHostIds].sort(),
      );
      if (first.selection.scope.kind === "selected")
        expect(first.selection.scope.providers).toEqual(
          [...first.selection.scope.providers].sort(),
        );
    });
  });

  describe("round 17: rule editor in flight, error scope and catalog scope", () => {
    const REACH_ERROR = /Couldn't reach Studio Mac right now/;

    function saveCalls(messenger: MockHostMessenger<HostRpcRegistry>) {
      return messenger.calls.filter(
        (call) => call.method === "providers.profileCopy.sync.saveRule",
      );
    }

    async function openAutomaticTab(): Promise<void> {
      openSync(null);
      fireEvent.mouseDown(
        await screen.findByRole("tab", { name: /Automatic sync/ }),
        { button: 0 },
      );
      await screen.findByRole("button", { name: "Add device" });
    }

    async function chooseDestination(name: RegExp): Promise<void> {
      fireEvent.keyDown(
        await screen.findByRole("combobox", { name: "Destination device" }),
        { key: "ArrowDown" },
      );
      fireEvent.click(await screen.findByRole("option", { name }));
    }

    async function openNewRuleEditor(): Promise<void> {
      await openAutomaticTab();
      fireEvent.click(screen.getByRole("button", { name: "Add device" }));
      await chooseDestination(/Linux box/);
    }

    // Every way out of the dialog a user can try: a tab, Done, Escape.
    function attemptExits(): void {
      fireEvent.mouseDown(screen.getByRole("tab", { name: /Sync now/ }), {
        button: 0,
      });
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: "Escape",
      });
    }

    function expectEditorHeld(): void {
      expect(useProfileCopyFlowStore.getState().view).not.toBeNull();
      expect(
        screen.getByRole("button", { name: "Enable automatic sync" }),
      ).toBeTruthy();
      expect(
        screen.getByRole("combobox", { name: "Destination device" }),
      ).toBeTruthy();
    }

    it("keeps the draft through every exit attempt, and shows the inline error when the held save is rejected", async () => {
      let release: () => void = () => undefined;
      saveRuleGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const messenger = mount([]);
      try {
        await openNewRuleEditor();
        fireEvent.click(
          await screen.findByRole("button", { name: "Enable automatic sync" }),
        );
        await waitFor(() => expect(saveCalls(messenger)).toHaveLength(1));
        attemptExits();
        expectEditorHeld();
        // While the request is pending there is no way to dismiss the dialog.
        expect(screen.queryByRole("button", { name: /^close$/i })).toBeNull();
        saveRuleThrows = true;
      } finally {
        release();
      }
      expect(await screen.findByText(REACH_ERROR)).toBeTruthy();
      expectEditorHeld();
      // Settled: the dialog may be dismissed again.
      expect(screen.getByRole("button", { name: /^close$/i })).toBeTruthy();
    });

    it("holds every editor control while a save is in flight, and frees the editor once it lands", async () => {
      let release: () => void = () => undefined;
      saveRuleGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const messenger = mount([]);
      try {
        await openNewRuleEditor();
        fireEvent.click(
          await screen.findByRole("button", { name: "Enable automatic sync" }),
        );
        await waitFor(() => expect(saveCalls(messenger)).toHaveLength(1));
        const disabled = (element: HTMLElement): boolean =>
          element.hasAttribute("disabled") ||
          element.getAttribute("aria-disabled") === "true" ||
          element.hasAttribute("data-disabled");
        expect(disabled(screen.getByRole("button", { name: "Cancel" }))).toBe(
          true,
        );
        expect(
          disabled(screen.getByRole("button", { name: "← Automatic sync" })),
        ).toBe(true);
        expect(
          disabled(
            screen.getByRole("combobox", { name: "Destination device" }),
          ),
        ).toBe(true);
        expect(
          disabled(
            screen.getByRole("checkbox", { name: /All supported providers/ }),
          ),
        ).toBe(true);
        expect(
          disabled(screen.getByRole("button", { name: "Choose providers" })),
        ).toBe(true);
      } finally {
        release();
      }
      // The save lands and the editor closes.
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: "Enable automatic sync" }),
        ).toBeNull(),
      );
    });

    it("scopes a failed save's error to the exact submitted draft", async () => {
      saveRuleThrows = true;
      mount([]);
      await openNewRuleEditor();
      fireEvent.click(
        await screen.findByRole("button", { name: "Enable automatic sync" }),
      );
      expect(await screen.findByText(REACH_ERROR)).toBeTruthy();
      // Another destination is another draft: the old error is not its error.
      await chooseDestination(/Old Mac/);
      await waitFor(() => expect(screen.queryByText(REACH_ERROR)).toBeNull());
      // Back on the submitted draft it speaks for it again.
      await chooseDestination(/Linux box/);
      expect(await screen.findByText(REACH_ERROR)).toBeTruthy();
      // Another scope is another draft too.
      const all = screen.getByRole("checkbox", {
        name: /All supported providers/,
      });
      fireEvent.click(all);
      await waitFor(() => expect(screen.queryByText(REACH_ERROR)).toBeNull());
      fireEvent.click(all);
      expect(await screen.findByText(REACH_ERROR)).toBeTruthy();
    });

    describe("converting a rule's scope to a chosen list", () => {
      const claudeOnly = (): readonly ProviderCliState[] => [
        claudeProviderState([managedProfile(SOURCE_PROFILE_ID, "Work")]),
      ];

      async function saveEditedRule(
        rule: ProfileSyncRule,
        uncheckAll: boolean,
      ): Promise<ProfileSyncSaveRule> {
        const messenger = mountWith({
          rules: [rule],
          providers: claudeOnly(),
          previewItems: noItems,
          startItems: noItems,
        });
        await openAutomaticTab();
        fireEvent.click(screen.getByRole("button", { name: "Edit" }));
        if (uncheckAll)
          fireEvent.click(
            await screen.findByRole("checkbox", {
              name: /All supported providers/,
            }),
          );
        fireEvent.click(
          await screen.findByRole("button", { name: "Save changes" }),
        );
        await waitFor(() => expect(saveCalls(messenger)).toHaveLength(1));
        return profileSyncSaveRuleSchema.parse(saveCalls(messenger)[0].params);
      }

      it("saves only the catalog's providers when an all-providers rule becomes a chosen list", async () => {
        const sent = await saveEditedRule(
          { ...SAVED_RULE, scope: { kind: "all" } },
          true,
        );
        expect(sent.scope).toEqual({ kind: "selected", providers: ["claude"] });
      });

      it("keeps a saved chosen list's providers even when the catalog lacks them", async () => {
        const sent = await saveEditedRule(
          {
            ...SAVED_RULE,
            scope: { kind: "selected", providers: ["claude", "codex"] },
          },
          false,
        );
        expect(sent.scope).toEqual({
          kind: "selected",
          providers: ["claude", "codex"],
        });
      });
    });
  });

  describe("round 18: Cancel and Keep rule cannot close over an active request", () => {
    function gate(): { promise: Promise<void>; release: () => void } {
      let release: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    }

    it("disables the footer Cancel while the start is in flight, so it cannot dismiss a running request", async () => {
      const held = gate();
      startGate = held.promise;
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: () => [
          syncItem(1, DEST_HOST_ID, "ready", [
            previewDestination(DEST_HOST_ID, "automatic"),
          ]),
        ],
        startItems: noItems,
      });
      try {
        openSync(null);
        await pickDestinations([/Linux box/]);
        await screen.findByText("1 profile transfers selected");
        fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
        await waitFor(() => expect(startCalls(messenger)).toHaveLength(1));
        const cancel = screen.getByRole("button", { name: "Cancel" });
        expect(cancel.hasAttribute("disabled")).toBe(true);
        fireEvent.click(cancel);
        expect(useProfileCopyFlowStore.getState().view).not.toBeNull();
        expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
        // The tabs are held too: Automatic sync cannot be opened mid-start.
        fireEvent.mouseDown(
          screen.getByRole("tab", { name: /Automatic sync/ }),
          { button: 0 },
        );
        expect(
          screen
            .getByRole("tab", { name: /Sync now/ })
            .getAttribute("aria-selected"),
        ).toBe("true");
        fireEvent.keyDown(document.activeElement ?? document.body, {
          key: "Escape",
        });
        expect(useProfileCopyFlowStore.getState().view).not.toBeNull();
      } finally {
        held.release();
      }
    });

    describe.each([
      ["Pause", "save"],
      ["Stop", "stop"],
    ] as const)("%s in flight", (_action, which) => {
      it("holds View results, so the pending observer stays mounted until settlement", async () => {
        const held = gate();
        if (which === "save") saveRuleGate = held.promise;
        else stopRuleGate = held.promise;
        const RUN = "00000000-0000-4000-8000-0000000000d1";
        listBatches = [
          {
            batchId: RUN,
            sourceHostId: SOURCE_HOST_ID,
            createdAt: 1_700_000_000_000,
            automatic: true,
            items: [listedItem(DEST_HOST_ID)],
          },
        ];
        mount([{ ...SAVED_RULE, batchId: RUN }]);
        try {
          openSync(null);
          fireEvent.mouseDown(
            await screen.findByRole("tab", { name: /Automatic sync/ }),
            { button: 0 },
          );
          await screen.findByRole("heading", { name: "Linux box" });
          if (which === "save") {
            fireEvent.click(screen.getByRole("button", { name: "Pause" }));
          } else {
            fireEvent.click(screen.getByRole("button", { name: "Stop…" }));
            fireEvent.click(
              await screen.findByRole("button", {
                name: "Stop automatic sync",
              }),
            );
          }
          const view = await screen.findByRole("button", {
            name: "View results",
          });
          await waitFor(() => expect(view.hasAttribute("disabled")).toBe(true));
          fireEvent.click(view);
          // Still the automatic list, with the pending control's UI intact.
          expect(
            screen.getByRole("heading", { name: "Linux box" }),
          ).toBeTruthy();
          expect(
            screen.getByRole("button", { name: "View results" }),
          ).toBeTruthy();
          if (which === "stop")
            expect(screen.getByText(/Stop future updates\?/)).toBeTruthy();
        } finally {
          held.release();
        }
      });
    });

    it("disables Keep rule while the stop is in flight, so the confirmation cannot be dismissed as if nothing happens", async () => {
      const held = gate();
      stopRuleGate = held.promise;
      mount([SAVED_RULE]);
      try {
        openSync(null);
        fireEvent.mouseDown(
          await screen.findByRole("tab", { name: /Automatic sync/ }),
          { button: 0 },
        );
        await screen.findByRole("heading", { name: "Linux box" });
        fireEvent.click(screen.getByRole("button", { name: "Stop…" }));
        fireEvent.click(
          await screen.findByRole("button", { name: "Stop automatic sync" }),
        );
        const keep = await screen.findByRole("button", { name: "Keep rule" });
        await waitFor(() => expect(keep.hasAttribute("disabled")).toBe(true));
        fireEvent.click(keep);
        // The confirmation is still up: the stop has not been abandoned.
        expect(screen.getByText(/Stop future updates\?/)).toBeTruthy();
        // No other exit while the stop is pending: not the tab, Done or Escape.
        fireEvent.mouseDown(screen.getByRole("tab", { name: /Sync now/ }), {
          button: 0,
        });
        fireEvent.click(screen.getByRole("button", { name: "Done" }));
        fireEvent.keyDown(document.activeElement ?? document.body, {
          key: "Escape",
        });
        expect(useProfileCopyFlowStore.getState().view).not.toBeNull();
        expect(
          screen
            .getByRole("tab", { name: /Automatic sync/ })
            .getAttribute("aria-selected"),
        ).toBe("true");
        expect(screen.getByText(/Stop future updates\?/)).toBeTruthy();
      } finally {
        held.release();
      }
    });
  });

  describe("round 19: pending guards across rule controls, result actions and receipts", () => {
    function gate(): { promise: Promise<void>; release: () => void } {
      let release: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    }

    function callsOf(
      messenger: MockHostMessenger<HostRpcRegistry>,
      method: string,
    ) {
      return messenger.calls.filter((call) => call.method === method);
    }

    const isDisabled = (name: string | RegExp): boolean =>
      screen.getByRole("button", { name }).hasAttribute("disabled");

    describe("rule list while a save or stop is pending", () => {
      const RUN = "00000000-0000-4000-8000-0000000000d2";

      async function openRuleList(): Promise<
        MockHostMessenger<HostRpcRegistry>
      > {
        listBatches = [
          {
            batchId: RUN,
            sourceHostId: SOURCE_HOST_ID,
            createdAt: 1_700_000_000_000,
            automatic: true,
            items: [listedItem(DEST_HOST_ID)],
          },
        ];
        const messenger = mount([{ ...SAVED_RULE, batchId: RUN }]);
        openSync(null);
        fireEvent.mouseDown(
          await screen.findByRole("tab", { name: /Automatic sync/ }),
          { button: 0 },
        );
        await screen.findByRole("heading", { name: "Linux box" });
        return messenger;
      }

      function expectNoNewCommand(
        messenger: MockHostMessenger<HostRpcRegistry>,
        saveCount: number,
        stopCount: number,
      ): void {
        expect(
          callsOf(messenger, "providers.profileCopy.sync.saveRule"),
        ).toHaveLength(saveCount);
        expect(
          callsOf(messenger, "providers.profileCopy.sync.stopRule"),
        ).toHaveLength(stopCount);
        // No editor was opened by a click on a held control.
        expect(
          screen.queryByRole("button", { name: "Save changes" }),
        ).toBeNull();
        expect(
          screen.queryByRole("button", { name: "Enable automatic sync" }),
        ).toBeNull();
      }

      it("holds every control while a Pause is pending, and a click on any of them starts nothing", async () => {
        const held = gate();
        saveRuleGate = held.promise;
        const messenger = await openRuleList();
        try {
          fireEvent.click(screen.getByRole("button", { name: "Pause" }));
          await waitFor(() =>
            expect(
              callsOf(messenger, "providers.profileCopy.sync.saveRule"),
            ).toHaveLength(1),
          );
          for (const name of [
            "Edit",
            "Pause",
            "Stop…",
            "Add device",
            "View results",
          ])
            await waitFor(() => expect(isDisabled(name)).toBe(true));
          for (const name of ["Edit", "Pause", "Stop…", "Add device"])
            fireEvent.click(screen.getByRole("button", { name }));
          expectNoNewCommand(messenger, 1, 0);
        } finally {
          held.release();
        }
      });

      it("holds every control while a Stop is pending, including Keep rule and the confirmation", async () => {
        const held = gate();
        stopRuleGate = held.promise;
        const messenger = await openRuleList();
        try {
          fireEvent.click(screen.getByRole("button", { name: "Stop…" }));
          fireEvent.click(
            await screen.findByRole("button", { name: "Stop automatic sync" }),
          );
          await waitFor(() =>
            expect(
              callsOf(messenger, "providers.profileCopy.sync.stopRule"),
            ).toHaveLength(1),
          );
          for (const name of [
            "Edit",
            "Pause",
            "Stop…",
            "Add device",
            "View results",
            "Keep rule",
            "Stop automatic sync",
          ])
            await waitFor(() => expect(isDisabled(name)).toBe(true));
          for (const name of [
            "Edit",
            "Pause",
            "Add device",
            "Stop automatic sync",
          ])
            fireEvent.click(screen.getByRole("button", { name }));
          expectNoNewCommand(messenger, 0, 1);
          expect(screen.getByText(/Stop future updates\?/)).toBeTruthy();
        } finally {
          held.release();
        }
      });
    });

    it("shows the pending spinner only on the target rule's Pause, and holds every control on the other rule", async () => {
      const held = gate();
      saveRuleGate = held.promise;
      const OTHER_RULE: ProfileSyncRule = {
        ...SAVED_RULE,
        ruleId: "99999999-9999-4999-8999-99999999999a",
        destinationHostId: DEST_HOST_TWO_ID,
      };
      const messenger = mount([SAVED_RULE, OTHER_RULE]);
      try {
        openSync(null);
        fireEvent.mouseDown(
          await screen.findByRole("tab", { name: /Automatic sync/ }),
          { button: 0 },
        );
        const articleFor = (name: string): HTMLElement => {
          const article = screen
            .getByRole("heading", { name })
            .closest("article");
          if (article === null) throw new Error(`no rule card for ${name}`);
          return article;
        };
        await screen.findByRole("heading", { name: "Old Mac" });
        const target = articleFor("Linux box");
        const other = articleFor("Old Mac");
        fireEvent.click(within(target).getByRole("button", { name: "Pause" }));
        await waitFor(() =>
          expect(
            callsOf(messenger, "providers.profileCopy.sync.saveRule"),
          ).toHaveLength(1),
        );
        const spinnersIn = (root: HTMLElement): number =>
          Array.from(root.querySelectorAll('[aria-hidden="true"]')).filter(
            (node) => node.classList.contains("font-mono"),
          ).length;
        await waitFor(() => expect(spinnersIn(target)).toBe(1));
        expect(
          spinnersIn(within(target).getByRole("button", { name: "Pause" })),
        ).toBe(1);
        expect(spinnersIn(other)).toBe(0);
        for (const name of ["Edit", "Pause", "Stop…"])
          expect(
            within(other)
              .getByRole("button", { name })
              .hasAttribute("disabled"),
          ).toBe(true);
      } finally {
        held.release();
      }
    });

    describe("result actions on a retryable receipt", () => {
      const retryableItem = (): ProfileSyncItem => ({
        ...syncItem(1, DEST_HOST_ID, "unavailable", []),
        preview: null,
        outcome: profileCopyOutcome({
          attempt: profileCopyAttempt({
            operationId: "00000000-0000-4000-8000-000000000001",
          }),
          state: "blocked",
          reason: "unreachable",
        }),
      });

      async function startWith(
        item: ProfileSyncItem,
      ): Promise<MockHostMessenger<HostRpcRegistry>> {
        const messenger = mountWith({
          rules: [],
          providers: defaultProviders(),
          previewItems: () => [
            syncItem(1, DEST_HOST_ID, "ready", [
              previewDestination(DEST_HOST_ID, "automatic"),
            ]),
          ],
          startItems: () => [item],
        });
        openSync(null);
        await pickDestinations([/Linux box/]);
        await screen.findByText("1 profile transfers selected");
        fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
        await screen.findByRole("button", { name: "Check status" });
        return messenger;
      }

      it("offers Check status and Retry together, and a pending Check status holds both", async () => {
        const held = gate();
        resolveGate = held.promise;
        const messenger = await startWith(retryableItem());
        expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
        try {
          fireEvent.click(screen.getByRole("button", { name: "Check status" }));
          await waitFor(() =>
            expect(
              callsOf(messenger, "providers.profileCopy.sync.resolve"),
            ).toHaveLength(1),
          );
          await waitFor(() => expect(isDisabled("Retry")).toBe(true));
          expect(isDisabled("Check status")).toBe(true);
          fireEvent.click(screen.getByRole("button", { name: "Retry" }));
          expect(
            callsOf(messenger, "providers.profileCopy.retry"),
          ).toHaveLength(0);
        } finally {
          held.release();
        }
      });

      it("holds Check status while a Retry is pending", async () => {
        const held = gate();
        retryGate = held.promise;
        const messenger = await startWith(retryableItem());
        try {
          fireEvent.click(screen.getByRole("button", { name: "Retry" }));
          await waitFor(() =>
            expect(
              callsOf(messenger, "providers.profileCopy.retry"),
            ).toHaveLength(1),
          );
          await waitFor(() => expect(isDisabled("Check status")).toBe(true));
          expect(isDisabled("Retry")).toBe(true);
          fireEvent.click(screen.getByRole("button", { name: "Check status" }));
          expect(
            callsOf(messenger, "providers.profileCopy.sync.resolve"),
          ).toHaveLength(0);
        } finally {
          held.release();
        }
      });

      it("does not offer an actionable retry once the source account changed", async () => {
        await startWith({ ...retryableItem(), identityChanged: true });
        const retry = screen.queryByRole("button", { name: "Retry" });
        expect(retry === null || retry.hasAttribute("disabled")).toBe(true);
      });
    });

    describe("conflict on a changed source account", () => {
      const conflictItem = (): ProfileSyncItem => ({
        ...syncItem(1, DEST_HOST_ID, "conflict", []),
        preview: null,
        identityChanged: true,
        destinationSettings: {
          name: "Edited on destination",
          color: "#10b981",
          enabled: true,
        },
      });

      it("offers no actionable Use source settings, while Keep destination & pause stays safe", async () => {
        const messenger = mountWith({
          rules: [],
          providers: defaultProviders(),
          previewItems: () => [
            syncItem(1, DEST_HOST_ID, "ready", [
              previewDestination(DEST_HOST_ID, "automatic"),
            ]),
          ],
          startItems: () => [conflictItem()],
        });
        openSync(null);
        await pickDestinations([/Linux box/]);
        await screen.findByText("1 profile transfers selected");
        fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
        fireEvent.click(await screen.findByRole("button", { name: "Review…" }));
        const useSource = screen.queryByRole("button", {
          name: "Use source settings",
        });
        expect(useSource === null || useSource.hasAttribute("disabled")).toBe(
          true,
        );
        if (useSource !== null) fireEvent.click(useSource);
        expect(
          callsOf(messenger, "providers.profileCopy.sync.resolve"),
        ).toHaveLength(0);
        const keep = screen.getByRole("button", {
          name: "Keep destination & pause",
        });
        expect(keep.hasAttribute("disabled")).toBe(false);
        fireEvent.click(keep);
        await waitFor(() =>
          expect(
            callsOf(messenger, "providers.profileCopy.sync.resolve"),
          ).toHaveLength(1),
        );
      });
    });

    describe("receipt review", () => {
      async function reviewReceipt(
        outcome: ProfileCopyOutcome,
        state: ProfileSyncItem["state"],
      ): Promise<MockHostMessenger<HostRpcRegistry>> {
        const messenger = mountWith({
          rules: [],
          providers: defaultProviders(),
          previewItems: () => [
            syncItem(1, DEST_HOST_ID, "ready", [
              previewDestination(DEST_HOST_ID, "automatic"),
            ]),
          ],
          startItems: () => [
            {
              ...syncItem(1, DEST_HOST_ID, state, []),
              preview: null,
              outcome,
            },
          ],
        });
        openSync(null);
        await pickDestinations([/Linux box/]);
        await screen.findByText("1 profile transfers selected");
        fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
        fireEvent.click(await screen.findByRole("button", { name: "Review…" }));
        return messenger;
      }

      const draftStatusCalls = (
        messenger: MockHostMessenger<HostRpcRegistry>,
      ) => callsOf(messenger, "providers.profileCopy.draftStatus");

      it("shows a source-local needs-action receipt without asking the destination for a draft", async () => {
        const messenger = await reviewReceipt(
          profileCopyOutcome({
            attempt: profileCopyAttempt({
              operationId: "00000000-0000-4000-8000-000000000001",
            }),
            state: "blocked",
            reason: "unreachable",
            targetProfileId: null,
          }),
          "needs-action",
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
        expect(
          screen.getByRole("button", { name: "Hide details" }),
        ).toBeTruthy();
        expect(screen.getByText("Not sent")).toBeTruthy();
        expect(screen.getByText(/^Nothing was sent\./)).toBeTruthy();
        expect(draftStatusCalls(messenger)).toHaveLength(0);
      });

      it("still mounts the draft for a receipt the destination recorded", async () => {
        const messenger = await reviewReceipt(
          recordedOutcome({
            attempt: profileCopyAttempt({
              operationId: "00000000-0000-4000-8000-000000000001",
            }),
            state: "sign-in-required",
          }),
          "needs-action",
        );
        await waitFor(() =>
          expect(draftStatusCalls(messenger).length).toBeGreaterThan(0),
        );
      });
    });
  });

  describe("round 20: vanished rules and runs, foreign operations and recovery gating", () => {
    const REACH_ERROR = /Couldn't reach Studio Mac right now/;
    const STALE_TEXT = "This changed since you last looked. Review it again.";

    function gate(): { promise: Promise<void>; release: () => void } {
      let release: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    }

    function callsOf(
      messenger: MockHostMessenger<HostRpcRegistry>,
      method: string,
    ) {
      return messenger.calls.filter((call) => call.method === method);
    }

    const retryableReceipt = (): ProfileCopyOutcome =>
      profileCopyOutcome({
        attempt: profileCopyAttempt({
          operationId: "00000000-0000-4000-8000-000000000001",
        }),
        state: "blocked",
        reason: "unreachable",
      });

    function receiptItem(state: ProfileSyncItem["state"]): ProfileSyncItem {
      return {
        ...syncItem(1, DEST_HOST_ID, state, []),
        preview: null,
        outcome: retryableReceipt(),
        destinationSettings:
          state === "conflict"
            ? { name: "Edited", color: "#10b981", enabled: true }
            : null,
      };
    }

    async function startShowing(
      items: () => readonly ProfileSyncItem[],
    ): Promise<MockHostMessenger<HostRpcRegistry>> {
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: () => [
          syncItem(1, DEST_HOST_ID, "ready", [
            previewDestination(DEST_HOST_ID, "automatic"),
          ]),
        ],
        startItems: items,
      });
      openSync(null);
      await pickDestinations([/Linux box/]);
      await screen.findByText("1 profile transfers selected");
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      return messenger;
    }

    it("keeps an existing rule's editor, draft and error when the rule vanishes during a held save", async () => {
      const held = gate();
      saveRuleGate = held.promise;
      const messenger = mount([SAVED_RULE]);
      try {
        openSync(null);
        fireEvent.mouseDown(
          await screen.findByRole("tab", { name: /Automatic sync/ }),
          { button: 0 },
        );
        await screen.findByRole("heading", { name: "Linux box" });
        fireEvent.click(screen.getByRole("button", { name: "Edit" }));
        fireEvent.click(
          await screen.findByRole("checkbox", {
            name: /All supported providers/,
          }),
        );
        fireEvent.click(
          await screen.findByRole("button", { name: "Save changes" }),
        );
        await waitFor(() =>
          expect(
            callsOf(messenger, "providers.profileCopy.sync.saveRule"),
          ).toHaveLength(1),
        );
        // The rule leaves the list while the save is still in flight.
        listRules = [];
        await act(async () => {
          await vi.advanceTimersByTimeAsync(6_000);
        });
        const back = screen.getByRole("button", { name: "← Automatic sync" });
        expect(back.hasAttribute("disabled")).toBe(true);
        expect(
          screen
            .getByRole("checkbox", { name: /All supported providers/ })
            .getAttribute("aria-checked"),
        ).toBe("true");
        saveRuleThrows = true;
      } finally {
        held.release();
      }
      expect(await screen.findByText(REACH_ERROR)).toBeTruthy();
      expect(
        screen
          .getByRole("checkbox", { name: /All supported providers/ })
          .getAttribute("aria-checked"),
      ).toBe("true");
      await waitFor(() =>
        expect(
          screen
            .getByRole("button", { name: "← Automatic sync" })
            .hasAttribute("disabled"),
        ).toBe(false),
      );
    });

    describe.each([
      ["Check status", "resolve"],
      ["Retry", "retry"],
    ] as const)(
      "%s on a viewed run that leaves the history",
      (button, which) => {
        it("blocks a new start while it is held and keeps the viewed run mounted after release", async () => {
          const held = gate();
          if (which === "resolve") resolveGate = held.promise;
          else {
            retryGate = held.promise;
            retryResult = "stale-revision";
            retryOutcome = retryableReceipt();
          }
          const RUN = "00000000-0000-4000-8000-0000000000e1";
          listBatches = [
            {
              batchId: RUN,
              sourceHostId: SOURCE_HOST_ID,
              createdAt: 1_700_000_000_000,
              automatic: false,
              items: [receiptItem("unavailable")],
            },
          ];
          const messenger = mountWith({
            rules: [],
            providers: defaultProviders(),
            previewItems: () => [
              syncItem(1, DEST_HOST_ID, "ready", [
                previewDestination(DEST_HOST_ID, "automatic"),
              ]),
            ],
            startItems: noItems,
          });
          try {
            openSync(null);
            fireEvent.click(
              await screen.findByRole("button", { name: /profile transfers/ }),
            );
            fireEvent.click(
              await screen.findByRole("button", { name: button }),
            );
            await waitFor(() =>
              expect(
                callsOf(
                  messenger,
                  which === "resolve"
                    ? "providers.profileCopy.sync.resolve"
                    : "providers.profileCopy.retry",
                ),
              ).toHaveLength(1),
            );
            // The run leaves the history while the action is in flight.
            listBatches = [];
            await act(async () => {
              await vi.advanceTimersByTimeAsync(6_000);
            });
            const sync = screen.queryByRole("button", { name: "Sync now" });
            expect(sync === null || sync.hasAttribute("disabled")).toBe(true);
            if (sync !== null) fireEvent.click(sync);
            expect(startCalls(messenger)).toHaveLength(0);
            expect(screen.getByRole("button", { name: "← Back" })).toBeTruthy();
          } finally {
            held.release();
          }
          // Settled: the viewed run is still there until the user goes Back.
          await waitFor(() =>
            expect(screen.getByRole("button", { name: "← Back" })).toBeTruthy(),
          );
          if (which === "retry")
            expect(await screen.findByText(STALE_TEXT)).toBeTruthy();
          expect(startCalls(messenger)).toHaveLength(0);
        });
      },
    );

    it.each(["history", "started"] as const)(
      "keeps the newer polled receipt, not the opening snapshot, when a %s run later leaves the history mid-retry",
      async (origin) => {
        const held = gate();
        retryGate = held.promise;
        retryResult = "stale-revision";
        const receiptAt = (attemptId: string): ProfileCopyOutcome =>
          profileCopyOutcome({
            attempt: profileCopyAttempt({
              operationId: "00000000-0000-4000-8000-000000000001",
              attemptId,
            }),
            revision: 3,
            state: "blocked",
            reason: "unreachable",
          });
        const itemAt = (attemptId: string): ProfileSyncItem => ({
          ...syncItem(1, DEST_HOST_ID, "unavailable", []),
          preview: null,
          outcome: receiptAt(attemptId),
        });
        const batchAt = (attemptId: string): ProfileSyncBatch => ({
          batchId: "00000000-0000-4000-8000-0000000000e2",
          sourceHostId: SOURCE_HOST_ID,
          createdAt: 1_700_000_000_000,
          automatic: false,
          items: [itemAt(attemptId)],
        });
        retryOutcome = receiptAt(ATTEMPT_TWO_ID);
        if (origin === "history") listBatches = [batchAt(ATTEMPT_ID)];
        const messenger = mountWith({
          rules: [],
          providers: defaultProviders(),
          previewItems: () => [
            syncItem(1, DEST_HOST_ID, "ready", [
              previewDestination(DEST_HOST_ID, "automatic"),
            ]),
          ],
          startItems:
            origin === "started" ? () => [itemAt(ATTEMPT_ID)] : noItems,
        });
        // Where the receipt advances and where the run is later omitted from.
        const advance = (): void => {
          if (origin === "history") listBatches = [batchAt(ATTEMPT_TWO_ID)];
          else
            updateStarted = (batch) => ({
              ...batch,
              items: batch.items.map((entry) => ({
                ...entry,
                outcome: receiptAt(ATTEMPT_TWO_ID),
              })),
            });
        };
        const omit = (): void => {
          // The harness relists a started run through updateStarted, so
          // clearing it is what omits that run from the history.
          if (origin === "history") listBatches = [];
          else updateStarted = null;
        };
        try {
          openSync(null);
          if (origin === "history") {
            fireEvent.click(
              await screen.findByRole("button", { name: /profile transfers/ }),
            );
          } else {
            await pickDestinations([/Linux box/]);
            await screen.findByText("1 profile transfers selected");
            fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
          }
          await screen.findByRole("button", { name: "Retry" });
          // The receipt advances to a newer attempt by polling.
          advance();
          await act(async () => {
            await vi.advanceTimersByTimeAsync(6_000);
          });
          fireEvent.click(screen.getByRole("button", { name: "Retry" }));
          await waitFor(() =>
            expect(
              callsOf(messenger, "providers.profileCopy.retry"),
            ).toHaveLength(1),
          );
          // Then the run leaves the bounded history while the retry is held.
          omit();
          await act(async () => {
            await vi.advanceTimersByTimeAsync(6_000);
          });
        } finally {
          held.release();
        }
        expect(await screen.findByText(STALE_TEXT)).toBeTruthy();
        const sent = profileCopyRetryRequestSchema.parse(
          callsOf(messenger, "providers.profileCopy.retry")[0].params,
        );
        expect(sent.attempt.attemptId).toBe(ATTEMPT_TWO_ID);
        expect(screen.getByRole("button", { name: "← Back" })).toBeTruthy();
        await waitFor(() =>
          expect(
            screen
              .getByRole("button", { name: "Done" })
              .hasAttribute("disabled"),
          ).toBe(false),
        );
      },
    );

    it("refuses a returned item with another operation id, even when its receipt agrees, and offers no actions", async () => {
      const FOREIGN_OPERATION = "00000000-0000-4000-8000-0000000000f7";
      startBatchMutator = (started) => ({
        ...started,
        items: started.items.map((entry) => ({
          ...entry,
          operationId: FOREIGN_OPERATION,
          outcome:
            entry.outcome === null
              ? null
              : {
                  ...entry.outcome,
                  attempt: {
                    ...entry.outcome.attempt,
                    operationId: FOREIGN_OPERATION,
                  },
                },
        })),
      });
      await startShowing(() => [receiptItem("unavailable")]);
      expect(
        await screen.findByText(
          "The device returned a run outside this selection. Check sync history again.",
        ),
      ).toBeTruthy();
      for (const name of [/Check status/, /Retry/, /Review/])
        expect(screen.queryByRole("button", { name })).toBeNull();
    });

    describe("Retry follows the state, not just the receipt", () => {
      it.each([
        "synced",
        "already-present",
        "paused",
        "source-removed",
        "ready",
        "queued",
        "copying",
        "conflict",
      ] as const)(
        "offers no Retry for %s with a retryable receipt",
        async (state) => {
          await startShowing(() => [receiptItem(state)]);
          await screen.findByRole("heading", { name: "Linux box" });
          expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
        },
      );

      it.each([
        "needs-action",
        "unavailable",
        "update-required",
        "unconfirmed",
      ] as const)(
        "offers Retry for %s with a retryable receipt",
        async (state) => {
          await startShowing(() => [receiptItem(state)]);
          expect(
            await screen.findByRole("button", { name: "Retry" }),
          ).toBeTruthy();
        },
      );
    });
  });

  describe("round 21: the destination draft's own requests hold the source dialog", () => {
    const STALE_DRAFT = /This changed on Linux box since you last looked/;

    function gate(): { promise: Promise<void>; release: () => void } {
      let release: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    }

    const verificationPending = (): ProfileCopyOutcome =>
      recordedOutcome({
        attempt: profileCopyAttempt({
          operationId: "00000000-0000-4000-8000-000000000001",
        }),
        state: "verification-pending",
        revision: 6,
        readiness: {
          preparation: "complete",
          verification: "not-checked",
          verificationRevision: null,
          acceptedVerificationRevision: null,
          identity: "not-checked",
          identityRevision: null,
          acceptedIdentityRevision: null,
          writer: "none",
          writerGeneration: 0,
          quarantined: false,
        },
      });

    async function openDraftReview(): Promise<
      MockHostMessenger<HostRpcRegistry>
    > {
      const outcome = verificationPending();
      draftStatusOutcome = outcome;
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: () => [
          syncItem(1, DEST_HOST_ID, "ready", [
            previewDestination(DEST_HOST_ID, "automatic"),
          ]),
        ],
        startItems: () => [
          {
            ...syncItem(1, DEST_HOST_ID, "needs-action", []),
            preview: null,
            outcome,
          },
        ],
      });
      openSync(null);
      await pickDestinations([/Linux box/]);
      await screen.findByText("1 profile transfers selected");
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
      fireEvent.click(await screen.findByRole("button", { name: "Review…" }));
      await screen.findByRole("button", { name: "Verify" });
      return messenger;
    }

    function attemptExits(): void {
      fireEvent.click(screen.getByRole("button", { name: "← Back" }));
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: "Escape",
      });
      fireEvent.click(screen.getByRole("button", { name: "Hide details" }));
    }

    function expectDraftHeld(): void {
      expect(useProfileCopyFlowStore.getState().view).not.toBeNull();
      expect(screen.getByRole("button", { name: "Hide details" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "← Back" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Verify" })).toBeTruthy();
    }

    it("keeps the draft pending when polling replaces the receipt with a newer attempt of the same operation", async () => {
      const held = gate();
      verifyGate = held.promise;
      const messenger = await openDraftReview();
      const draftReads = () =>
        messenger.calls
          .filter((call) => call.method === "providers.profileCopy.draftStatus")
          .map((call) => profileCopyDraftRequestSchema.parse(call.params));
      try {
        fireEvent.click(screen.getByRole("button", { name: "Verify" }));
        await waitFor(() =>
          expect(
            messenger.calls.filter(
              (call) => call.method === "providers.profileCopy.verify",
            ),
          ).toHaveLength(1),
        );
        // Polling now reports the same operation under a newer attempt.
        const newer: ProfileCopyOutcome = {
          ...verificationPending(),
          attempt: profileCopyAttempt({
            operationId: "00000000-0000-4000-8000-000000000001",
            attemptId: ATTEMPT_TWO_ID,
          }),
        };
        draftStatusOutcome = newer;
        updateStarted = (batch) => ({
          ...batch,
          items: batch.items.map((entry) => ({ ...entry, outcome: newer })),
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(6_000);
        });
        // The newer receipt was actually observed by the panel.
        await waitFor(() =>
          expect(
            draftReads().some(
              (read) => read.attempt.attemptId === ATTEMPT_TWO_ID,
            ),
          ).toBe(true),
        );
        // The Verify for the old attempt is still in flight: every exit is
        // still held and the details stay mounted.
        for (const name of ["Hide details", "← Back", "Done"])
          expect(
            screen.getByRole("button", { name }).hasAttribute("disabled"),
          ).toBe(true);
        attemptExits();
        expect(useProfileCopyFlowStore.getState().view).not.toBeNull();
        expect(
          screen.getByRole("button", { name: "Hide details" }),
        ).toBeTruthy();
        expect(screen.getByRole("button", { name: "← Back" })).toBeTruthy();
      } finally {
        held.release();
      }
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Done" }).hasAttribute("disabled"),
        ).toBe(false),
      );
      expect(
        screen
          .getByRole("button", { name: "Hide details" })
          .hasAttribute("disabled"),
      ).toBe(false);
    });

    it.each([
      ["a stale-revision answer", "stale", (): void => undefined],
      [
        "an unreachable destination",
        "error",
        (): void => {
          verifyThrows = true;
        },
      ],
    ] as const)(
      "keeps the draft panel through every exit while Verify is in flight, then unlocks after %s",
      async (_label, kind, arrange) => {
        const held = gate();
        verifyGate = held.promise;
        verifyResult = "stale-revision";
        const messenger = await openDraftReview();
        try {
          fireEvent.click(screen.getByRole("button", { name: "Verify" }));
          await waitFor(() =>
            expect(
              messenger.calls.filter(
                (call) => call.method === "providers.profileCopy.verify",
              ),
            ).toHaveLength(1),
          );
          attemptExits();
          expectDraftHeld();
          arrange();
        } finally {
          held.release();
        }
        if (kind === "stale") {
          expect(await screen.findByText(STALE_DRAFT)).toBeTruthy();
        } else {
          // The per-call failure is kept, not just the unlocked exits.
          expect(
            await screen.findByText(/Couldn't reach Linux box right now/),
          ).toBeTruthy();
        }
        // Settled: the panel is still there and every exit is available.
        await waitFor(() =>
          expect(
            screen
              .getByRole("button", { name: "Done" })
              .hasAttribute("disabled"),
          ).toBe(false),
        );
        expect(
          screen.getByRole("button", { name: "Hide details" }),
        ).toBeTruthy();
        if (kind === "stale")
          expect(screen.getByText(STALE_DRAFT)).toBeTruthy();
        else
          expect(
            screen.getByText(/Couldn't reach Linux box right now/),
          ).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Hide details" }));
        expect(screen.queryByRole("button", { name: "Verify" })).toBeNull();
      },
    );
  });

  describe("round 22: frozen selection, stop revision and retained rules", () => {
    const REACH_ERROR = /Couldn't reach Studio Mac right now/;

    function gate(): { promise: Promise<void>; release: () => void } {
      let release: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    }

    function callsOf(
      messenger: MockHostMessenger<HostRpcRegistry>,
      method: string,
    ) {
      return messenger.calls.filter((call) => call.method === method);
    }

    const isDisabled = (element: HTMLElement): boolean =>
      element.hasAttribute("disabled") ||
      element.getAttribute("aria-disabled") === "true" ||
      element.hasAttribute("data-disabled");

    it("freezes the selection while a start is in flight, even with the provider picker already open, and sends the original selection", async () => {
      const held = gate();
      startGate = held.promise;
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: () => [
          syncItem(1, DEST_HOST_ID, "ready", [
            previewDestination(DEST_HOST_ID, "automatic"),
          ]),
        ],
        startItems: noItems,
      });
      try {
        openSync(null);
        await pickDestinations([/Linux box/]);
        await screen.findByText("1 profile transfers selected");
        // Open the picker BEFORE the start, so it is already open when held.
        fireEvent.click(
          screen.getByRole("button", { name: "Choose providers" }),
        );
        await screen.findByRole("option", { name: /Claude/ });
        fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
        await waitFor(() => expect(startCalls(messenger)).toHaveLength(1));
        const frozen: HTMLElement[] = [
          screen.getByRole("checkbox", { name: /Linux box/ }),
          screen.getByRole("checkbox", { name: /Old Mac/ }),
          screen.getByRole("button", { name: "Choose providers" }),
          screen.getByRole("button", { name: "Check again" }),
          screen.getByRole("option", { name: /Claude/ }),
          screen.getByRole("button", { name: /^(Select all|Clear)$/ }),
        ];
        for (const element of frozen) expect(isDisabled(element)).toBe(true);
        // Acting on them changes nothing.
        for (const element of frozen) fireEvent.click(element);
        expect(
          screen
            .getByRole("checkbox", { name: /Linux box/ })
            .getAttribute("aria-checked"),
        ).toBe("true");
        expect(
          screen
            .getByRole("checkbox", { name: /Old Mac/ })
            .getAttribute("aria-checked"),
        ).toBe("false");
        expect(screen.getByText("1 profile transfers selected")).toBeTruthy();
        expect(startCalls(messenger)).toHaveLength(1);
      } finally {
        held.release();
      }
      const sent = profileSyncStartSchema.parse(
        startCalls(messenger)[0].params,
      );
      expect(sent.selection.destinationHostIds).toEqual([DEST_HOST_ID]);
    });

    describe("a Stop confirmation and the rule's revision", () => {
      const CHANGED_GUIDANCE =
        "This rule changed. Choose Keep rule, review its current settings, then choose Stop again.";
      const stopCalls = (messenger: MockHostMessenger<HostRpcRegistry>) =>
        callsOf(messenger, "providers.profileCopy.sync.stopRule");
      const moved = (): ProfileSyncRule => ({
        ...SAVED_RULE,
        paused: true,
        status: "paused",
        revision: 2,
      });

      async function openStopConfirmation(): Promise<
        MockHostMessenger<HostRpcRegistry>
      > {
        const messenger = mount([SAVED_RULE]);
        openSync(null);
        fireEvent.mouseDown(
          await screen.findByRole("tab", { name: /Automatic sync/ }),
          { button: 0 },
        );
        await screen.findByRole("heading", { name: "Linux box" });
        fireEvent.click(screen.getByRole("button", { name: "Stop…" }));
        await screen.findByRole("button", { name: "Stop automatic sync" });
        return messenger;
      }

      async function pollToMoved(): Promise<void> {
        listRules = [moved()];
        await act(async () => {
          await vi.advanceTimersByTimeAsync(6_000);
        });
        await screen.findByText("Paused");
      }

      it("sends the captured revision when the rule has not changed", async () => {
        const messenger = await openStopConfirmation();
        expect(screen.queryByText(CHANGED_GUIDANCE)).toBeNull();
        fireEvent.click(
          screen.getByRole("button", { name: "Stop automatic sync" }),
        );
        await waitFor(() => expect(stopCalls(messenger)).toHaveLength(1));
        const sent = profileSyncStopRuleSchema.parse(
          stopCalls(messenger)[0].params,
        );
        expect(sent.expectedRevision).toBe(SAVED_RULE.revision);
      });

      it("refuses a stale confirmation without any request, then stops the reviewed current revision after Keep rule", async () => {
        const messenger = await openStopConfirmation();
        await pollToMoved();
        expect(await screen.findByText(CHANGED_GUIDANCE)).toBeTruthy();
        const confirm = screen.getByRole("button", {
          name: "Stop automatic sync",
        });
        expect(confirm.hasAttribute("disabled")).toBe(true);
        fireEvent.click(confirm);
        // It never silently advances to the latest revision.
        expect(stopCalls(messenger)).toHaveLength(0);
        fireEvent.click(screen.getByRole("button", { name: "Keep rule" }));
        expect(
          screen.queryByRole("button", { name: "Stop automatic sync" }),
        ).toBeNull();
        // Reopened on the current rule, the confirmation captures revision 2.
        fireEvent.click(screen.getByRole("button", { name: "Stop…" }));
        const reopened = await screen.findByRole("button", {
          name: "Stop automatic sync",
        });
        expect(reopened.hasAttribute("disabled")).toBe(false);
        expect(screen.queryByText(CHANGED_GUIDANCE)).toBeNull();
        fireEvent.click(reopened);
        await waitFor(() => expect(stopCalls(messenger)).toHaveLength(1));
        const sent = profileSyncStopRuleSchema.parse(
          stopCalls(messenger)[0].params,
        );
        expect(sent.expectedRevision).toBe(2);
      });

      it("shows the review-change guidance, not a hidden failure, when a held Stop is rejected after the rule moved on", async () => {
        const held = gate();
        stopRuleGate = held.promise;
        const messenger = await openStopConfirmation();
        try {
          fireEvent.click(
            screen.getByRole("button", { name: "Stop automatic sync" }),
          );
          await waitFor(() => expect(stopCalls(messenger)).toHaveLength(1));
          expect(
            profileSyncStopRuleSchema.parse(stopCalls(messenger)[0].params)
              .expectedRevision,
          ).toBe(SAVED_RULE.revision);
          await pollToMoved();
          stopRuleThrows = true;
        } finally {
          held.release();
        }
        expect(await screen.findByText(CHANGED_GUIDANCE)).toBeTruthy();
        const keep = screen.getByRole("button", { name: "Keep rule" });
        await waitFor(() => expect(keep.hasAttribute("disabled")).toBe(false));
        fireEvent.click(keep);
        expect(
          screen.queryByRole("button", { name: "Stop automatic sync" }),
        ).toBeNull();
      });
    });

    describe.each([
      ["a new rule", "new"],
      ["an existing rule", "edit"],
    ] as const)("%s's editor", (_label, kind) => {
      it("stays mounted with its draft when a background list poll fails, and a rejected save then shows its inline error beside it", async () => {
        const held = gate();
        saveRuleGate = held.promise;
        const messenger = mount(kind === "edit" ? [SAVED_RULE] : []);
        try {
          openSync(null);
          fireEvent.mouseDown(
            await screen.findByRole("tab", { name: /Automatic sync/ }),
            { button: 0 },
          );
          if (kind === "edit") {
            await screen.findByRole("heading", { name: "Linux box" });
            fireEvent.click(screen.getByRole("button", { name: "Edit" }));
            fireEvent.click(
              await screen.findByRole("checkbox", {
                name: /All supported providers/,
              }),
            );
          } else {
            fireEvent.click(
              await screen.findByRole("button", { name: "Add device" }),
            );
            fireEvent.keyDown(
              await screen.findByRole("combobox", {
                name: "Destination device",
              }),
              { key: "ArrowDown" },
            );
            fireEvent.click(
              await screen.findByRole("option", { name: /Linux box/ }),
            );
          }
          fireEvent.click(
            await screen.findByRole("button", {
              name: kind === "edit" ? "Save changes" : "Enable automatic sync",
            }),
          );
          await waitFor(() =>
            expect(
              callsOf(messenger, "providers.profileCopy.sync.saveRule"),
            ).toHaveLength(1),
          );
          // A background poll fails while the save is still in flight.
          listFails = true;
          await act(async () => {
            await vi.advanceTimersByTimeAsync(6_000);
          });
          await screen.findByRole("button", { name: "Try again" });
          // The editor and its draft are still there, beside the list error.
          expect(
            screen.getByRole("combobox", { name: "Destination device" }),
          ).toBeTruthy();
          expect(
            screen.getByRole("button", {
              name: kind === "edit" ? "Save changes" : "Enable automatic sync",
            }),
          ).toBeTruthy();
          if (kind === "edit")
            expect(
              screen
                .getByRole("checkbox", { name: /All supported providers/ })
                .getAttribute("aria-checked"),
            ).toBe("true");
          expect(screen.getAllByText(REACH_ERROR)).toHaveLength(1);
          saveRuleThrows = true;
        } finally {
          held.release();
        }
        // The rejected save's own error joins the list error, in the editor.
        await waitFor(() =>
          expect(screen.getAllByText(REACH_ERROR)).toHaveLength(2),
        );
        expect(
          screen.getByRole("combobox", { name: "Destination device" }),
        ).toBeTruthy();
      });
    });
  });

  describe("round 23: reopened uncertain starts and rows that wait on a sibling's request", () => {
    function gate(): { promise: Promise<void>; release: () => void } {
      let release: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    }

    const readyItems = (): ProfileSyncItem[] => [
      syncItem(1, DEST_HOST_ID, "ready", [
        previewDestination(DEST_HOST_ID, "automatic"),
      ]),
    ];

    async function startOnce(): Promise<void> {
      openSync(null);
      await pickDestinations([/Linux box/]);
      await screen.findByText("1 profile transfers selected");
      fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    }

    describe("an uncertain start across Cancel and reopen", () => {
      async function cancelAndReopen(): Promise<void> {
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        await waitFor(() =>
          expect(useProfileCopyFlowStore.getState().view).toBeNull(),
        );
      }

      it("retries under the same batch id for the same selection and revision", async () => {
        startFailures = 1;
        const messenger = mountWith({
          rules: [],
          providers: defaultProviders(),
          previewItems: readyItems,
          startItems: noItems,
        });
        await startOnce();
        expect(await screen.findByText(/could not be confirmed/)).toBeTruthy();
        await cancelAndReopen();
        await startOnce();
        await waitFor(() => expect(startCalls(messenger)).toHaveLength(2));
        const [first, second] = startCalls(messenger).map((call) =>
          profileSyncStartSchema.parse(call.params),
        );
        expect(second.selection).toEqual(first.selection);
        expect(second.revision).toBe(first.revision);
        expect(second.batchId).toBe(first.batchId);
      });

      it("uses a new batch id once the preview revision changed", async () => {
        startFailures = 1;
        const messenger = mountWith({
          rules: [],
          providers: defaultProviders(),
          previewItems: readyItems,
          startItems: noItems,
        });
        await startOnce();
        expect(await screen.findByText(/could not be confirmed/)).toBeTruthy();
        await cancelAndReopen();
        previewRevision = "b".repeat(64);
        openSync(null);
        await pickDestinations([/Linux box/]);
        await screen.findByText("1 profile transfers selected");
        // The fresh cached preview is reused on reopen; ask again to see the
        // new revision before starting.
        const previewsBefore = previewCalls(messenger).length;
        fireEvent.click(screen.getByRole("button", { name: "Check again" }));
        await waitFor(() =>
          expect(previewCalls(messenger).length).toBeGreaterThan(
            previewsBefore,
          ),
        );
        await waitFor(() =>
          expect(
            screen
              .getByRole("button", { name: "Sync now" })
              .hasAttribute("disabled"),
          ).toBe(false),
        );
        fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
        await waitFor(() => expect(startCalls(messenger)).toHaveLength(2));
        const [first, second] = startCalls(messenger).map((call) =>
          profileSyncStartSchema.parse(call.params),
        );
        expect(second.revision).not.toBe(first.revision);
        expect(second.batchId).not.toBe(first.batchId);
      });

      it("uses a new batch id after an account reset", async () => {
        startFailures = 1;
        const messenger = mountWith({
          rules: [],
          providers: defaultProviders(),
          previewItems: readyItems,
          startItems: noItems,
        });
        await startOnce();
        expect(await screen.findByText(/could not be confirmed/)).toBeTruthy();
        await cancelAndReopen();
        act(() => {
          useProfileCopyFlowStore.getState().reset();
        });
        await startOnce();
        await waitFor(() => expect(startCalls(messenger)).toHaveLength(2));
        const [first, second] = startCalls(messenger).map((call) =>
          profileSyncStartSchema.parse(call.params),
        );
        expect(second.batchId).not.toBe(first.batchId);
      });
    });

    describe.each([
      ["Check status", "resolve"],
      ["Retry", "retry"],
    ] as const)(
      "Open profile on another row while %s is in flight",
      (button, which) => {
        it("waits for the sibling request, keeps its notice, and opens afterwards", async () => {
          const PROFILE_B = "33333333-3333-4333-8333-333333333334";
          const OPERATION_B = "00000000-0000-4000-8000-000000000002";
          const receiptA = profileCopyOutcome({
            attempt: profileCopyAttempt({
              operationId: "00000000-0000-4000-8000-000000000001",
            }),
            state: "blocked",
            reason: "unreachable",
          });
          const receiptB = recordedOutcome({
            attempt: profileCopyAttempt({
              operationId: OPERATION_B,
              sourceProfileId: PROFILE_B,
              attemptId: ATTEMPT_TWO_ID,
            }),
            state: "already-present",
          });
          draftStatusOutcome = receiptB;
          retryResult = "stale-revision";
          retryOutcome = receiptA;
          const held = gate();
          mountWith({
            rules: [],
            providers: defaultProviders(),
            // The preview names both rows, so the started run is inside it.
            previewItems: () => [
              syncItem(1, DEST_HOST_ID, "ready", [
                previewDestination(DEST_HOST_ID, "automatic"),
              ]),
              withSourceProfile(
                syncItem(2, DEST_HOST_ID, "ready", [
                  previewDestination(DEST_HOST_ID, "automatic"),
                ]),
                PROFILE_B,
              ),
            ],
            startItems: () => [
              {
                ...syncItem(1, DEST_HOST_ID, "unavailable", []),
                preview: null,
                outcome: receiptA,
              },
              {
                ...withSourceProfile(
                  syncItem(2, DEST_HOST_ID, "already-present", []),
                  PROFILE_B,
                ),
                preview: null,
                outcome: receiptB,
              },
            ],
          });
          try {
            openSync(null);
            await pickDestinations([/Linux box/]);
            await screen.findByText("2 profile transfers selected");
            fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
            await screen.findByRole("button", { name: button });
            // Open the already-present row's details first: Open profile is live.
            const reviews = await screen.findAllByRole("button", {
              name: "Review…",
            });
            fireEvent.click(reviews[1]);
            const open = await screen.findByRole("button", {
              name: "Open profile",
            });
            expect(open.hasAttribute("disabled")).toBe(false);
            // Now hold the other row's request.
            if (which === "resolve") resolveGate = held.promise;
            else retryGate = held.promise;
            fireEvent.click(screen.getByRole("button", { name: button }));
            await waitFor(() =>
              expect(
                screen
                  .getByRole("button", { name: "Open profile" })
                  .hasAttribute("disabled"),
              ).toBe(true),
            );
            fireEvent.click(
              screen.getByRole("button", { name: "Open profile" }),
            );
            expect(useProfileCopyFlowStore.getState().view).not.toBeNull();
          } finally {
            held.release();
          }
          if (which === "retry")
            expect(
              await screen.findByText(
                "This changed since you last looked. Review it again.",
              ),
            ).toBeTruthy();
          const settled = await screen.findByRole("button", {
            name: "Open profile",
          });
          await waitFor(() =>
            expect(settled.hasAttribute("disabled")).toBe(false),
          );
          if (which === "retry")
            expect(
              screen.getByText(
                "This changed since you last looked. Review it again.",
              ),
            ).toBeTruthy();
          fireEvent.click(settled);
          await waitFor(() =>
            expect(useProfileCopyFlowStore.getState().view).toBeNull(),
          );
        });
      },
    );
  });

  describe("round 25: retry ids across remounts and a fresh start over an older snapshot", () => {
    function gate(): { promise: Promise<void>; release: () => void } {
      let release: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    }

    const OP = "00000000-0000-4000-8000-000000000001";
    const receiptA = (): ProfileCopyOutcome =>
      profileCopyOutcome({
        attempt: profileCopyAttempt({ operationId: OP }),
        state: "blocked",
        reason: "unreachable",
      });
    const retryableItem = (): ProfileSyncItem => ({
      ...syncItem(1, DEST_HOST_ID, "unavailable", []),
      preview: null,
      outcome: receiptA(),
    });
    const RUN = "00000000-0000-4000-8000-0000000000e9";

    describe("an unconfirmed retry across Back and close/reopen", () => {
      const history = (): ProfileSyncBatch => ({
        batchId: RUN,
        sourceHostId: SOURCE_HOST_ID,
        createdAt: 1_700_000_000_000,
        automatic: false,
        items: [retryableItem()],
      });

      async function openRun(): Promise<void> {
        openSync(null);
        fireEvent.click(
          await screen.findByRole("button", { name: /profile transfers/ }),
        );
        await screen.findByRole("button", { name: "Retry" });
      }

      const retryRequests = (messenger: MockHostMessenger<HostRpcRegistry>) =>
        messenger.calls
          .filter((call) => call.method === "providers.profileCopy.retry")
          .map((call) => profileCopyRetryRequestSchema.parse(call.params));

      async function failedRetry(): Promise<
        MockHostMessenger<HostRpcRegistry>
      > {
        retryThrows = true;
        listBatches = [history()];
        const messenger = mountWith({
          rules: [],
          providers: defaultProviders(),
          previewItems: noItems,
          startItems: noItems,
        });
        await openRun();
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(
          await screen.findByText(/Couldn't reach Studio Mac right now/),
        ).toBeTruthy();
        return messenger;
      }

      it("reuses the retry request id after Back and opening the same run again", async () => {
        const messenger = await failedRetry();
        fireEvent.click(screen.getByRole("button", { name: "← Back" }));
        fireEvent.click(
          await screen.findByRole("button", { name: /profile transfers/ }),
        );
        fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
        await waitFor(() => expect(retryRequests(messenger)).toHaveLength(2));
        const [first, second] = retryRequests(messenger);
        expect(second.attempt).toEqual(first.attempt);
        expect(second.expectedRevision).toBe(first.expectedRevision);
        expect(second.retryRequestId).toBe(first.retryRequestId);
      });

      it("reuses the retry request id after closing and reopening the dialog", async () => {
        const messenger = await failedRetry();
        fireEvent.click(screen.getByRole("button", { name: "Done" }));
        await waitFor(() =>
          expect(useProfileCopyFlowStore.getState().view).toBeNull(),
        );
        await openRun();
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        await waitFor(() => expect(retryRequests(messenger)).toHaveLength(2));
        const [first, second] = retryRequests(messenger);
        expect(second.retryRequestId).toBe(first.retryRequestId);
      });

      it("mints a new retry request id after an account reset", async () => {
        const messenger = await failedRetry();
        fireEvent.click(screen.getByRole("button", { name: "Done" }));
        await waitFor(() =>
          expect(useProfileCopyFlowStore.getState().view).toBeNull(),
        );
        act(() => {
          useProfileCopyFlowStore.getState().reset();
        });
        await openRun();
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        await waitFor(() => expect(retryRequests(messenger)).toHaveLength(2));
        const [first, second] = retryRequests(messenger);
        expect(second.retryRequestId).not.toBe(first.retryRequestId);
      });
    });

    it("keeps a fresh start answer over an older same-batch snapshot polled during the hold, through a failed refetch, until a newer poll supersedes it", async () => {
      const held = gate();
      startGate = held.promise;
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: () => [
          syncItem(1, DEST_HOST_ID, "ready", [
            previewDestination(DEST_HOST_ID, "automatic"),
          ]),
        ],
        // The newer answer: the same reviewed tuple, now synced.
        startItems: () => [
          { ...syncItem(1, DEST_HOST_ID, "synced", []), preview: null },
        ],
      });
      try {
        openSync(null);
        await pickDestinations([/Linux box/]);
        await screen.findByText("1 profile transfers selected");
        fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
        await waitFor(() => expect(startCalls(messenger)).toHaveLength(1));
        const submitted = profileSyncStartSchema.parse(
          startCalls(messenger)[0].params,
        ).batchId;
        // While held, a poll lists the SAME batch with an older snapshot.
        listBatches = [
          {
            batchId: submitted,
            sourceHostId: SOURCE_HOST_ID,
            createdAt: 1,
            automatic: false,
            items: [retryableItem()],
          },
        ];
        const listCalls = (): number =>
          messenger.calls.filter(
            (call) => call.method === "providers.profileCopy.sync.list",
          ).length;
        const listsBefore = listCalls();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(6_000);
        });
        // The poll really reached the host and (with listFails still off)
        // was answered successfully with the older same-batch snapshot.
        await waitFor(() => expect(listCalls()).toBeGreaterThan(listsBefore));
        // Then the next refetch fails, and the start answer lands.
        listFails = true;
      } finally {
        held.release();
      }
      expect(await screen.findByText("Synced")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Check status" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      // A failed post-success refetch does not bring the older snapshot back.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(screen.getByText("Synced")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      // A later, newer poll does supersede it, and survives omission.
      listFails = false;
      const submittedId = profileSyncStartSchema.parse(
        startCalls(messenger)[0].params,
      ).batchId;
      listBatches = [
        {
          batchId: submittedId,
          sourceHostId: SOURCE_HOST_ID,
          createdAt: 1,
          automatic: false,
          items: [
            {
              ...syncItem(1, DEST_HOST_ID, "source-removed", []),
              preview: null,
            },
          ],
        },
      ];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(await screen.findByText("Profile removed")).toBeTruthy();
      listBatches = [];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(screen.getByText("Profile removed")).toBeTruthy();
      expect(screen.getByRole("button", { name: "← Back" })).toBeTruthy();
    });
  });

  describe("round 26: authoritative resolve answers and remembered rule ids", () => {
    const OP = "00000000-0000-4000-8000-000000000001";
    const RUN = "00000000-0000-4000-8000-0000000000f1";
    const retryableItem = (): ProfileSyncItem => ({
      ...syncItem(1, DEST_HOST_ID, "unavailable", []),
      preview: null,
      outcome: profileCopyOutcome({
        attempt: profileCopyAttempt({ operationId: OP }),
        state: "blocked",
        reason: "unreachable",
      }),
    });
    const runWith = (items: ProfileSyncItem[]): ProfileSyncBatch => ({
      batchId: RUN,
      sourceHostId: SOURCE_HOST_ID,
      createdAt: 1_700_000_000_000,
      automatic: false,
      items,
    });
    const settled = (state: ProfileSyncItem["state"]): ProfileSyncItem => ({
      ...syncItem(1, DEST_HOST_ID, state, []),
      preview: null,
    });

    function mountRun(): MockHostMessenger<HostRpcRegistry> {
      listBatches = [runWith([retryableItem()])];
      return mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: noItems,
        startItems: noItems,
      });
    }

    async function openRun(): Promise<void> {
      openSync(null);
      fireEvent.click(
        await screen.findByRole("button", { name: /profile transfers/ }),
      );
      await screen.findByRole("button", { name: "Check status" });
    }

    it("keeps a successful Check status answer through a failed refetch, until a newer poll supersedes it and survives omission", async () => {
      resolveAnswer = (request) => ({
        batchId: request.batchId,
        sourceHostId: request.sourceHostId,
        createdAt: 1,
        automatic: false,
        items: [settled("synced")],
      });
      mountRun();
      await openRun();
      // The next refetch will fail; the answer must not be undone by it.
      listFails = true;
      fireEvent.click(screen.getByRole("button", { name: "Check status" }));
      expect(await screen.findByText("Synced")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Check status" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(screen.getByText("Synced")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      // A later successful poll with newer state supersedes it...
      listFails = false;
      listBatches = [runWith([settled("source-removed")])];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(await screen.findByText("Profile removed")).toBeTruthy();
      // ...and survives the run leaving the bounded history.
      listBatches = [];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(screen.getByText("Profile removed")).toBeTruthy();
    });

    it("keeps a successful conflict resolution through a failed refetch, with no conflict controls left", async () => {
      const conflict: ProfileSyncItem = {
        ...settled("conflict"),
        destinationSettings: {
          name: "Edited on destination",
          color: "#10b981",
          enabled: true,
        },
      };
      listBatches = [runWith([conflict])];
      mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: noItems,
        startItems: noItems,
      });
      // The resolution lands as the source applied: synced, destination agrees.
      resolveAnswer = (request) => ({
        batchId: request.batchId,
        sourceHostId: request.sourceHostId,
        createdAt: 1,
        automatic: false,
        items: [settled("synced")],
      });
      openSync(null);
      fireEvent.click(
        await screen.findByRole("button", { name: /profile transfers/ }),
      );
      fireEvent.click(await screen.findByRole("button", { name: "Review…" }));
      const useSource = await screen.findByRole("button", {
        name: "Use source settings",
      });
      // The next refetch fails, so only the answer can show the new state.
      listFails = true;
      fireEvent.click(useSource);
      expect(await screen.findByText("Synced")).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(screen.getByText("Synced")).toBeTruthy();
      for (const name of ["Use source settings", "Keep destination & pause"])
        expect(screen.queryByRole("button", { name })).toBeNull();
      expect(screen.queryByText(/edited on the destination/)).toBeNull();
    });

    it.each([
      [
        "another source's batch",
        (
          request: RequestOfMethod<
            HostRpcRegistry,
            "providers.profileCopy.sync.resolve"
          >,
        ): ProfileSyncBatch => ({
          batchId: request.batchId,
          sourceHostId: "foreign-source-host",
          createdAt: 1,
          automatic: false,
          items: [settled("synced")],
        }),
      ],
      [
        "another batch id",
        (
          request: RequestOfMethod<
            HostRpcRegistry,
            "providers.profileCopy.sync.resolve"
          >,
        ): ProfileSyncBatch => ({
          batchId: "00000000-0000-4000-8000-0000000000f2",
          sourceHostId: request.sourceHostId,
          createdAt: 1,
          automatic: false,
          items: [settled("synced")],
        }),
      ],
      [
        "a batch missing the requested operation",
        (
          request: RequestOfMethod<
            HostRpcRegistry,
            "providers.profileCopy.sync.resolve"
          >,
        ): ProfileSyncBatch => ({
          batchId: request.batchId,
          sourceHostId: request.sourceHostId,
          createdAt: 1,
          automatic: false,
          items: [],
        }),
      ],
    ])("does not let %s replace the active run", async (_label, answer) => {
      resolveAnswer = answer;
      const messenger = mountRun();
      await openRun();
      // The answer is wire-valid; only its correlation is wrong.
      expect(
        profileSyncBatchSchema.safeParse(
          answer({
            sourceHostId: SOURCE_HOST_ID,
            batchId: RUN,
            operationId: OP,
            action: "check",
            expectedDestination: null,
          }),
        ).success,
      ).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Check status" }));
      await waitFor(() =>
        expect(
          messenger.calls.filter(
            (call) => call.method === "providers.profileCopy.sync.resolve",
          ),
        ).toHaveLength(1),
      );
      // The active run is untouched: still unavailable, still actionable.
      await waitFor(() =>
        expect(
          screen
            .getByRole("button", { name: "Check status" })
            .hasAttribute("disabled"),
        ).toBe(false),
      );
      expect(screen.queryByText("Synced")).toBeNull();
      expect(screen.getByText("Unavailable")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    });

    describe("a new rule's id across an uncertain save", () => {
      const sentRuleIds = (messenger: MockHostMessenger<HostRpcRegistry>) =>
        messenger.calls
          .filter(
            (call) => call.method === "providers.profileCopy.sync.saveRule",
          )
          .map((call) => profileSyncSaveRuleSchema.parse(call.params).ruleId);

      async function openAutomatic(): Promise<void> {
        fireEvent.mouseDown(
          await screen.findByRole("tab", { name: /Automatic sync/ }),
          { button: 0 },
        );
        await screen.findByRole("button", { name: "Add device" });
      }

      async function saveFor(name: RegExp): Promise<void> {
        fireEvent.click(screen.getByRole("button", { name: "Add device" }));
        fireEvent.keyDown(
          await screen.findByRole("combobox", { name: "Destination device" }),
          { key: "ArrowDown" },
        );
        fireEvent.click(await screen.findByRole("option", { name }));
        fireEvent.click(
          await screen.findByRole("button", { name: "Enable automatic sync" }),
        );
        expect(
          await screen.findByText(/Couldn't reach Studio Mac right now/),
        ).toBeTruthy();
      }

      async function failedSave(): Promise<MockHostMessenger<HostRpcRegistry>> {
        saveRuleThrows = true;
        const messenger = mount([]);
        openSync(null);
        await openAutomatic();
        await saveFor(/Linux box/);
        return messenger;
      }

      it("keeps the id across Back and a remounted editor for the same destination", async () => {
        const messenger = await failedSave();
        fireEvent.click(
          screen.getByRole("button", { name: "← Automatic sync" }),
        );
        await saveFor(/Linux box/);
        const [first, second] = sentRuleIds(messenger);
        expect(second).toBe(first);
      });

      it("keeps the id across closing and reopening the dialog", async () => {
        const messenger = await failedSave();
        fireEvent.click(screen.getByRole("button", { name: "Done" }));
        await waitFor(() =>
          expect(useProfileCopyFlowStore.getState().view).toBeNull(),
        );
        openSync(null);
        await openAutomatic();
        await saveFor(/Linux box/);
        const [first, second] = sentRuleIds(messenger);
        expect(second).toBe(first);
      });

      it("uses a new id for another destination, and after an account reset", async () => {
        const messenger = await failedSave();
        fireEvent.click(
          screen.getByRole("button", { name: "← Automatic sync" }),
        );
        await saveFor(/Old Mac/);
        act(() => {
          useProfileCopyFlowStore.getState().reset();
        });
        openSync(null);
        await openAutomatic();
        await saveFor(/Linux box/);
        const [first, other, afterReset] = sentRuleIds(messenger);
        expect(other).not.toBe(first);
        expect(afterReset).not.toBe(first);
      });

      it("forgets the id only when a successful list names that rule", async () => {
        const messenger = await failedSave();
        const [sent] = sentRuleIds(messenger);
        const remembered = (): string =>
          useProfileCopyFlowStore
            .getState()
            .getSyncRuleId(SOURCE_HOST_ID, DEST_HOST_ID);
        expect(remembered()).toBe(sent);
        // An unsuccessful list must not clear it.
        listFails = true;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(6_000);
        });
        expect(remembered()).toBe(sent);
        // A successful list naming a different rule must not clear it either.
        listFails = false;
        listRules = [
          { ...SAVED_RULE, ruleId: "00000000-0000-4000-8000-0000000000ab" },
        ];
        await act(async () => {
          await vi.advanceTimersByTimeAsync(6_000);
        });
        expect(remembered()).toBe(sent);
        // A successful list naming the remembered rule confirms the outcome.
        listRules = [{ ...SAVED_RULE, ruleId: sent }];
        await act(async () => {
          await vi.advanceTimersByTimeAsync(6_000);
        });
        await waitFor(() => expect(remembered()).not.toBe(sent));
      });
    });
  });

  describe("round 27: accepted rule answers survive a failed list refetch", () => {
    async function openRules(wait: "rule" | "empty"): Promise<void> {
      openSync(null);
      fireEvent.mouseDown(
        await screen.findByRole("tab", { name: /Automatic sync/ }),
        { button: 0 },
      );
      if (wait === "rule")
        await screen.findByRole("heading", { name: "Linux box" });
      else await screen.findByRole("button", { name: "Add device" });
    }

    const saveParams = (messenger: MockHostMessenger<HostRpcRegistry>) =>
      messenger.calls
        .filter((call) => call.method === "providers.profileCopy.sync.saveRule")
        .map((call) => profileSyncSaveRuleSchema.parse(call.params));

    it("shows a successful Pause as Resume and sends the new revision next", async () => {
      const messenger = mount([SAVED_RULE]);
      await openRules("rule");
      listFails = true;
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      expect(
        await screen.findByRole("button", { name: "Resume" }),
      ).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
      expect(screen.getByText("Paused")).toBeTruthy();
      // Navigating away and back does not discard the acknowledgement.
      fireEvent.mouseDown(screen.getByRole("tab", { name: /Sync now/ }), {
        button: 0,
      });
      await screen.findByRole("button", { name: "Cancel" });
      fireEvent.mouseDown(screen.getByRole("tab", { name: /Automatic sync/ }), {
        button: 0,
      });
      expect(
        await screen.findByRole("button", { name: "Resume" }),
      ).toBeTruthy();
      expect(screen.getByText("Paused")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Resume" }));
      await waitFor(() => expect(saveParams(messenger)).toHaveLength(2));
      expect(saveParams(messenger)[1].expectedRevision).toBe(
        SAVED_RULE.revision + 1,
      );
    });

    it("lets a later valid list supersede the locally accepted Pause", async () => {
      mount([SAVED_RULE]);
      await openRules("rule");
      listFails = true;
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      expect(
        await screen.findByRole("button", { name: "Resume" }),
      ).toBeTruthy();
      listFails = false;
      listRules = [
        { ...SAVED_RULE, paused: false, status: "active", revision: 5 },
      ];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(await screen.findByRole("button", { name: "Pause" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    });

    it("removes a successfully stopped rule and its actions", async () => {
      mount([SAVED_RULE]);
      await openRules("rule");
      listFails = true;
      fireEvent.click(screen.getByRole("button", { name: "Stop…" }));
      fireEvent.click(
        await screen.findByRole("button", { name: "Stop automatic sync" }),
      );
      await waitFor(() =>
        expect(screen.queryByRole("heading", { name: "Linux box" })).toBeNull(),
      );
      for (const name of ["Edit", "Pause", "Resume", "Stop…"])
        expect(screen.queryByRole("button", { name })).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(screen.queryByRole("heading", { name: "Linux box" })).toBeNull();
    });

    it("keeps a successfully created rule listed and refuses a second rule for its destination", async () => {
      mount([]);
      await openRules("empty");
      fireEvent.click(screen.getByRole("button", { name: "Add device" }));
      fireEvent.keyDown(
        await screen.findByRole("combobox", { name: "Destination device" }),
        { key: "ArrowDown" },
      );
      fireEvent.click(await screen.findByRole("option", { name: /Linux box/ }));
      listFails = true;
      fireEvent.click(
        await screen.findByRole("button", { name: "Enable automatic sync" }),
      );
      expect(
        await screen.findByRole("heading", { name: "Linux box" }),
      ).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(screen.getByRole("heading", { name: "Linux box" })).toBeTruthy();
      // Its destination is taken, so a new rule cannot target it again.
      fireEvent.click(screen.getByRole("button", { name: "Add device" }));
      fireEvent.keyDown(
        await screen.findByRole("combobox", { name: "Destination device" }),
        { key: "ArrowDown" },
      );
      await screen.findByRole("option", { name: /Old Mac/ });
      expect(screen.queryByRole("option", { name: /Linux box/ })).toBeNull();
    });
  });

  describe("round 28: a current Retry answer is kept when the list refetch fails", () => {
    const OP = "00000000-0000-4000-8000-000000000001";
    const RUN = "00000000-0000-4000-8000-0000000000f8";
    const ATTEMPT_C = "55555555-5555-4555-8555-555555555557";

    function gate(): { promise: Promise<void>; release: () => void } {
      let release: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    }

    const retryable = (
      attemptId: string,
      revision: number,
    ): ProfileCopyOutcome =>
      profileCopyOutcome({
        attempt: profileCopyAttempt({ operationId: OP, attemptId }),
        revision,
        state: "blocked",
        reason: "unreachable",
      });
    const replacement = (): ProfileCopyOutcome =>
      recordedOutcome({
        attempt: profileCopyAttempt({
          operationId: OP,
          attemptId: ATTEMPT_TWO_ID,
        }),
        revision: 4,
        state: "sign-in-required",
      });
    const runWith = (outcome: ProfileCopyOutcome): ProfileSyncBatch => ({
      batchId: RUN,
      sourceHostId: SOURCE_HOST_ID,
      createdAt: 1_700_000_000_000,
      automatic: false,
      items: [
        {
          ...syncItem(1, DEST_HOST_ID, "unavailable", []),
          preview: null,
          outcome,
        },
      ],
    });

    function mountRun(): MockHostMessenger<HostRpcRegistry> {
      listBatches = [runWith(retryable(ATTEMPT_ID, 3))];
      return mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: noItems,
        startItems: noItems,
      });
    }

    async function openRun(): Promise<void> {
      openSync(null);
      fireEvent.click(
        await screen.findByRole("button", { name: /profile transfers/ }),
      );
      await screen.findByRole("button", { name: "Retry" });
    }

    const draftReads = (messenger: MockHostMessenger<HostRpcRegistry>) =>
      messenger.calls
        .filter((call) => call.method === "providers.profileCopy.draftStatus")
        .map((call) => profileCopyDraftRequestSchema.parse(call.params));

    it("shows the replacement attempt through a failed refetch, sends follow-ups to it, and is superseded by a later poll", async () => {
      retryOutcome = replacement();
      draftStatusOutcome = replacement();
      const messenger = mountRun();
      await openRun();
      listFails = true;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      // The new receipt is sign-in required, so the old Retry is withdrawn.
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Retry" })).toBeNull(),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      // A follow-up (the draft read behind Review) goes to the replacement.
      fireEvent.click(await screen.findByRole("button", { name: "Review…" }));
      await waitFor(() =>
        expect(
          draftReads(messenger).some(
            (read) => read.attempt.attemptId === ATTEMPT_TWO_ID,
          ),
        ).toBe(true),
      );
      expect(
        draftReads(messenger).every(
          (read) => read.attempt.attemptId === ATTEMPT_TWO_ID,
        ),
      ).toBe(true);
      // A later valid poll supersedes it, and survives the run's omission.
      listFails = false;
      listBatches = [runWith(retryable(ATTEMPT_C, 5))];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
      listBatches = [];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    });

    it("keeps one item's accepted Retry replacement when another item's older Check status snapshot lands", async () => {
      const held = gate();
      resolveGate = held.promise;
      const OP_X = "00000000-0000-4000-8000-000000000001";
      const OP_Y = "00000000-0000-4000-8000-000000000002";
      const PROFILE_Y = "33333333-3333-4333-8333-333333333334";
      const ATTEMPT_Y = "55555555-5555-4555-8555-555555555556";
      const itemX: ProfileSyncItem = {
        ...syncItem(1, DEST_HOST_ID, "unavailable", []),
        preview: null,
        outcome: retryable(ATTEMPT_ID, 3),
      };
      const itemY: ProfileSyncItem = {
        ...withSourceProfile(
          syncItem(2, DEST_HOST_ID, "unavailable", []),
          PROFILE_Y,
        ),
        preview: null,
        outcome: profileCopyOutcome({
          attempt: profileCopyAttempt({
            operationId: OP_Y,
            sourceProfileId: PROFILE_Y,
            attemptId: ATTEMPT_Y,
          }),
          revision: 3,
          state: "blocked",
          reason: "unreachable",
        }),
      };
      expect(itemX.operationId).toBe(OP_X);
      expect(itemY.operationId).toBe(OP_Y);
      const replacementY = recordedOutcome({
        attempt: profileCopyAttempt({
          operationId: OP_Y,
          sourceProfileId: PROFILE_Y,
          attemptId: ATTEMPT_C,
        }),
        revision: 4,
        state: "sign-in-required",
      });
      retryOutcome = replacementY;
      draftStatusOutcome = replacementY;
      listBatches = [
        { ...runWith(retryable(ATTEMPT_ID, 3)), items: [itemX, itemY] },
      ];
      const messenger = mountWith({
        rules: [],
        providers: defaultProviders(),
        previewItems: noItems,
        startItems: noItems,
      });
      const retries = () =>
        messenger.calls.filter(
          (call) => call.method === "providers.profileCopy.retry",
        );
      const draftReads = () =>
        messenger.calls
          .filter((call) => call.method === "providers.profileCopy.draftStatus")
          .map((call) => profileCopyDraftRequestSchema.parse(call.params));
      try {
        openSync(null);
        fireEvent.click(
          await screen.findByRole("button", { name: /profile transfers/ }),
        );
        await waitFor(() =>
          expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(
            2,
          ),
        );
        // Hold X's Check status: its dispatch captured Y at attempt A.
        fireEvent.click(
          screen.getAllByRole("button", { name: "Check status" })[0],
        );
        await waitFor(() =>
          expect(
            messenger.calls.filter(
              (call) => call.method === "providers.profileCopy.sync.resolve",
            ),
          ).toHaveLength(1),
        );
        // Meanwhile Y's Retry is accepted, with the list refetch failing.
        listFails = true;
        fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[1]);
        await waitFor(() => expect(retries()).toHaveLength(1));
        expect(
          profileCopyRetryRequestSchema.parse(retries()[0].params).attempt
            .attemptId,
        ).toBe(ATTEMPT_Y);
        // Y's old Retry is gone; only X's remains.
        await waitFor(() =>
          expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(
            1,
          ),
        );
      } finally {
        held.release();
      }
      // X's older snapshot (with Y at attempt A) lands and must not undo Y.
      await waitFor(() =>
        expect(
          screen
            .getAllByRole("button", { name: "Check status" })[0]
            .hasAttribute("disabled"),
        ).toBe(false),
      );
      expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
      // Y's follow-ups still go to the replacement attempt.
      fireEvent.click(screen.getAllByRole("button", { name: "Review…" })[1]);
      await waitFor(() =>
        expect(
          draftReads().some((read) => read.attempt.attemptId === ATTEMPT_C),
        ).toBe(true),
      );
      expect(
        draftReads().every((read) => read.attempt.attemptId !== ATTEMPT_Y),
      ).toBe(true);
    });

    it("does not regress a newer polled receipt when an older attempt's held Retry answers", async () => {
      const held = gate();
      retryGate = held.promise;
      retryOutcome = replacement();
      const messenger = mountRun();
      await openRun();
      try {
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        await waitFor(() =>
          expect(
            messenger.calls.filter(
              (call) => call.method === "providers.profileCopy.retry",
            ),
          ).toHaveLength(1),
        );
        // While held, the list moves on to a newer, unrelated attempt.
        listBatches = [runWith(retryable(ATTEMPT_C, 5))];
        await act(async () => {
          await vi.advanceTimersByTimeAsync(6_000);
        });
        listFails = true;
      } finally {
        held.release();
      }
      const sent = profileCopyRetryRequestSchema.parse(
        messenger.calls.filter(
          (call) => call.method === "providers.profileCopy.retry",
        )[0].params,
      );
      expect(sent.attempt.attemptId).toBe(ATTEMPT_ID);
      await waitFor(() =>
        expect(
          screen
            .getByRole("button", { name: "Retry" })
            .hasAttribute("disabled"),
        ).toBe(false),
      );
      // The older answer does not overwrite the newer attempt's receipt.
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    });
  });
});
