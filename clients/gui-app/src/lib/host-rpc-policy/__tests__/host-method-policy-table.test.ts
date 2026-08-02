import { afterEach, describe, expect, it, vi } from "vitest";
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
  PROVIDERS_INSTALLING_POLL_LANE,
  PROVIDERS_LIMITED_POLL_LANE,
  PROVIDERS_PENDING_POLL_LANE,
  PROVIDERS_RETRY_OBSERVATION_GRACE_MS,
  PROVIDERS_RETRY_SCHEDULED_POLL_LANE,
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
    expect(HOST_METHOD_POLL_TABLE["agent.roles.claim"].mode).toBe("fifo");
    expect(HOST_METHOD_POLL_TABLE["agent.roles.list"].mode).toBe("latest");
    expect(HOST_METHOD_POLL_TABLE["agent.roles.relinquish"].mode).toBe("fifo");
  });

  it("keeps ordinary provider listing latest but serializes forced auth refresh", () => {
    expect(
      hostRpcSchedulingPolicy.modeFor("providers.list", { native: null }),
    ).toBe("latest");
    expect(
      hostRpcSchedulingPolicy.modeFor("providers.list", {
        forceAuthRefresh: true,
        native: null,
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

  it("orders providers lanes installing, pending, retry, limited, then steady", () => {
    const policy = HOST_METHOD_POLL_TABLE["providers.list"].poll;

    expect(policy.classify(undefined)).toBe(false);
    // Ahead of the probe lane, and the fixture proves the ordering rather than
    // the arm: both conditions hold at once here, which is the ordinary first
    // boot (shell probe running, packs converging). Classified as `pending` a
    // download's progress would decay to a 30-second refresh.
    expect(
      policy.classify({
        providers: [
          {
            enabled: true,
            authPending: true,
            availabilityPending: false,
            candidates: [],
            profiles: [],
            managedInstallState: { status: "downloading", percent: 40 },
          },
        ],
      }),
    ).toBe(PROVIDERS_INSTALLING_POLL_LANE);
    // ...and it is the DOWNLOADING arm specifically, not "a managed pack
    // exists". A settled pack must fall straight through to steady, or every
    // host with a registry would poll `providers.list` every 5s forever.
    expect(
      policy.classify({
        providers: [
          {
            enabled: true,
            authPending: false,
            availabilityPending: false,
            candidates: [],
            profiles: [],
            managedInstallState: { status: "installed" },
          },
        ],
      }),
    ).toBe(PROVIDERS_STEADY_POLL_LANE);
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

  // Not cosmetic, and the reason it is asserted as a bound rather than as two
  // magic numbers: `providers.list` is the ONLY source of managed-install
  // progress, and the host reports `downloading` at a full fraction for the
  // whole extract-and-verify phase. At the pending lane's 30s ceiling - let
  // alone steady's 15 minutes - a finished-looking bar sits frozen on screen
  // for exactly the stretch where a user concludes the install is hung.
  it("keeps the installing lane fast enough to animate a progress bar", () => {
    expect(PROVIDERS_INSTALLING_POLL_LANE.maxDelayMs).toBeLessThanOrEqual(
      5 * 1_000,
    );
    expect(PROVIDERS_INSTALLING_POLL_LANE.maxDelayMs).toBeLessThan(
      PROVIDERS_PENDING_POLL_LANE.maxDelayMs,
    );
  });

  // P7. Before this lane an `error` cell fell straight to `providers.steady`,
  // so a wifi blip the host recovered from in a minute left "Setup failed" on
  // screen for up to fifteen - and post-cutover that is a user who cannot run
  // the turn that would have refreshed the list.
  describe("the providers retry-scheduled lane", () => {
    const NOW_MS = 1_800_000_000_000;

    afterEach(() => {
      vi.useRealTimers();
    });

    const classifyAt = (
      nowMs: number,
      retryAtMs: number | null,
    ): ConditionPollLane | false => {
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);
      return HOST_METHOD_POLL_TABLE["providers.list"].poll.classify({
        providers: [
          {
            enabled: true,
            authPending: false,
            availabilityPending: false,
            candidates: [],
            profiles: [],
            managedInstallState: {
              status: "error",
              reason: "network",
              retryAtMs,
            },
          },
        ],
      });
    };

    it("watches a failure whose retry is still ahead", () => {
      expect(classifyAt(NOW_MS, NOW_MS + 45_000)).toBe(
        PROVIDERS_RETRY_SCHEDULED_POLL_LANE,
      );
    });

    // The half that a bare `retryAtMs > now` check would get wrong. Nothing on
    // the host fires AT `retryAtMs` - it is a backoff memo, and the attempt
    // rides on the next kick - so the transition lands after eligibility, not
    // at it. Dropping to steady the instant the deadline passes would miss
    // exactly the window the lane was added for.
    it("keeps watching through the grace window after eligibility arrives", () => {
      expect(
        classifyAt(
          NOW_MS,
          NOW_MS - PROVIDERS_RETRY_OBSERVATION_GRACE_MS + 1_000,
        ),
      ).toBe(PROVIDERS_RETRY_SCHEDULED_POLL_LANE);
    });

    // ...and the bound is real. A cell whose retry came due long ago is not
    // about to heal; it is waiting for a kick nobody scheduled, and the kick's
    // own arrival refreshes the list anyway.
    it("stops watching once the grace window closes", () => {
      expect(
        classifyAt(NOW_MS, NOW_MS - PROVIDERS_RETRY_OBSERVATION_GRACE_MS),
      ).toBe(PROVIDERS_STEADY_POLL_LANE);
    });

    // `unrepairable` and the deliberately un-memoed failures report
    // `retryAtMs: null`. Watching them would poll forever for a transition the
    // host has already said will never come.
    it("leaves a terminal failure on the steady lane", () => {
      expect(classifyAt(NOW_MS, null)).toBe(PROVIDERS_STEADY_POLL_LANE);
    });

    it("yields to a download in flight and to an unsettled probe", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW_MS);
      const failing = {
        enabled: true,
        authPending: false,
        availabilityPending: false,
        candidates: [],
        profiles: [],
        managedInstallState: {
          status: "error",
          reason: "network",
          retryAtMs: NOW_MS + 45_000,
        },
      };
      const policy = HOST_METHOD_POLL_TABLE["providers.list"].poll;
      expect(
        policy.classify({
          providers: [
            failing,
            {
              enabled: true,
              authPending: false,
              availabilityPending: false,
              candidates: [],
              profiles: [],
              managedInstallState: { status: "downloading", percent: 12 },
            },
          ],
        }),
      ).toBe(PROVIDERS_INSTALLING_POLL_LANE);
      expect(
        policy.classify({
          providers: [
            failing,
            {
              enabled: true,
              authPending: true,
              availabilityPending: false,
              candidates: [],
              profiles: [],
            },
          ],
        }),
      ).toBe(PROVIDERS_PENDING_POLL_LANE);
      // ...but it outranks the rate-limit lane, which starts at the ceiling
      // this one only decays to.
      expect(
        policy.classify({
          providers: [
            failing,
            {
              enabled: true,
              authPending: false,
              availabilityPending: false,
              candidates: [],
              profiles: [{ rateLimitStatus: "near_limit" }],
            },
          ],
        }),
      ).toBe(PROVIDERS_RETRY_SCHEDULED_POLL_LANE);
    });

    // The whole point of the lane, stated as a bound rather than as the two
    // numbers: it has to be faster than the lane it replaces, or it is a new
    // id doing nothing.
    it("is faster than the steady lane it takes the cell off", () => {
      expect(PROVIDERS_RETRY_SCHEDULED_POLL_LANE.maxDelayMs).toBeLessThan(
        PROVIDERS_STEADY_POLL_LANE.initialDelayMs,
      );
      expect(PROVIDERS_RETRY_SCHEDULED_POLL_LANE.initialDelayMs).toBeLessThan(
        PROVIDERS_RETRY_OBSERVATION_GRACE_MS,
      );
    });
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
