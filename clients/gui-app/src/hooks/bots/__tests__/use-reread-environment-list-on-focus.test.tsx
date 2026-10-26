import { afterEach, describe, expect, it } from "vitest";
import {
  QueryClient,
  QueryClientProvider,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useRereadEnvironmentListOnFocus } from "@/hooks/bots/use-reread-environment-list-on-focus";
import { hostQueryKeys } from "@/lib/query-keys";

const queryKey = hostQueryKeys.method<HostRpcRegistry, "environment.list">(
  "host-a",
  "environment.list",
  {},
);

interface Deferred {
  readonly promise: Promise<number>;
  readonly resolve: (value: number) => void;
}

function createDeferred(): Deferred {
  let resolve: (value: number) => void = () => {};
  const promise = new Promise<number>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createFixture() {
  const signals: AbortSignal[] = [];
  const reads: Deferred[] = [];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const queryFn = (context: {
    readonly signal: AbortSignal;
  }): Promise<number> => {
    signals.push(context.signal);
    if (signals.length === 1) return Promise.resolve(1);
    const read = createDeferred();
    reads.push(read);
    return read.promise;
  };
  function Consumer(props: { readonly testId: string }): ReactNode {
    const query = useQuery(queryOptions({ queryKey, queryFn }));
    useRereadEnvironmentListOnFocus(true);
    return <span data-testid={props.testId}>{query.data}</span>;
  }
  const tree = (
    <QueryClientProvider client={queryClient}>
      <Consumer testId="sidebar" />
      <Consumer testId="home" />
    </QueryClientProvider>
  );
  return {
    signals,
    tree,
    queryClient,
    releaseHeld: (value: number): void => {
      reads.at(-1)?.resolve(value);
    },
    releaseRead: (index: number, value: number): void => {
      reads[index]?.resolve(value);
    },
  };
}

afterEach(() => {
  cleanup();
});

describe("useRereadEnvironmentListOnFocus", () => {
  it("lets every mounted listener join one re-read instead of restarting it", async () => {
    const fixture = createFixture();
    render(fixture.tree);
    await waitFor(() => {
      expect(screen.getByTestId("sidebar").textContent).toBe("1");
    });
    expect(fixture.signals).toHaveLength(1);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(fixture.signals).toHaveLength(2);
    expect(fixture.signals[1]?.aborted).toBe(false);

    act(() => {
      fixture.releaseHeld(2);
    });
    await waitFor(() => {
      expect(screen.getByTestId("sidebar").textContent).toBe("2");
      expect(screen.getByTestId("home").textContent).toBe("2");
    });
    expect(fixture.signals).toHaveLength(2);
  });

  it("replaces a read already running at focus with one fresh read", async () => {
    const fixture = createFixture();
    render(fixture.tree);
    await waitFor(() => {
      expect(screen.getByTestId("sidebar").textContent).toBe("1");
    });
    act(() => {
      void fixture.queryClient.invalidateQueries({ queryKey });
    });
    expect(fixture.signals).toHaveLength(2);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(fixture.signals).toHaveLength(3);
    expect(fixture.signals[1]?.aborted).toBe(true);
    expect(fixture.signals[2]?.aborted).toBe(false);

    act(() => {
      fixture.releaseRead(0, 2);
      fixture.releaseRead(1, 3);
    });
    await waitFor(() => {
      expect(screen.getByTestId("sidebar").textContent).toBe("3");
      expect(screen.getByTestId("home").textContent).toBe("3");
    });
    expect(fixture.signals).toHaveLength(3);
  });
});
