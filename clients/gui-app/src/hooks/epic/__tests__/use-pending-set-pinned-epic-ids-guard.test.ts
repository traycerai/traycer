import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { usePendingSetPinnedEpicIds } from "@/hooks/epic/use-epic-set-pinned-mutation";
import { epicMutationKeys } from "@/lib/query-keys";

/**
 * `eccc40b12` - the pending-epics guard (lane 9 evidence, §3.5).
 * `isSetEpicPinnedVariables` runs over `unknown` mutation-cache variables and
 * deliberately does NOT require `isLocalHome`, even though every real
 * dispatch now carries it: this runs over variables ALREADY scoped by
 * `epicMutationKeys.setPinned()`, so adding the field re-narrows nothing the
 * key has not already narrowed, and requiring it made a widening of
 * `SetEpicPinnedVariables` silently drop every in-flight write without the
 * new field from the pending set - each row then read its own write as
 * settled and the control un-disabled mid-flight. Fails OPEN, and no type
 * error catches it because the guard's input is `unknown` by construction.
 *
 * This is the guard's own falsifier, independent of
 * `use-epic-set-pinned-mutation.test.tsx`'s general pending-tracking
 * coverage: it dispatches variables WITHOUT `isLocalHome` on purpose and
 * pins that they still surface in the pending set.
 */

interface LegacySetPinnedVariables {
  readonly epicId: string;
  readonly pinned: boolean;
}

function makeWrapper(
  queryClient: QueryClient,
): ({ children }: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

describe("usePendingSetPinnedEpicIds guard (eccc40b12)", () => {
  it("keeps a dispatch with no isLocalHome field in the pending set", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });

    const { result } = renderHook(
      () => {
        const mutation = useMutation({
          mutationKey: epicMutationKeys.setPinned(),
          mutationFn: (_variables: LegacySetPinnedVariables) =>
            new Promise<{ pinned: boolean }>(() => {
              // Never resolves: this pin only needs the PENDING state.
            }),
        });
        return {
          mutate: mutation.mutate,
          pending: usePendingSetPinnedEpicIds(),
        };
      },
      { wrapper: makeWrapper(queryClient) },
    );

    act(() => {
      // Deliberately no `isLocalHome` - the shape a pre-`@1.1` cache entry,
      // or any caller that has not been widened yet, would still carry.
      result.current.mutate({
        epicId: "epic-no-local-home-field",
        pinned: true,
      });
    });

    await waitFor(() => {
      expect(result.current.pending).toEqual(
        new Set(["epic-no-local-home-field"]),
      );
    });
  });
});
