import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  MockRunnerHost,
  MockTraycerCli,
} from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { TraycerHostStatusSnapshot } from "@traycer-clients/shared/platform/runner-host";
import { LocalBootstrapAttempts } from "@/components/host/local-bootstrap-attempts";
import { BootstrapLogDisclosure } from "@/components/local-host-loading";
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

function tree(
  runnerHost: MockRunnerHost,
  queryClient: QueryClient,
  children: ReactNode,
) {
  return (
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider runnerHost={runnerHost}>
        {children}
      </RunnerHostProvider>
    </QueryClientProvider>
  );
}

function runnerHostFor(traycerCli: MockTraycerCli): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli,
  });
}

function mount(traycerCli: MockTraycerCli, queryClient: QueryClient) {
  return render(
    tree(runnerHostFor(traycerCli), queryClient, <LocalBootstrapAttempts />),
  );
}

/**
 * The panel's OWN cache entry - and the fact that finding it this way works is
 * itself the assertion. `onMount: "fresh-read"` gives each mount a private key
 * so no other reader's in-flight request can be deduplicated onto it, but that
 * key stays a prefix EXTENSION of the shared one, which is what keeps the
 * recovery mutations' partial-match `invalidateQueries` reaching this panel. A
 * key that stopped extending the shared one would return nothing here.
 */
function panelEntry(queryClient: QueryClient, traycerCli: MockTraycerCli) {
  return queryClient
    .getQueryCache()
    .findAll({ queryKey: runnerQueryKeys.traycerHostStatus(traycerCli) })
    .find((entry) => entry.queryKey.includes("fresh-read"));
}

