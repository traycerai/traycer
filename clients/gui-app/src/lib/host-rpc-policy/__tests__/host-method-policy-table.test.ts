import { describe, expect, it } from "vitest";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import {
  GIT_DIRTY_SUBMODULE_POLL_LANE,
  GIT_INITIAL_ERROR_POLL_LANE,
  GIT_STALE_ERROR_POLL_LANE,
  HARNESS_ALL_AVAILABLE_POLL_LANE,
  HARNESS_INITIAL_ERROR_POLL_LANE,
  HARNESS_PENDING_POLL_LANE,
  HARNESS_STALE_ERROR_POLL_LANE,
  HARNESS_UNAVAILABLE_POLL_LANE,
  HOST_METHOD_POLL_TABLE,
  NOTIFICATION_INDICATOR_ERROR_POLL_LANE,
  ONBOARDING_DRAFT_INITIAL_ERROR_POLL_LANE,
  ONBOARDING_DRAFT_PROVIDERS_UNSETTLED_POLL_LANE,
  ONBOARDING_DRAFT_STALE_ERROR_POLL_LANE,
  PROVIDERS_INITIAL_ERROR_POLL_LANE,
  PROVIDERS_LIMITED_POLL_LANE,
  PROVIDERS_PENDING_POLL_LANE,
  PROVIDERS_STALE_ERROR_POLL_LANE,
  PROVIDERS_STEADY_POLL_LANE,
  SPEECH_MODEL_INITIAL_ERROR_POLL_LANE,
  SPEECH_MODEL_DOWNLOADING_POLL_LANE,
  SPEECH_MODEL_STALE_ERROR_POLL_LANE,
  WORKTREE_SETUP_INITIAL_ERROR_POLL_LANE,
  WORKTREE_SETUP_IN_FLIGHT_POLL_LANE,
  WORKTREE_SETUP_STALE_ERROR_POLL_LANE,
  assertExactHostMethodPollTableKeys,
  hostRpcSchedulingPolicy,
} from "@/lib/host-rpc-policy/host-method-policy-table";
import type {
  ConditionPollLane,
  ErasedConditionPollPolicy,
} from "@/lib/host-rpc-policy/host-method-policy-table";

const typedProvidersClassifier = (
  data: ResponseOfMethod<HostRpcRegistry, "providers.list"> | undefined,
): ConditionPollLane | false =>
  data === undefined ? false : PROVIDERS_STEADY_POLL_LANE;

const typedToErasedPolicy: ErasedConditionPollPolicy<"providers.list"> = {
  kind: "condition",
  method: "providers.list",
  classify: typedProvidersClassifier,
  initialErrorLane: PROVIDERS_INITIAL_ERROR_POLL_LANE,
  staleDataErrorLane: PROVIDERS_STALE_ERROR_POLL_LANE,
  resetLaneIds: new Set([PROVIDERS_STEADY_POLL_LANE.id]),
};

// @ts-expect-error The phantom method field must reject a policy under another key.
const wrongKeyPolicy: ErasedConditionPollPolicy<"agent.gui.listHarnesses"> =
  typedToErasedPolicy;

