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

/** The snapshot the healthy card's `Show details` disclosure read seconds before the failure: the attempt is
 * mid-spawn, no terminal marker yet. Within the 30-second `staleTime`, so an ordinary mount would reuse it. */
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

/** A key that stopped extending the shared one would return nothing here. */
function panelEntry(queryClient: QueryClient, traycerCli: MockTraycerCli) {
  return queryClient
    .getQueryCache()
    .findAll({ queryKey: runnerQueryKeys.traycerHostStatus(traycerCli) })
    .find((entry) => entry.queryKey.includes("fresh-read"));
}

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
    // The race this pins. Only `convergeReady`'s success invalidates the key, so nothing else refreshes it in
    // time.
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

    // Not the cached snapshot.
    expect(screen.queryByTestId("local-host-bootstrap-details")).toBeNull();

    // The fresh read lands and the panel describes the attempt that just
    // failed.
    const panel = await screen.findByTestId("local-host-bootstrap-details");
    expect(panel.textContent).toContain("Host crashed with code 1");
    expect(
      screen.getByTestId("local-host-bootstrap-log-path").textContent,
    ).toBe("/Users/me/.traycer/bootstrap.log");
    // A panel reading the disclosure's own key would find this snapshot fresh by the 30-second rule and never call
    // out at all, leaving this at zero.
    expect(hostStatus).toHaveBeenCalledTimes(1);
  });

  it("draws NOTHING when the mount's read rejects, rather than the cached snapshot it kept", async () => {
    // Fetched-after-mount plus pre-failure data is exactly the state this component must refuse, and a guard
    // written on `isFetchedAfterMount` alone renders it.
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
    // The third way the stale snapshot gets in, and the one a `refetchOnMount` flag cannot close.
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

    // The install fails and the failure body mounts the panel beside the disclosure - exactly how both failure
    // cards compose it.
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
    // The stale render does not appear in the same tick the promise settles, so an assertion taken straight after
    // `release` passes on an unflushed tree rather than on an empty one.
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
    // The property the private key must not cost.
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
    // The private key must not keep the answer to itself.
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
    // A single read, not a poll: the user is reading a crash report and the CLI is not re-run underneath them.
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
