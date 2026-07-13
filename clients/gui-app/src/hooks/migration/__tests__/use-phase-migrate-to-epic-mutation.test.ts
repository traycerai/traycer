import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { usePhaseMigrateToEpic } from "@/hooks/migration/use-phase-migrate-to-epic-mutation";

const testState = vi.hoisted(() => ({
  capturedMethod: "",
  capturedOptions: null as {
    readonly mutationKey?: readonly string[];
    readonly onMutate?: () => { readonly hostId: string | null };
    readonly onSuccess?: (
      data: { readonly epicId: string },
      variables: { readonly phaseId: string },
      ctx: { readonly hostId: string | null },
    ) => void;
    readonly onError?: (error: {
      readonly code: string;
      readonly message: string;
      readonly fatalDetails: null;
    }) => void;
  } | null,
  getActiveHostId: vi.fn(() => "host-active-1"),
  invalidateQueries: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: testState.invalidateQueries,
  }),
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => ({
    getActiveHostId: testState.getActiveHostId,
  }),
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostMutation: (args: {
    readonly method: string;
    readonly options: typeof testState.capturedOptions;
  }) => {
    testState.capturedMethod = args.method;
    testState.capturedOptions = args.options;
    return { mutate: vi.fn(), isPending: false };
  },
}));

describe("usePhaseMigrateToEpic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.capturedMethod = "";
    testState.capturedOptions = null;
    testState.getActiveHostId.mockReturnValue("host-active-1");
  });

  it("calls phase.migrateToEpic and invalidates the active host scope on success", () => {
    renderHook(() => usePhaseMigrateToEpic("phase-1"));

    expect(testState.capturedMethod).toBe("phase.migrateToEpic");
    expect(testState.capturedOptions?.mutationKey).toEqual([
      "phase.migrateToEpic",
      "phase-1",
    ]);

    const ctx = testState.capturedOptions?.onMutate?.();
    expect(ctx).toEqual({ hostId: "host-active-1" });

    if (!ctx) {
      throw new Error("onMutate did not return context");
    }
    testState.capturedOptions?.onSuccess?.(
      { epicId: "epic-1" },
      { phaseId: "phase-1" },
      ctx,
    );

    expect(testState.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["host", "host-active-1"],
    });
  });

  it("uses host error mapping on RPC failure", () => {
    renderHook(() => usePhaseMigrateToEpic("phase-1"));

    testState.capturedOptions?.onError?.({
      code: "UNAUTHORIZED",
      message: "missing user",
      fatalDetails: null,
    });

    expect(toast.error).toHaveBeenCalledWith("Please sign in again.");
  });
});
