import "@/components/settings/details/environment-details-providers";
import { QueryClient, queryOptions } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SandboxCost,
  SandboxHistoryEntry,
  SandboxListResponse,
} from "@traycer/protocol/host/sandbox-control";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { sandboxQueryKeys } from "@/lib/query-keys";
import { frozenDestroyAt } from "@/lib/sandboxes/sandbox-balance";
import { sandboxDetailsEntry } from "@/lib/sandboxes/sandbox-details-provider";
import {
  formatSandboxDate,
  formatSandboxUtcDay,
} from "@/lib/sandboxes/sandbox-row-lines";
import { SANDBOX_LIST_FAILED } from "@/lib/sandboxes/sandbox-strings";
import { getDetailsProvider } from "@/lib/settings-details-entry";
import { useAuthStore } from "@/stores/auth/auth-store";

const NOW = 1_791_100_000_000;

describe("sandboxDetailsEntry", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("exports the sandbox id as the support reference", () => {
    const summary = sandboxSummaryFixture({ id: "sbx_support_42" });
    const exported = sandboxDetailsEntry({
      summary,
      cost: null,
      wakeString: null,
      viewerUserId: null,
      personal: true,
      now: NOW,
    }).export();
    expect(exported.sandboxId).toBe("sbx_support_42");
    expect(exported.status["Support reference"]).toBe("sbx_support_42");
  });

  it("shows a failed row's support reference and keeps the raw code only in the export", () => {
    const entry = sandboxDetailsEntry({
      summary: sandboxSummaryFixture({
        id: "sbx_support_42",
        state: "failed",
        failureCode: "create:kube-create-service-account",
      }),
      cost: null,
      wakeString: null,
      viewerUserId: null,
      personal: true,
      now: NOW,
    });
    const rows = entry.status.map((row) => [row.label, row.value]);
    expect(rows).toContainEqual([
      "Failed",
      "Failed to start · The sandbox service couldn't start it. · SBX-0412",
    ]);
    expect(rows).toContainEqual([
      "Support reference",
      "SBX-0412 · sbx_support_42",
    ]);
    expect(JSON.stringify(rows)).not.toContain("create:");
    expect(entry.export().status["Failure code"]).toBe(
      "create:kube-create-service-account",
    );
  });

  it.each([
    ["boot-timeout", "The sandbox took too long to start."],
    ["boot-token-delivery", "The sandbox couldn't sign in to Traycer."],
    ["grant_set_failed", "The sandbox couldn't get access to its settings."],
    [
      "environment_placement_failed",
      "The sandbox couldn't join the selected environment.",
    ],
    ["provider-unavailable", "Sandboxes aren't available right now."],
    ["provider-pending", "The sandbox service hasn't finished starting it."],
    ["create", "The sandbox service couldn't start it."],
  ])("explains a failed start at %s in Details", (stage, reason) => {
    const entry = sandboxDetailsEntry({
      summary: sandboxSummaryFixture({
        state: "failed",
        failureCode: `${stage}:provider-detail`,
      }),
      cost: null,
      wakeString: null,
      viewerUserId: null,
      personal: true,
      now: NOW,
    });

    expect(entry.status.find((row) => row.label === "Failed")?.value).toContain(
      reason,
    );
  });

  it.each([null, "unknown-stage:provider-detail"] as const)(
    "keeps the generic failed-start sentence for an unrecognized code (%s)",
    (failureCode) => {
      const entry = sandboxDetailsEntry({
        summary: sandboxSummaryFixture({ state: "failed", failureCode }),
        cost: null,
        wakeString: null,
        viewerUserId: null,
        personal: true,
        now: NOW,
      });

      const value = entry.status.find((row) => row.label === "Failed")?.value;
      expect(value).toContain("Failed to start");
      if (failureCode !== null) expect(value).not.toContain(failureCode);
    },
  );

  it("shows the region label the server sends in the Region row", () => {
    const entry = sandboxDetailsEntry({
      summary: sandboxSummaryFixture({
        region: "us-west-3",
        regionLabel: "United States (West)",
      }),
      cost: null,
      wakeString: null,
      viewerUserId: null,
      personal: true,
      now: NOW,
    });
    expect(entry.export().status.Region).toBe("United States (West)");
  });

  it("reads a segment's cost below a cent as under $0.01, and a cent or more in dollars", () => {
    const segment = (millicredits: number) => ({
      state: "awake" as const,
      fromAt: NOW - 3_600_000,
      toAt: NOW - 1_800_000,
      millicredits,
    });
    const history = (millicredits: number) =>
      sandboxDetailsEntry({
        summary: sandboxSummaryFixture({}),
        cost: {
          sandboxId: "sbx_1",
          currentRateMillicreditsPerHour: 120,
          state: "awake",
          frozen: false,
          charged: {
            computeMillicredits: 0,
            storageMillicredits: 0,
            sinceCreatedAt: NOW - 86_400_000,
          },
          pendingMillicredits: 0,
          segments: [segment(millicredits)],
          todayMillicredits: 0,
          todayAwakeMs: null,
          history: [],
        },
        wakeString: null,
        viewerUserId: null,
        personal: true,
        now: NOW,
      }).history.find((event) => event.label === "Awake")?.value;
    expect(history(3)).toMatch(/ · under \$0\.01$/);
    expect(history(20)).toMatch(/ · \$0\.02$/);
  });

  it("dates a frozen sandbox's destroy to the minute", () => {
    const frozenAt = new Date(2026, 9, 9, 12, 0).getTime();
    const entry = sandboxDetailsEntry({
      summary: sandboxSummaryFixture({ frozen: true, frozenAt }),
      cost: null,
      wakeString: null,
      viewerUserId: null,
      personal: true,
      now: NOW,
    });

    expect(entry.export().status["Out of credits"]).toMatch(
      /^out of credits since [A-Z][a-z]{2} \d{1,2} at \d{2}:\d{2}; destroyed on [A-Z][a-z]{2} \d{1,2} at \d{2}:\d{2}$/,
    );
  });

  it("lists Kept with no time, since the summary carries none for it", () => {
    const summary = sandboxSummaryFixture({
      keptBy: { userId: "u-priya", displayName: "Priya" },
      lastTransitionAt: NOW - 60_000,
    });
    const entry = sandboxDetailsEntry({
      summary,
      cost: null,
      wakeString: null,
      viewerUserId: null,
      personal: true,
      now: NOW,
    });
    const kept = entry.history.find((event) => event.label === "Kept");
    expect(kept?.at).toBeNull();
    expect(entry.history.at(-1)?.label).toBe("Kept");
    expect(
      entry.export().history.find((event) => event.event === "Kept")?.at,
    ).toBeNull();
  });

  it("carries no path, route or guest-authored text in the export", () => {
    const summary = sandboxSummaryFixture({
      state: "awake",
      guestConfigured: false,
      guestConfigFailureReason:
        "could not write /home/dev/.ssh/id_rsa: token=sk-secret-value",
      routes: [{ route: "host-route-secret", state: "unavailable", code: "x" }],
      failureCode: "boom",
    });
    const json = JSON.stringify(
      sandboxDetailsEntry({
        summary,
        cost: null,
        wakeString: null,
        viewerUserId: null,
        personal: true,
        now: NOW,
      }).export(),
    );
    expect(json).not.toContain("/home/dev");
    expect(json).not.toContain("sk-secret-value");
    expect(json).not.toContain("host-route-secret");
    expect(json).not.toMatch(/(^|[\s"])\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]/);
  });

  it("names no creator for a row that names none outside Personal", () => {
    const summary = sandboxSummaryFixture({ createdBy: null, burst: false });
    const entry = sandboxDetailsEntry({
      summary,
      cost: null,
      wakeString: null,
      viewerUserId: "u-me",
      personal: false,
      now: NOW,
    });
    expect(entry.export().status["Started by"]).toBeUndefined();
    expect(
      entry.history.find((event) => event.label === "Created")?.value,
    ).toBe("");
    const mine = sandboxDetailsEntry({
      summary,
      cost: null,
      wakeString: null,
      viewerUserId: "u-me",
      personal: true,
      now: NOW,
    });
    expect(mine.export().status["Started by"]).toBe("you");
  });

  it("reads a kept sandbox's member starter, and keeps the agent's name out of the status and the export", () => {
    const entry = sandboxDetailsEntry({
      summary: sandboxSummaryFixture({
        createdBy: null,
        burst: false,
        createdByAgentId: "agent-planner",
        createdByAgentName: "Planner",
      }),
      cost: null,
      wakeString: null,
      viewerUserId: "u-me",
      personal: true,
      now: NOW,
    });
    const startedBy = entry.status.find((row) => row.label === "Started by");
    expect(startedBy?.value).toBe("you");
    expect(JSON.stringify(entry.status)).not.toContain("Planner");
    expect(entry.export().status["Started by"]).toBe("you");
    expect(JSON.stringify(entry.export())).not.toContain("Planner");
  });

  it("gives an agent's sandbox no Resting row beside its self-destroying Idle row", () => {
    const entry = sandboxDetailsEntry({
      summary: sandboxSummaryFixture({
        burst: true,
        destroyAfterRestingMinutes: null,
      }),
      cost: null,
      wakeString: null,
      viewerUserId: null,
      personal: false,
      now: NOW,
    });
    expect(entry.export().status.Idle).toMatch(/destroys itself/);
    expect(entry.export().status.Resting).toBeUndefined();
  });

  it("labels the retention clock by the suspended or stopped state it starts from", () => {
    const entry = sandboxDetailsEntry({
      summary: sandboxSummaryFixture({
        burst: false,
        destroyAfterRestingMinutes: 7 * 24 * 60,
      }),
      cost: null,
      wakeString: null,
      viewerUserId: null,
      personal: true,
      now: NOW,
    });

    expect(
      entry.status.find((row) => row.label === "Suspended or stopped for")
        ?.value,
    ).toBe("destroyed after 7 days");
  });

  // The announced day is read in UTC whatever zone the runtime is in, so the
  // zone is PINNED to one that is not UTC: left to the runner's own zone this
  // case is vacuous on a UTC runner, where a local reading and a UTC reading
  // name the same day. The sibling pin on `sandboxWithdrawalLine` covers the
  // card's sentence; this one covers the Details row, which is a second call
  // site of the same formatter and could regress on its own.
  it('gives an unfrozen withdrawn row no Resting row, an Idle row, and a Destroyed-on row naming the announced day with no "unless used"', () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    // The pin itself has to take, or the case proves nothing.
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(
      "America/Los_Angeles",
    );

    const endsAt = Date.UTC(2026, 11, 1);
    const entry = sandboxDetailsEntry({
      summary: sandboxSummaryFixture({
        burst: false,
        destroyAfterRestingMinutes: null,
        destroyAt: null,
        withdrawalEndsAt: endsAt,
      }),
      cost: null,
      wakeString: null,
      viewerUserId: null,
      personal: false,
      now: NOW,
    });
    const status = entry.export().status;
    expect(status.Idle).toMatch(/suspends after/);
    expect(status.Resting).toBeUndefined();
    // Computed, not written out: the formatter renders in the runtime's own
    // default locale, so a literal `Dec 1, 2026` would fail under any other
    // one while the UTC day was named correctly.
    const dayOptions: Intl.DateTimeFormatOptions = {
      month: "short",
      day: "numeric",
      year: "numeric",
    };
    const utcDay = new Date(endsAt).toLocaleDateString(undefined, {
      ...dayOptions,
      timeZone: "UTC",
    });
    const localDay = new Date(endsAt).toLocaleDateString(undefined, dayOptions);
    // The pin only proves anything if the two readings actually diverge for
    // this instant and zone; a runner where they coincide would pass this
    // case for the wrong reason.
    expect(utcDay).not.toBe(localDay);
    expect(status["Destroyed on"]).toBe(utcDay);
    expect(status["Destroyed on"]).not.toContain(localDay);
    expect(status["Destroyed on"]).not.toContain("unless used");
  });

  it("names the frozen day-30 deadline bare, never the later withdrawal date and never with 'unless used', for a frozen row that carries both", () => {
    const frozenAt = Date.UTC(2026, 10, 1);
    const destroyAt = frozenDestroyAt(frozenAt);
    const withdrawalEndsAt = Date.UTC(2026, 11, 15);
    const entry = sandboxDetailsEntry({
      summary: sandboxSummaryFixture({
        burst: false,
        // A resting policy is set as well, so the row carries both a freeze
        // and a retention policy at once. It does not make a resting reading
        // of THIS deadline available — the server answers a frozen row's
        // `destroyAt` from its freeze — so the pair that proves `frozen` is
        // the discriminator is the case below, not this one.
        destroyAfterRestingMinutes: 7 * 24 * 60,
        frozen: true,
        frozenAt,
        destroyAt,
        withdrawalEndsAt,
      }),
      cost: null,
      wakeString: null,
      viewerUserId: null,
      personal: false,
      now: NOW,
    });
    const status = entry.export().status;
    // Computed, not written out, for the same locale reason as the case
    // above. The row is matched EXACTLY: the bug this guards against
    // produced a well-formed row carrying the wrong day, and an exact match
    // is what rules out both that day and a trailing `unless used`.
    const destroyDay = formatSandboxDate(destroyAt, true);
    const withdrawalDay = formatSandboxUtcDay(withdrawalEndsAt);
    expect(destroyDay).not.toBe(withdrawalDay);
    expect(status["Destroyed on"]).toBe(destroyDay);
    // The same day, stated the same way, by the row beside it — the
    // agreement that makes the bare day right rather than merely shorter.
    expect(status["Out of credits"]).toContain(`destroyed on ${destroyDay}`);
  });

  // Both arms of that branch, on ONE pair of inputs that differs in `frozen`
  // and nothing else: the same `destroyAt`, neither row withdrawn. That is
  // what makes `frozen` the proven discriminator — the case above pairs a
  // frozen row with an unfrozen one that is also withdrawn, so a branch on
  // the withdrawal's presence would satisfy it too.
  //
  // Both directions are needed: without the clause case the clause could be
  // deleted from the row outright, and without the bare case it could be
  // appended to every row, with half the rule still passing either way.
  it("states the day bare for a frozen row and with 'unless used' for an unfrozen one, on the same deadline", () => {
    const frozenAt = Date.UTC(2026, 9, 9);
    const destroyAt = frozenDestroyAt(frozenAt);
    const day = formatSandboxDate(destroyAt, true);
    const rowFor = (frozen: boolean): Record<string, string> =>
      sandboxDetailsEntry({
        summary: sandboxSummaryFixture({
          burst: false,
          destroyAfterRestingMinutes: 7 * 24 * 60,
          frozen,
          frozenAt: frozen ? frozenAt : null,
          destroyAt,
          withdrawalEndsAt: null,
        }),
        cost: null,
        wakeString: null,
        viewerUserId: null,
        personal: false,
        now: NOW,
      }).export().status;

    expect(rowFor(true)["Destroyed on"]).toBe(day);
    // A wake really does reset a resting deadline, so this row keeps saying so.
    expect(rowFor(false)["Destroyed on"]).toBe(`${day} unless used`);
  });
});

/**
 * A query client whose sandbox list answers each read with the next of
 * `answers`, as the control plane would.
 */
async function listedOnce(
  answers: readonly (SandboxListResponse | Error)[],
  userId: string,
): Promise<QueryClient> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let read = 0;
  const nextAnswer = (): Promise<SandboxListResponse> => {
    const answer = answers[Math.min(read, answers.length - 1)];
    read += 1;
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer);
  };
  await queryClient.prefetchQuery(
    queryOptions({
      queryKey: sandboxQueryKeys.list({}, userId),
      queryFn: nextAnswer,
    }),
  );
  return queryClient;
}

