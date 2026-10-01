import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  useEpicDeleteInFlightReader,
  useIsEpicDeleteInFlight,
  type BatchDeleteEpicVariables,
} from "@/hooks/epic/use-epic-batch-delete-mutation";
import { epicMutationKeys } from "@/lib/query-keys";

/**
 * The two questions a surface asks of the mutation cache about a confirmed
 * delete: "is this task being deleted?" rendered (`useIsEpicDeleteInFlight`,
 * what a row shows) and asked at the moment of an open
 * (`useEpicDeleteInFlightReader`, what every list's open gate refuses on).
 *
 * Drives a real `QueryClient` and a real `useMutation` under
 * `epicMutationKeys.batchDelete()` with the dispatch's own variables shape, held
 * pending on a promise the test settles - the cache entry a real confirmed
 * delete leaves behind, without the host. `use-epic-batch-delete-toast-lifecycle`
 * drives the real hook into the same readers, which is what ties the key and
 * the variables shape together from the writing side.
 */

interface HeldDispatch {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

function makeWrapper(
  queryClient: QueryClient,
): ({ children }: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/**
 * One tree holding the writer and every reader. Three fixed ids are read so no
 * hook sits in a loop: `epic-a` and `epic-b` are the ids a case dispatches,
 * `epic-c` is the bystander that must never read as in flight.
 */
function renderInFlightReaders(queryClient: QueryClient) {
  const held: HeldDispatch[] = [];
  const view = renderHook(
    () => {
      const batchDelete = useMutation<void, Error, BatchDeleteEpicVariables>({
        mutationKey: epicMutationKeys.batchDelete(),
        mutationFn: () =>
          new Promise<void>((resolve, reject) => {
            held.push({ resolve: () => resolve(), reject });
          }),
      });
      // A pending mutation under ANOTHER key with the same `ids` shape: a key
      // match, not a shape match, is what makes a dispatch a delete.
      const otherWrite = useMutation<
        void,
        Error,
        { readonly ids: ReadonlyArray<string> }
      >({
        mutationKey: epicMutationKeys.setPinned(),
        mutationFn: () => new Promise<void>(() => undefined),
      });
      return {
        dispatchDelete: batchDelete.mutate,
        dispatchOther: otherWrite.mutate,
        reader: useEpicDeleteInFlightReader(),
        inFlightA: useIsEpicDeleteInFlight("epic-a"),
        inFlightB: useIsEpicDeleteInFlight("epic-b"),
        inFlightC: useIsEpicDeleteInFlight("epic-c"),
      };
    },
    { wrapper: makeWrapper(queryClient) },
  );
  return { ...view, held };
}

function deleteOf(ids: ReadonlyArray<string>): BatchDeleteEpicVariables {
  return { ids, worktreeCleanup: null };
}

function heldAt(
  held: ReadonlyArray<HeldDispatch>,
  index: number,
): HeldDispatch {
  const dispatch = held.at(index);
  if (dispatch === undefined) throw new Error("expected a held dispatch");
  return dispatch;
}

describe("useEpicDeleteInFlightReader", () => {
  it("answers true for exactly the ids of a pending delete", async () => {
    const { result } = renderInFlightReaders(newQueryClient());

    expect(result.current.reader("epic-a")).toBe(false);

    act(() => {
      result.current.dispatchDelete(deleteOf(["epic-a", "epic-b"]));
    });

    await waitFor(() => {
      expect(result.current.reader("epic-a")).toBe(true);
    });
    expect(result.current.reader("epic-b")).toBe(true);
    expect(result.current.reader("epic-c")).toBe(false);
    expect(result.current.reader("")).toBe(false);
  });

  it("answers false once the delete resolves", async () => {
    const { result, held } = renderInFlightReaders(newQueryClient());
    act(() => {
      result.current.dispatchDelete(deleteOf(["epic-a"]));
    });
    await waitFor(() => {
      expect(result.current.reader("epic-a")).toBe(true);
    });

    await act(async () => {
      heldAt(held, 0).resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.reader("epic-a")).toBe(false);
    });
  });

  it("answers false once the delete fails, so a failed delete does not strand its task", async () => {
    const { result, held } = renderInFlightReaders(newQueryClient());
    act(() => {
      result.current.dispatchDelete(deleteOf(["epic-a"]));
    });
    await waitFor(() => {
      expect(result.current.reader("epic-a")).toBe(true);
    });

    await act(async () => {
      heldAt(held, 0).reject(new Error("host refused"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.reader("epic-a")).toBe(false);
    });
  });

  // The reader is asked at the moment of an open, so it must not be a snapshot
  // of the render it came from: the same function, held across the dispatch,
  // sees the delete that started after it was created.
  it("reads the cache when called, not when it was created", async () => {
    const { result } = renderInFlightReaders(newQueryClient());
    const readerBeforeDispatch = result.current.reader;
    expect(readerBeforeDispatch("epic-a")).toBe(false);

    act(() => {
      result.current.dispatchDelete(deleteOf(["epic-a"]));
    });

    await waitFor(() => {
      expect(readerBeforeDispatch("epic-a")).toBe(true);
    });
  });

  it("keeps one identity across renders so it costs a list no re-render", async () => {
    const { result, rerender } = renderInFlightReaders(newQueryClient());
    const first = result.current.reader;

    act(() => {
      result.current.dispatchDelete(deleteOf(["epic-a"]));
    });
    await waitFor(() => {
      expect(result.current.inFlightA).toBe(true);
    });
    rerender();

    expect(result.current.reader).toBe(first);
  });

  it("tracks overlapping deletes independently", async () => {
    const { result, held } = renderInFlightReaders(newQueryClient());
    act(() => {
      result.current.dispatchDelete(deleteOf(["epic-a"]));
    });
    await waitFor(() => {
      expect(held).toHaveLength(1);
    });
    act(() => {
      result.current.dispatchDelete(deleteOf(["epic-b"]));
    });
    await waitFor(() => {
      expect(held).toHaveLength(2);
    });
    expect(result.current.reader("epic-a")).toBe(true);
    expect(result.current.reader("epic-b")).toBe(true);

    await act(async () => {
      heldAt(held, 0).resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.reader("epic-a")).toBe(false);
    });
    expect(result.current.reader("epic-b")).toBe(true);
  });

  it("ignores a pending mutation under another key, whatever its variables look like", async () => {
    const queryClient = newQueryClient();
    const { result } = renderInFlightReaders(queryClient);

    act(() => {
      result.current.dispatchOther({ ids: ["epic-a"] });
    });
    // Proven pending first, so "false" below is not "never dispatched".
    await waitFor(() => {
      expect(
        queryClient.getMutationCache().findAll({
          mutationKey: epicMutationKeys.setPinned(),
          status: "pending",
        }),
      ).toHaveLength(1);
    });

    expect(result.current.reader("epic-a")).toBe(false);
    expect(result.current.inFlightA).toBe(false);
  });
});

describe("useIsEpicDeleteInFlight", () => {
  it("is true for a task in a pending delete and false for every other", async () => {
    const { result } = renderInFlightReaders(newQueryClient());
    expect(result.current.inFlightA).toBe(false);

    act(() => {
      result.current.dispatchDelete(deleteOf(["epic-a", "epic-b"]));
    });

    await waitFor(() => {
      expect(result.current.inFlightA).toBe(true);
    });
    expect(result.current.inFlightB).toBe(true);
    expect(result.current.inFlightC).toBe(false);
  });

  it("re-renders back to false when the delete settles", async () => {
    const { result, held } = renderInFlightReaders(newQueryClient());
    act(() => {
      result.current.dispatchDelete(deleteOf(["epic-a"]));
    });
    await waitFor(() => {
      expect(result.current.inFlightA).toBe(true);
    });

    await act(async () => {
      heldAt(held, 0).resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.inFlightA).toBe(false);
    });
  });

  it("agrees with the reader about the same cache", async () => {
    const { result } = renderInFlightReaders(newQueryClient());

    act(() => {
      result.current.dispatchDelete(deleteOf(["epic-b"]));
    });

    await waitFor(() => {
      expect(result.current.inFlightB).toBe(true);
    });
    expect(result.current.reader("epic-b")).toBe(result.current.inFlightB);
    expect(result.current.reader("epic-a")).toBe(result.current.inFlightA);
  });
});
