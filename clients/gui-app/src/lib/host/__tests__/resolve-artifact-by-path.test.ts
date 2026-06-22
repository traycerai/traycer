import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi, type Mock } from "vitest";
import { fetchResolveArtifactByPath } from "@/lib/host/resolve-artifact-by-path";
import type { ResolveArtifactByPathResponse } from "@traycer/protocol/host/epic/unary-schemas";

const HOST_ID = "host-1";
const EPIC_ID = "epic-1";
const FILE_PATH =
  "/Users/me/.traycer/epics/epic-1/artifacts/some-spec/index.md";

type ResolveRequest = (
  method: string,
  params: unknown,
) => Promise<ResolveArtifactByPathResponse>;

// Only `client.request` is exercised by fetchResolveArtifactByPath; the rest of
// HostClient is irrelevant here, so the double carries just that method (mirrors
// the `as never` test-double pattern used elsewhere in the suite).
function makeArgs(queryClient: QueryClient, request: Mock<ResolveRequest>) {
  return {
    queryClient,
    client: { request } as never,
    hostId: HOST_ID,
    epicId: EPIC_ID,
    filePath: FILE_PATH,
  };
}

describe("fetchResolveArtifactByPath", () => {
  it("serves a resolved artifact from cache on a repeat click within the stale window", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const request = vi.fn<ResolveRequest>();
    request.mockResolvedValue({ artifact: { artifactId: "a1", kind: "spec" } });
    const args = makeArgs(queryClient, request);

    const first = await fetchResolveArtifactByPath(args);
    const second = await fetchResolveArtifactByPath(args);

    expect(first).toEqual({ artifactId: "a1", kind: "spec" });
    expect(second).toEqual({ artifactId: "a1", kind: "spec" });
    // A real id is stable until rename/delete, so the repeat click is served
    // from cache without a second host round-trip.
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not cache a null (not-yet-minted) resolve, so the next click re-asks the host", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const request = vi.fn<ResolveRequest>();
    request
      .mockResolvedValueOnce({ artifact: null })
      .mockResolvedValueOnce({ artifact: { artifactId: "a1", kind: "spec" } });
    const args = makeArgs(queryClient, request);

    // First click: the path is not yet an artifact.
    expect(await fetchResolveArtifactByPath(args)).toBeNull();
    // The artifact is minted moments later; the second click must re-request
    // (the null was evicted) rather than serving the stale cached null.
    expect(await fetchResolveArtifactByPath(args)).toEqual({
      artifactId: "a1",
      kind: "spec",
    });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