/** A promise a test releases by hand, so a read stays genuinely in flight. */
function deferred(): {
  readonly promise: Promise<TraycerHostStatusSnapshot>;
  readonly release: (snapshot: TraycerHostStatusSnapshot) => void;
} {
  let release: (snapshot: TraycerHostStatusSnapshot) => void = () => {};
  const promise = new Promise<TraycerHostStatusSnapshot>((resolve) => {
    release = resolve;
  });
  return { promise, release };
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
    // it in time. The panel therefore takes a read of its own on mount, and
    // shows nothing until that read lands.
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
    // the whole test. A panel reading the disclosure's own key would find this
    // snapshot fresh by the 30-second rule and never call out at all, leaving
    // this at zero.
    expect(hostStatus).toHaveBeenCalledTimes(1);
  });

  it("draws NOTHING when the mount's read rejects, rather than the cached snapshot it kept", async () => {
    // THE OTHER HALF of the guard above, and the reason it is two conditions.
    // `isFetchedAfterMount` is `dataUpdateCount > initial || errorUpdateCount >
    // initial` (query-core's `queryObserver`), so a REJECTED read flips it
    // true - and React Query deliberately keeps serving cached data on a
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

    // The read is attempted and fails...
    await waitFor(() => {
      expect(hostStatus).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(panelEntry(queryClient, traycerCli)?.state.status).toBe("error");
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

  it("refuses a read that was ALREADY IN FLIGHT when it mounted, not merely one that resolved before it", async () => {
    // THE THIRD WAY the stale snapshot gets in, and the one a `refetchOnMount`
    // flag cannot close. The disclosure beside this panel reads the SAME key,
    // and polls it every 1.5s while `Show details` is open - so at the instant
    // the install fails there is routinely a request already running. On mount,
    // query-core's `Query.fetch` returns the EXISTING retryer promise rather
    // than starting a read (`cancelRefetch` is unset for a mount-triggered
    // fetch, and is honoured only when the query already holds data anyway).
    //
    // That request sampled bootstrap.log BEFORE the terminal marker was
    // written. It resolves after mount, so `isFetchedAfterMount` and
    // `isSuccess` are both true - on data that predates the failure this panel
    // exists to describe. "Fetched after mount" is not "read after mount".
    const traycerCli = new MockTraycerCli();
    const preFailureRead = deferred();
    const panelRead = deferred();
    const hostStatus = vi
      .spyOn(traycerCli, "hostStatus")
      .mockImplementationOnce(() => preFailureRead.promise)
      .mockImplementation(() => panelRead.promise);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const runnerHost = runnerHostFor(traycerCli);

    // The healthy card, with its disclosure reading the host status. Nothing is
    // resolved yet: this is the in-flight request the failure interrupts.
    const view = render(
      tree(
        runnerHost,
        queryClient,
        <BootstrapLogDisclosure onConfigureShell={() => {}} trailing={null} />,
      ),
    );
    await waitFor(() => {
      expect(hostStatus).toHaveBeenCalledTimes(1);
    });

    // The install fails and the failure body mounts the panel BESIDE the
    // disclosure - exactly how both failure cards compose it.
    view.rerender(
      tree(
        runnerHost,
        queryClient,
        <>
          <LocalBootstrapAttempts />
          <BootstrapLogDisclosure onConfigureShell={() => {}} trailing={null} />
        </>,
      ),
    );

    // The pre-failure read lands. It is the only read a deduplicating mount
    // would ever see.
    await act(async () => {
      preFailureRead.release(BEFORE_FAILURE);
      await preFailureRead.promise;
    });
    // Nothing drawn from it - and given every chance to be. The stale render
    // does not appear in the same tick the promise settles, so an assertion
    // taken straight after `release` passes on an unflushed tree rather than
    // on an empty one. Flushed, unfixed code draws "Last attempt … Host never
    // reported a terminal status" right here, under a heading that says the
    // host didn't start and a message quoting the exit code it died with.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(screen.queryByTestId("local-host-bootstrap-details")).toBeNull();

    // The panel's OWN read - started after it mounted - is what it draws.
    expect(hostStatus).toHaveBeenCalledTimes(2);
    await act(async () => {
      panelRead.release(AFTER_FAILURE);
      await panelRead.promise;
    });
    const panel = await screen.findByTestId("local-host-bootstrap-details");
    expect(panel.textContent).toContain("Host crashed with code 1");
  });

  it("is still reached by the recovery actions' invalidation of the SHARED key", async () => {
    // The property the private key must not cost. Retry, respawn and
    // `convergeReady` all invalidate `runnerQueryKeys.traycerHostStatus(cli)`
    // and nothing else; a panel keyed outside that prefix would quietly stop
    // hearing them. Partial matching is what keeps it inside.
    const traycerCli = new MockTraycerCli();
    traycerCli.hostStatusSnapshot = BEFORE_FAILURE;
    const hostStatus = vi.spyOn(traycerCli, "hostStatus");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    mount(traycerCli, queryClient);
    await screen.findByTestId("local-host-bootstrap-details");

    traycerCli.hostStatusSnapshot = AFTER_FAILURE;
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.traycerHostStatus(traycerCli),
      });
    });

    expect(hostStatus).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(
        screen.getByTestId("local-host-bootstrap-details").textContent,
      ).toContain("Host crashed with code 1");
    });
  });

  it("publishes its fresh sample to the SHARED entry the closed disclosure reads", async () => {
    // The private key must not keep the answer to itself. `Show details` is
    // closed when a start fails, so the disclosure is not polling and its
    // shared entry still holds the pre-crash snapshot; opening it does not
    // refetch either (`shouldFetchOptionally` needs a changed query or a
    // previously-disabled one, and toggling `pollIntervalMs` is neither), so
    // the interval it arms is the first refresh - up to 1.5s of a pre-crash
    // bootstrap.log tail beside a panel describing the crash.
    const traycerCli = new MockTraycerCli();
    traycerCli.hostStatusSnapshot = AFTER_FAILURE;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(
      runnerQueryKeys.traycerHostStatus(traycerCli),
      BEFORE_FAILURE,
    );

    mount(traycerCli, queryClient);
    await screen.findByTestId("local-host-bootstrap-details");

    await waitFor(() => {
      expect(
        queryClient.getQueryData(runnerQueryKeys.traycerHostStatus(traycerCli)),
      ).toEqual(AFTER_FAILURE);
    });
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
