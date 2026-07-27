import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UseEpicSearchArtifactsArgs } from "@/hooks/epic/use-epic-search-artifacts-query";
import { useEpicSearchArtifacts } from "@/hooks/epic/use-epic-search-artifacts-query";

interface CapturedHostQuery {
  readonly method: string;
  readonly params: {
    readonly fields: {
      readonly title: boolean;
      readonly path: boolean;
      readonly body: boolean;
    };
  };
}

const capturedQuery = vi.hoisted((): { current: CapturedHostQuery | null } => ({
  current: null,
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: (args: CapturedHostQuery) => {
    capturedQuery.current = args;
    return {
      data: undefined,
      error: null,
      isError: false,
      isFetching: false,
      isSuccess: false,
      refetch: vi.fn(),
    };
  },
}));

describe("useEpicSearchArtifacts", () => {
  it("searches artifact titles and bodies without matching mirror-relative paths", () => {
    const args: UseEpicSearchArtifactsArgs = {
      client: null,
      epicId: "epic-1",
      query: "needle",
      kinds: null,
      statuses: null,
      subtreePath: null,
      enabled: true,
    };

    renderHook(() => useEpicSearchArtifacts(args));

    expect(capturedQuery.current?.method).toBe("epic.searchArtifacts");
    expect(capturedQuery.current?.params.fields).toEqual({
      title: true,
      path: false,
      body: true,
    });
  });
});
