import "@/components/settings/details/environment-details-providers";
import { QueryClient, queryOptions } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SandboxListResponse } from "@traycer/protocol/host/sandbox-control";
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
      failureCode: "SBX-0101",
      keptBy: { userId: "u-priya", displayName: "Priya" },
      guestConfigFailureReason: "could not write /home/dev/.ssh/id_rsa",
    });
    const queryClient = await listedOnce([{ sandboxes: [summary] }], "u-me");

    const entry = await loadSandboxDetails(queryClient, "sbx-1");

    expect(entry.title).toBe("api-refactor");
    const status = entry.status();
    expect(status.reason).toBe("Failed to start (SBX-0101)");
    expect(status.hosts).toEqual([
      expect.objectContaining({
        hostId: "host-sbx-1",
        name: "api-refactor",
        reason: "Failed to start (SBX-0101)",
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
