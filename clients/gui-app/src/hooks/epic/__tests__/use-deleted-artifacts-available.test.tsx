import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  supportedMethods: new Set<string>(),
  supportCalls: [] as string[],
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod: (_hostId: string | null, method: string) => {
    state.supportCalls.push(method);
    return state.supportedMethods.has(method);
  },
}));

import { useDeletedArtifactsAvailable } from "../use-deleted-artifacts-available";

const REQUIRED_METHODS = [
  "epic.deletedArtifacts.list",
  "epic.deletedArtifacts.revive",
  "epic.artifactVersions.getBlob",
] as const;

describe("useDeletedArtifactsAvailable", () => {
  beforeEach(() => {
    state.supportedMethods = new Set(REQUIRED_METHODS);
    state.supportCalls = [];
  });

  it("requires the complete recovery and preview surface", () => {
    state.supportedMethods.delete("epic.artifactVersions.getBlob");

    const { result } = renderHook(() => useDeletedArtifactsAvailable("host-a"));

    expect(state.supportCalls).toEqual(REQUIRED_METHODS);
    expect(result.current).toBe(false);
  });

  it("is available when the host negotiated every required method", () => {
    const { result } = renderHook(() => useDeletedArtifactsAvailable("host-a"));

    expect(state.supportCalls).toEqual(REQUIRED_METHODS);
    expect(result.current).toBe(true);
  });
});