function loadSandboxDetails(queryClient: QueryClient, sandboxId: string) {
  const provider = getDetailsProvider("sandbox");
  if (provider === null) throw new Error("expected the sandbox provider");
  return provider(
    { environmentId: "env-personal", kind: "sandbox", key: sandboxId },
    {
      hostId: null,
      // Unused: a sandbox's evidence is the control plane's, not a host's.
      client: {} as HostClient<HostRpcRegistry>,
      queryClient,
    },
  );
}

describe("the Settings Details drawer's sandbox provider", () => {
  beforeEach(() => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: "u-me", username: "me" },
    });
  });
  afterEach(() => {
    useAuthStore.setState({ status: "signed-out", contextMetadata: null });
  });

  it("gives the drawer the sandbox's state, its host and its timed history", async () => {
    const summary = sandboxSummaryFixture({
      id: "sbx-1",
      hostId: "host-sbx-1",
      displayName: "api-refactor",
      state: "failed",
      failureCode: "create:kube-create-service-account",
      keptBy: { userId: "u-priya", displayName: "Priya" },
      guestConfigFailureReason: "could not write /home/dev/.ssh/id_rsa",
    });
    const queryClient = await listedOnce([{ sandboxes: [summary] }], "u-me");

    const entry = await loadSandboxDetails(queryClient, "sbx-1");

    expect(entry.title).toBe("api-refactor");
    const status = entry.status();
    expect(status.reason).toBe(
      "Failed to start · The sandbox service couldn't start it. · SBX-0412",
    );
    expect(status.hosts).toEqual([
      expect.objectContaining({
        hostId: "host-sbx-1",
        name: "api-refactor",
        reason:
          "Failed to start · The sandbox service couldn't start it. · SBX-0412",
      }),
    ]);
    const history = entry.history();
    expect(history.readerScope).toBe("full");
    expect(history.entries.map((event) => event.operation)).toContain(
      "Created",
    );
    // Kept carries no time, so it is not a drawer history entry.
    expect(history.entries.map((event) => event.operation)).not.toContain(
      "Kept",
    );
    const exported = JSON.stringify(await entry.exportDiagnostics());
    expect(exported).not.toContain("/home/dev");
  });

  it("names the region by the server's label in the status summary, never its id", async () => {
    const summary = sandboxSummaryFixture({
      id: "sbx-1",
      region: "us-west-3",
      regionLabel: "United States (West)",
    });
    const queryClient = await listedOnce([{ sandboxes: [summary] }], "u-me");

    const entry = await loadSandboxDetails(queryClient, "sbx-1");

    expect(entry.status().summary.endsWith("· United States (West)")).toBe(
      true,
    );
    expect(entry.status().summary).not.toContain("us-west-3");
  });

  it("omits the Region summary part for a row the server sends no label for", async () => {
    const summary = sandboxSummaryFixture({
      id: "sbx-1",
      region: "us-west-3",
      regionLabel: null,
    });
    const queryClient = await listedOnce([{ sandboxes: [summary] }], "u-me");

    const entry = await loadSandboxDetails(queryClient, "sbx-1");

    expect(entry.status().summary).not.toContain("us-west-3");
    expect(entry.status().summary.endsWith("·")).toBe(false);
  });

  it("reads an unset report time as No report yet, never an age since 1970", () => {
    const lastReport = (lastActivityAt: number | null) =>
      sandboxDetailsEntry({
        summary: sandboxSummaryFixture({ lastActivityAt }),
        cost: null,
        wakeString: null,
        viewerUserId: null,
        personal: true,
        now: NOW,
      }).export().status["Last report"];
    expect(lastReport(0)).toBe("No report yet");
    expect(lastReport(null)).toBe("No report yet");
    expect(lastReport(NOW - 360_000)).toBe("6 min ago");
  });

  it("names the first shell as what started Automations, and releases it rather than resting it", () => {
    const entry = sandboxDetailsEntry({
      summary: sandboxSummaryFixture({
        kind: "automation",
        burst: false,
        idleMinutes: 45,
      }),
      cost: null,
      wakeString: null,
      viewerUserId: null,
      personal: true,
      now: NOW,
    });
    const status = entry.export().status;
    expect(status["Started by"]).toBe("the first shell");
    expect(status.Idle).toBe("released after 45 idle min · files kept");
    expect(status.Resting).toBeUndefined();
    expect(
      entry.history.find((event) => event.label === "Created")?.value,
    ).toBe("by the first shell");
  });

  it("leaves the Region row out when it has no label to show", () => {
    const entry = sandboxDetailsEntry({
      summary: sandboxSummaryFixture({ region: "us-west1", regionLabel: null }),
      cost: null,
      wakeString: null,
      viewerUserId: null,
      personal: true,
      now: NOW,
    });
    expect(Object.keys(entry.export().status)).not.toContain("Region");
  });

  it("refuses a sandbox the control plane no longer lists, though a stale answer held it", async () => {
    const summary = sandboxSummaryFixture({ id: "sbx-1" });
    const queryClient = await listedOnce(
      [{ sandboxes: [summary] }, { sandboxes: [] }],
      "u-me",
    );

    await expect(loadSandboxDetails(queryClient, "sbx-1")).rejects.toThrow(
      "no longer listed",
    );
  });

  it("says the list could not be read rather than showing the row an earlier read held", async () => {
    const summary = sandboxSummaryFixture({ id: "sbx-1" });
    const queryClient = await listedOnce(
      [{ sandboxes: [summary] }, new Error("offline")],
      "u-me",
    );

    await expect(loadSandboxDetails(queryClient, "sbx-1")).rejects.toThrow(
      SANDBOX_LIST_FAILED,
    );
  });

  it("never reads another account's list", async () => {
    const summary = sandboxSummaryFixture({ id: "sbx-1" });
    const queryClient = await listedOnce(
      [{ sandboxes: [summary] }],
      "u-earlier",
    );

    await expect(loadSandboxDetails(queryClient, "sbx-1")).rejects.toThrow(
      SANDBOX_LIST_FAILED,
    );
  });
});

