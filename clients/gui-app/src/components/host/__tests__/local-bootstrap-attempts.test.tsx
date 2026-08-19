import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { TraycerHostStatusSnapshot } from "@traycer-clients/shared/platform/runner-host";
import { LocalBootstrapAttempts } from "@/components/host/local-bootstrap-attempts";
import { runnerQueryKeys } from "@/lib/query-keys";
import { RunnerHostProvider } from "@/providers/runner-host-provider";

/**
 * The snapshot the HEALTHY card's `Show details` disclosure read seconds before
 * the failure: the attempt is mid-spawn, no terminal marker yet. Within the
 * 30-second `staleTime`, so an ordinary mount would reuse it.
 */
const BEFORE_FAILURE: TraycerHostStatusSnapshot = {
  running: false,
  pidMetadata: null,
  bootstrapMarkers: [
    {
      timestamp: "2026-01-01T00:00:00.000Z",
      phase: "starting",
      fields: { shell: "/bin/zsh", args: "-i -l -c traycer" },
    },
  ],
  bootstrapLogPath: "/Users/me/.traycer/bootstrap.log",
  bootstrapLogTail: "",
};

/** What the CLI reports NOW: the same attempt, and how it ended. */
const AFTER_FAILURE: TraycerHostStatusSnapshot = {
  ...BEFORE_FAILURE,
  bootstrapMarkers: [
    ...BEFORE_FAILURE.bootstrapMarkers,
    {
      timestamp: "2026-01-01T00:00:03.000Z",
      phase: "crashed",
      fields: { code: "1" },
    },
  ],
};

function mount(traycerCli: MockTraycerCli, queryClient: QueryClient) {
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli,
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        <LocalBootstrapAttempts />
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

describe("<LocalBootstrapAttempts />", () => {
  afterEach(() => {
    cleanup();
  });

  it("reads the host status FRESH on mount and never draws the cached snapshot, even while that snapshot is within staleTime", async () => {
    // THE RACE THIS PINS. The failure card mounts this panel the moment the
    // install fails, and the healthy card before it read the SAME query for its
    // `Show details` tail. That read is seconds old - "fresh" by the 30-second
    // rule - and describes the attempt before it ended: no terminal marker, so
    // no panel, or on a retry the PREVIOUS attempt's ending. Only
    // `convergeReady`'s success invalidates the key, so nothing else refreshes
    // it in time. The panel therefore refetches on mount regardless of
    // freshness, and shows nothing until that fetch lands.
    const traycerCli = new MockTraycerCli();
    traycerCli.hostStatusSnapshot = AFTER_FAILURE;
    const hostStatus = vi.spyOn(traycerCli, "hostStatus");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // The disclosure's read, as the cache holds it: JUST written, so it is as
    // fresh as a snapshot can be.
    queryClient.setQueryData(
      runnerQueryKeys.traycerHostStatus(traycerCli),
      BEFORE_FAILURE,
    );

    mount(traycerCli, queryClient);

    // Not the cached snapshot. Asserted synchronously, before any fetch could
    // resolve: a panel drawn here would be drawn from `BEFORE_FAILURE`, which
    // has no outcome - and would show whatever an older attempt had ended
    // with, on a card that is reporting this one.
    expect(screen.queryByTestId("local-host-bootstrap-details")).toBeNull();

    // The fresh read lands and the panel describes the attempt that just
    // failed.
    const panel = await screen.findByTestId("local-host-bootstrap-details");
    expect(panel.textContent).toContain("Host crashed with code 1");
    expect(
      screen.getByTestId("local-host-bootstrap-log-path").textContent,
    ).toBe("/Users/me/.traycer/bootstrap.log");
    // And it WAS a read of the CLI, not a cache hit - the positive control for
    // the whole test. Without `refetchOnMount: "always"` a fresh cache entry
    // is never re-read and this stays at zero.
    expect(hostStatus).toHaveBeenCalledTimes(1);
  });

  it("draws NOTHING when the forced refetch rejects, rather than the cached snapshot it kept", async () => {
    // THE OTHER HALF of the guard above, and the reason it is two conditions.
    // `isFetchedAfterMount` is `dataUpdateCount > initial || errorUpdateCount >
    // initial` (query-core's `queryObserver`), so a REJECTED refetch flips it
    // true - and React Query deliberately keeps serving the cached data on a
    // refetch error. Fetched-after-mount plus pre-failure data is exactly the
    // state this component must refuse, and a guard written on
    // `isFetchedAfterMount` alone renders it.
    const traycerCli = new MockTraycerCli();
    const hostStatus = vi
      .spyOn(traycerCli, "hostStatus")
      .mockRejectedValue(new Error("traycer host status exited with code 1"));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(
      runnerQueryKeys.traycerHostStatus(traycerCli),
      BEFORE_FAILURE,
    );

    mount(traycerCli, queryClient);

    // The refetch is attempted and fails...
    await waitFor(() => {
      expect(hostStatus).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(
        queryClient.getQueryState(runnerQueryKeys.traycerHostStatus(traycerCli))
          ?.status,
      ).toBe("error");
    });
    // ...the cached snapshot survives in the cache (which is the premise, not
    // an incidental)...
    expect(
      queryClient.getQueryData(runnerQueryKeys.traycerHostStatus(traycerCli)),
    ).toEqual(BEFORE_FAILURE);
    // ...and nothing is drawn from it. The card around this still carries its
    // heading, the error, Retry and the log path.
    expect(screen.queryByTestId("local-host-bootstrap-details")).toBeNull();
    expect(screen.queryByTestId("local-host-bootstrap-log-path")).toBeNull();
  });

  it("draws the fetched attempt once, then holds it without polling", async () => {
    // A single read, not a poll: the user is reading a crash report and the CLI
    // is not re-run underneath them. `refetchInterval` is off for this reader;
    // the recovery actions are what invalidate the key.
    const traycerCli = new MockTraycerCli();
    traycerCli.hostStatusSnapshot = AFTER_FAILURE;
    const hostStatus = vi.spyOn(traycerCli, "hostStatus");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    mount(traycerCli, queryClient);
    await screen.findByTestId("local-host-bootstrap-details");
    // Settle any follow-up the observer might schedule; there must be none.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await waitFor(() => {
      expect(hostStatus).toHaveBeenCalledTimes(1);
    });
  });
});