describe("host method poll policy table", () => {
  it("has exactly the host registry's method keys", () => {
    expect(() =>
      assertExactHostMethodPollTableKeys(HOST_METHOD_POLL_TABLE),
    ).not.toThrow();
    expect(Object.keys(HOST_METHOD_POLL_TABLE).sort()).toEqual(
      Object.keys(hostRpcRegistry).sort(),
    );
  });

  it("keeps the typed classifier assignable to erased storage without casts", () => {
    expect(typedToErasedPolicy.method).toBe("providers.list");
    expect(typedToErasedPolicy.classify(undefined)).toBe(false);
    expect(wrongKeyPolicy.method).toBe("providers.list");
  });

  it("declares scheduling posture and a join timeout for every registry method", () => {
    for (const entry of Object.values(HOST_METHOD_POLL_TABLE)) {
      expect(
        entry.mode === "latest" ||
          entry.mode === "fifo" ||
          entry.mode === "join" ||
          typeof entry.mode === "function",
      ).toBe(true);
      expect(
        entry.joinResponseTimeoutMs === null || entry.joinResponseTimeoutMs > 0,
      ).toBe(true);
    }
  });

  it("keeps ambiguous verbs on their declared side of the command/read boundary", () => {
    expect(HOST_METHOD_POLL_TABLE["agent.tui.prepareLaunch"].mode).toBe("fifo");
    expect(HOST_METHOD_POLL_TABLE["workspace.prepareFolders"].mode).toBe(
      "fifo",
    );
    expect(HOST_METHOD_POLL_TABLE["speech.ensureModel"].mode).toBe("fifo");
    expect(
      HOST_METHOD_POLL_TABLE["workspace.resolvePathsByRepoIdentifiers"].mode,
    ).toBe("latest");
    expect(HOST_METHOD_POLL_TABLE["providers.touchLogin"].mode).toBe("fifo");
    expect(HOST_METHOD_POLL_TABLE["worktree.retrySetup"].mode).toBe("fifo");
  });

  it("keeps ordinary provider listing latest but serializes forced auth refresh", () => {
    expect(hostRpcSchedulingPolicy.modeFor("providers.list", {})).toBe(
      "latest",
    );
    expect(
      hostRpcSchedulingPolicy.modeFor("providers.list", {
        forceAuthRefresh: true,
      }),
    ).toBe("fifo");
  });

  it("joins provider login waits under the fixed sixteen-minute response budget", () => {
    expect(HOST_METHOD_POLL_TABLE["providers.awaitLogin"].mode).toBe("join");
    expect(
      hostRpcSchedulingPolicy.joinResponseTimeoutMs("providers.awaitLogin"),
    ).toBe(16 * 60 * 1_000);
  });

  it("narrows null and fixed policies", () => {
    const neverPolled: null = HOST_METHOD_POLL_TABLE["host.status"].poll;
    expect(neverPolled).toBeNull();

    const fixed = HOST_METHOD_POLL_TABLE["host.getRateLimitUsage"].poll;
    const intervalMs: number = fixed.intervalMs;
    expect(intervalMs).toBe(15 * 60 * 1_000);
  });

  it("consumes condition cache data as unknown", () => {
    const data: unknown = {
      providers: [
        {
          enabled: true,
          authPending: true,
          availabilityPending: false,
          candidates: [],
          profiles: [],
        },
      ],
    };
    const policy = HOST_METHOD_POLL_TABLE["providers.list"].poll;
    expect(policy.classify(data)).toBe(PROVIDERS_PENDING_POLL_LANE);
  });

  it("orders providers lanes pending, limited, then steady", () => {
    const policy = HOST_METHOD_POLL_TABLE["providers.list"].poll;

    expect(policy.classify(undefined)).toBe(false);
    expect(
      policy.classify({
        providers: [
          {
            enabled: true,
            authPending: true,
            availabilityPending: false,
            candidates: [],
            profiles: [{ rateLimitStatus: "near_limit" }],
          },
        ],
      }),
    ).toBe(PROVIDERS_PENDING_POLL_LANE);
    expect(
      policy.classify({
        providers: [
          {
            enabled: false,
            authPending: false,
            availabilityPending: false,
            candidates: [],
            profiles: [{ rateLimitStatus: "hard_limit" }],
          },
        ],
      }),
    ).toBe(PROVIDERS_LIMITED_POLL_LANE);
    expect(policy.classify({ providers: [] })).toBe(PROVIDERS_STEADY_POLL_LANE);
  });

  it("keeps condition error counters independent from their data lanes", () => {
    const policies = [
      {
        policy: HOST_METHOD_POLL_TABLE["agent.gui.listHarnesses"].poll,
        dataLane: HARNESS_PENDING_POLL_LANE,
        initialErrorLane: HARNESS_INITIAL_ERROR_POLL_LANE,
        staleErrorLane: HARNESS_STALE_ERROR_POLL_LANE,
      },
      {
        policy:
          HOST_METHOD_POLL_TABLE[
            "agent.selectionGuide.getGlobalOnboardingDraft"
          ].poll,
        dataLane: ONBOARDING_DRAFT_PROVIDERS_UNSETTLED_POLL_LANE,
        initialErrorLane: ONBOARDING_DRAFT_INITIAL_ERROR_POLL_LANE,
        staleErrorLane: ONBOARDING_DRAFT_STALE_ERROR_POLL_LANE,
      },
      {
        policy: HOST_METHOD_POLL_TABLE["speech.getModelStatus"].poll,
        dataLane: SPEECH_MODEL_DOWNLOADING_POLL_LANE,
        initialErrorLane: SPEECH_MODEL_INITIAL_ERROR_POLL_LANE,
        staleErrorLane: SPEECH_MODEL_STALE_ERROR_POLL_LANE,
      },
      {
        policy: HOST_METHOD_POLL_TABLE["worktree.getBinding"].poll,
        dataLane: WORKTREE_SETUP_IN_FLIGHT_POLL_LANE,
        initialErrorLane: WORKTREE_SETUP_INITIAL_ERROR_POLL_LANE,
        staleErrorLane: WORKTREE_SETUP_STALE_ERROR_POLL_LANE,
      },
      {
        policy: HOST_METHOD_POLL_TABLE["git.listChangedFiles"].poll,
        dataLane: GIT_DIRTY_SUBMODULE_POLL_LANE,
        initialErrorLane: GIT_INITIAL_ERROR_POLL_LANE,
        staleErrorLane: GIT_STALE_ERROR_POLL_LANE,
      },
      {
        policy: HOST_METHOD_POLL_TABLE["providers.list"].poll,
        dataLane: PROVIDERS_PENDING_POLL_LANE,
        initialErrorLane: PROVIDERS_INITIAL_ERROR_POLL_LANE,
        staleErrorLane: PROVIDERS_STALE_ERROR_POLL_LANE,
      },
    ];

    for (const entry of policies) {
      expect(entry.policy.initialErrorLane).toBe(entry.initialErrorLane);
      expect(entry.policy.staleDataErrorLane).toBe(entry.staleErrorLane);
      expect(entry.initialErrorLane.id).not.toBe(entry.dataLane.id);
      expect(entry.staleErrorLane.id).not.toBe(entry.dataLane.id);
      expect(entry.initialErrorLane.id).not.toBe(entry.staleErrorLane.id);
      expect(entry.initialErrorLane.initialDelayMs).toBe(
        entry.dataLane.initialDelayMs,
      );
      expect(entry.initialErrorLane.maxDelayMs).toBe(entry.dataLane.maxDelayMs);
      expect(entry.staleErrorLane.initialDelayMs).toBe(
        entry.dataLane.initialDelayMs,
      );
      expect(entry.staleErrorLane.maxDelayMs).toBe(entry.dataLane.maxDelayMs);
    }
  });

  it("orders harness lanes pending, unavailable, then all-available", () => {
    const policy = HOST_METHOD_POLL_TABLE["agent.gui.listHarnesses"].poll;

    expect(policy.classify(undefined)).toBe(false);
    expect(
      policy.classify({
        harnesses: [
          { availabilityPending: true, available: false },
          { availabilityPending: false, available: false },
        ],
      }),
    ).toBe(HARNESS_PENDING_POLL_LANE);
    expect(
      policy.classify({
        harnesses: [{ availabilityPending: false, available: false }],
      }),
    ).toBe(HARNESS_UNAVAILABLE_POLL_LANE);
    expect(
      policy.classify({
        harnesses: [{ availabilityPending: false, available: true }],
      }),
    ).toBe(HARNESS_ALL_AVAILABLE_POLL_LANE);
  });

  it("polls onboarding drafts only while providers are unsettled and content is absent", () => {
    const policy =
      HOST_METHOD_POLL_TABLE["agent.selectionGuide.getGlobalOnboardingDraft"]
        .poll;

    expect(policy.classify({ content: null, providersSettled: false })).toBe(
      ONBOARDING_DRAFT_PROVIDERS_UNSETTLED_POLL_LANE,
    );
    expect(policy.classify({ content: null, providersSettled: true })).toBe(
      false,
    );
    expect(policy.classify({ content: "draft", providersSettled: false })).toBe(
      false,
    );
  });

  it("polls speech model status only while downloading", () => {
    const policy = HOST_METHOD_POLL_TABLE["speech.getModelStatus"].poll;

    expect(policy.classify({ downloadState: "downloading" })).toBe(
      SPEECH_MODEL_DOWNLOADING_POLL_LANE,
    );
    expect(policy.classify({ downloadState: "ready" })).toBe(false);
  });

  it("polls worktree bindings while any entry is pending or running", () => {
    const policy = HOST_METHOD_POLL_TABLE["worktree.getBinding"].poll;

    expect(
      policy.classify({
        binding: { entries: [{ mode: "worktree", setupState: "pending" }] },
      }),
    ).toBe(WORKTREE_SETUP_IN_FLIGHT_POLL_LANE);
    expect(
      policy.classify({
        binding: { entries: [{ mode: "worktree", setupState: "running" }] },
      }),
    ).toBe(WORKTREE_SETUP_IN_FLIGHT_POLL_LANE);
    expect(
      policy.classify({
        binding: { entries: [{ mode: "worktree", setupState: "ready" }] },
      }),
    ).toBe(false);
    expect(
      policy.classify({
        binding: { entries: [{ mode: "directory", setupState: "pending" }] },
      }),
    ).toBe(false);
    expect(policy.classify({ binding: null })).toBe(false);
  });

  it("polls dirty git submodule snapshots and stops when clean", () => {
    const policy = HOST_METHOD_POLL_TABLE["git.listChangedFiles"].poll;

    expect(
      policy.classify({
        submodules: [{ availability: { state: "unavailable" }, files: [] }],
      }),
    ).toBe(GIT_DIRTY_SUBMODULE_POLL_LANE);
    expect(
      policy.classify({
        submodules: [{ availability: { state: "ok" }, files: [{}] }],
      }),
    ).toBe(GIT_DIRTY_SUBMODULE_POLL_LANE);
    expect(policy.classify({ submodules: [] })).toBe(false);
  });

  it("keeps notification indicator polling terminal until a future classifier is declared", () => {
    const policy =
      HOST_METHOD_POLL_TABLE["host.notifications.indicatorState"].poll;

    expect(policy.classify(undefined)).toBe(false);
    expect(policy.initialErrorLane).toBe(
      NOTIFICATION_INDICATOR_ERROR_POLL_LANE,
    );
    expect(policy.staleDataErrorLane).toBe(
      NOTIFICATION_INDICATOR_ERROR_POLL_LANE,
    );
  });
});