describe("sandboxDetailsEntry History from the server's operations", () => {
  const ME = { userId: "u-me", displayName: "Me" };
  // Local times, so the dates read the same in any zone.
  const at = (hours: number, minutes: number): number =>
    new Date(2026, 9, 25, hours, minutes).getTime();

  function entryOperation(
    overrides: Partial<SandboxHistoryEntry>,
  ): SandboxHistoryEntry {
    return {
      at: at(9, 0),
      fromState: "awake",
      state: "suspended",
      cause: "verb",
      outcomeCause: "verb",
      outcomeDetail: null,
      actor: ME,
      gesture: null,
      untilAt: at(9, 55),
      millicredits: 3,
      ...overrides,
    };
  }

  function costOf(history: readonly SandboxHistoryEntry[]): SandboxCost {
    return {
      sandboxId: "sbx_1",
      currentRateMillicreditsPerHour: 120,
      state: "awake",
      frozen: false,
      charged: {
        computeMillicredits: 0,
        storageMillicredits: 0,
        sinceCreatedAt: at(8, 0),
      },
      pendingMillicredits: 0,
      segments: [],
      todayMillicredits: 0,
      todayAwakeMs: null,
      history,
    };
  }

  function events(
    history: readonly SandboxHistoryEntry[],
    summary: Parameters<typeof sandboxSummaryFixture>[0],
  ): ReadonlyArray<{ readonly label: string; readonly value: string }> {
    return sandboxDetailsEntry({
      summary: sandboxSummaryFixture(summary),
      cost: costOf(history),
      wakeString: null,
      viewerUserId: ME.userId,
      personal: true,
      now: at(12, 0),
    }).history.map((event) => ({ label: event.label, value: event.value }));
  }

  it("reads a closed resting entry as who suspended it, until when, and what it cost", () => {
    expect(events([entryOperation({})], {})).toEqual([
      {
        label: "Suspended",
        value: "by you until Oct 25 at 09:55 · under $0.01",
      },
    ]);
  });

  describe("a failed start the live Automations row replaced", () => {
    const failedStart = (
      overrides: Partial<SandboxHistoryEntry>,
    ): SandboxHistoryEntry =>
      entryOperation({
        fromState: "creating",
        state: "failed",
        cause: "verb",
        outcomeCause: "failure",
        outcomeDetail: "create:kube-create-service-account",
        actor: null,
        untilAt: at(9, 0),
        millicredits: 0,
        ...overrides,
      });

    it("reads as Failed to start with its code and the first shell, never as Created", () => {
      const [event] = events([failedStart({})], { kind: "automation" });
      expect(event.label).toBe(
        "Failed to start · The sandbox service couldn't start it. · SBX-0412",
      );
      expect(event.value).toBe("by the first shell");
    });

    it("names the viewer when they started it", () => {
      const [event] = events([failedStart({ actor: ME })], {
        kind: "automation",
      });
      expect(event.label).toBe(
        "Failed to start · The sandbox service couldn't start it. · SBX-0412",
      );
      expect(event.value).toMatch(/^by you/);
    });

    it("drops the parentheses when the server gave no code", () => {
      const [event] = events([failedStart({ outcomeDetail: null })], {
        kind: "automation",
      });
      expect(event.label).toBe("Failed to start");
    });

    it("drops the parentheses for a code with no support reference", () => {
      const [event] = events([failedStart({ outcomeDetail: "zzz" })], {
        kind: "automation",
      });
      expect(event.label).toBe("Failed to start");
    });
  });

  it("reads a closed awake entry with its gesture, awake until when, and its cost", () => {
    expect(
      events(
        [
          entryOperation({
            fromState: "suspended",
            state: "awake",
            cause: "wake",
            outcomeCause: "wake",
            gesture: "open-terminal",
            untilAt: at(10, 1),
            millicredits: 20,
          }),
        ],
        {},
      ),
    ).toEqual([
      {
        label: "Resumed",
        value: "by you (Open terminal) · awake until Oct 25 at 10:01 · $0.02",
      },
    ]);
  });

  it("ends the current entry with resting from then or awake from then", () => {
    expect(
      events([entryOperation({ untilAt: null })], {}).map((e) => e.value),
    ).toEqual(["by you · resting from then"]);
    expect(
      events(
        [
          entryOperation({
            fromState: "suspended",
            state: "awake",
            cause: "wake",
            untilAt: null,
          }),
        ],
        {},
      ).map((e) => e.value),
    ).toEqual(["by you · awake from then"]);
  });

  it("names the system's own causes: the idle period, and the first shell or an agent for the create", () => {
    expect(
      events(
        [entryOperation({ actor: null, cause: "idle", outcomeCause: "idle" })],
        { idleMinutes: 45 },
      ).map((e) => e.value),
    ).toEqual(["after 45 idle minutes until Oct 25 at 09:55 · under $0.01"]);

    const created = entryOperation({
      fromState: "creating",
      state: "awake",
      cause: "verb",
      actor: null,
      untilAt: null,
    });
    expect(
      events([created], { kind: "automation", burst: false }).map(
        (e) => e.value,
      ),
    ).toEqual(["by the first shell · awake from then"]);
    expect(events([created], { burst: true }).map((e) => e.value)).toEqual([
      "by an agent · awake from then",
    ]);
  });

  it("says Stopped after a failed wake for a wake rolled back to stopped", () => {
    expect(
      events(
        [
          entryOperation({
            fromState: "stopped",
            state: "stopped",
            cause: "wake",
            outcomeCause: "failure",
            untilAt: null,
          }),
        ],
        {},
      ).map((e) => e.label),
    ).toEqual(["Stopped after a failed wake"]);
  });

  it("places Kept at the time it was kept, among the operations", () => {
    expect(
      events(
        [
          entryOperation({ at: at(9, 0), untilAt: at(9, 30) }),
          entryOperation({
            at: at(9, 30),
            fromState: "suspended",
            state: "awake",
            cause: "wake",
            untilAt: null,
          }),
        ],
        { keptBy: ME, keptAt: at(9, 10) },
      ).map((e) => e.label),
    ).toEqual(["Suspended", "Kept", "Resumed"]);
  });

  it("falls back to the ledger's segments when the server sends no operations", () => {
    const entry = sandboxDetailsEntry({
      summary: sandboxSummaryFixture({}),
      cost: {
        ...costOf([]),
        segments: [
          {
            state: "awake",
            fromAt: at(9, 0),
            toAt: at(9, 30),
            millicredits: 20,
          },
        ],
      },
      wakeString: null,
      viewerUserId: ME.userId,
      personal: true,
      now: at(12, 0),
    });

    expect(entry.history.map((event) => event.label)).toEqual([
      "Created",
      "Awake",
    ]);
  });
});
