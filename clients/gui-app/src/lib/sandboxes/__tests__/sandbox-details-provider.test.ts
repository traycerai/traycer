import "@/components/settings/details/environment-details-providers";
import { QueryClient, queryOptions } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  SandboxCost,
  SandboxHistoryEntry,
  SandboxListResponse,
} from "@traycer/protocol/host/sandbox-control";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { sandboxQueryKeys } from "@/lib/query-keys";
import { sandboxDetailsEntry } from "@/lib/sandboxes/sandbox-details-provider";
import { SANDBOX_LIST_FAILED } from "@/lib/sandboxes/sandbox-strings";
import { getDetailsProvider } from "@/lib/settings-details-entry";
import { useAuthStore } from "@/stores/auth/auth-store";

const NOW = 1_791_100_000_000;

describe("sandboxDetailsEntry", () => {
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
      "Failed to start (SBX-0412) · Nothing is billed for a sandbox that never woke",
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

    expect(entry.export().status.Frozen).toMatch(
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
    expect(status.reason).toBe("Failed to start (SBX-0412)");
    expect(status.hosts).toEqual([
      expect.objectContaining({
        hostId: "host-sbx-1",
        name: "api-refactor",
        reason: "Failed to start (SBX-0412)",
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
      expect(event.label).toBe("Failed to start (SBX-0412)");
      expect(event.value).toBe(
        "by the first shell · Nothing is billed for a sandbox that never woke",
      );
    });

    it("names the viewer when they started it", () => {
      const [event] = events([failedStart({ actor: ME })], {
        kind: "automation",
      });
      expect(event.label).toBe("Failed to start (SBX-0412)");
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
