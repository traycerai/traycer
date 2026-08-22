import { describe, expect, it } from "vitest";
import {
  planFileTreeRevealRouting,
  type FileTreeRevealRoutingInput,
} from "@/components/epic-canvas/sidebar/file-tree-reveal-routing";

const REQUEST = {
  hostId: "host-B",
  workspacePath: "/repo",
  filePath: "src/lib/a.ts",
  nonce: 1,
} as const;

function input(
  overrides: Partial<FileTreeRevealRoutingInput>,
): FileTreeRevealRoutingInput {
  return {
    request: REQUEST,
    resolvedHostId: "host-B",
    pinnedHostId: null,
    rootsResolved: true,
    workspaceRoots: ["/repo", "/other"],
    selectedWorkspacePath: "/repo",
    ...overrides,
  };
}

describe("planFileTreeRevealRouting", () => {
  it("is ready when the panel already points at the file's host and root", () => {
    expect(planFileTreeRevealRouting(input({}))).toEqual({ kind: "ready" });
  });

  it("pins the panel to the file's host when it resolves elsewhere", () => {
    expect(
      planFileTreeRevealRouting(
        input({ resolvedHostId: "host-A", pinnedHostId: null }),
      ),
    ).toEqual({ kind: "pin-host", hostId: "host-B" });
    // A pin to a third host is re-pointed the same way.
    expect(
      planFileTreeRevealRouting(
        input({ resolvedHostId: "host-A", pinnedHostId: "host-A" }),
      ),
    ).toEqual({ kind: "pin-host", hostId: "host-B" });
  });

  it("drops the request when the file's host is pinned yet cannot serve", () => {
    // Pinned to host-B but resolving to the effective host: the pin is not
    // honored (dead host), so there is nothing to reveal into.
    expect(
      planFileTreeRevealRouting(
        input({ resolvedHostId: "host-A", pinnedHostId: "host-B" }),
      ),
    ).toEqual({ kind: "drop" });
  });

  it("waits for the roots read before judging the workspace", () => {
    expect(
      planFileTreeRevealRouting(
        input({
          rootsResolved: false,
          workspaceRoots: [],
          selectedWorkspacePath: null,
        }),
      ),
    ).toEqual({ kind: "wait" });
  });

  it("drops the request when the file's root is not a browsable root of the host", () => {
    // A synthesized out-of-root workspace (`workspaceFileRefFromAbsoluteFilePath`)
    // or a binding since removed: the picker cannot switch to it.
    expect(
      planFileTreeRevealRouting(
        input({ workspaceRoots: ["/other"], selectedWorkspacePath: "/other" }),
      ),
    ).toEqual({ kind: "drop" });
  });

  it("switches the workspace selection when the host is right but the root is not", () => {
    expect(
      planFileTreeRevealRouting(input({ selectedWorkspacePath: "/other" })),
    ).toEqual({ kind: "select-workspace", workspacePath: "/repo" });
    expect(
      planFileTreeRevealRouting(input({ selectedWorkspacePath: null })),
    ).toEqual({ kind: "select-workspace", workspacePath: "/repo" });
  });
});
