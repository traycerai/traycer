import { describe, expect, it } from "vitest";
import type { WorktreeBindingEntry } from "@traycer/protocol/host/worktree-schemas";
import { buildOwnerWorkspaceInheritanceSeed } from "@/lib/worktree/owner-workspace-inheritance-seed";
import { buildFixedHostWorkspaceControlsScope } from "@/components/home/host-workspace-selector/host-workspace-controls-scope";
import { resolveOwnerWorkspaceInheritanceSeed } from "@/hooks/worktree/use-owner-workspace-inheritance-seed";

function bindingEntry(
  overrides: Partial<WorktreeBindingEntry>,
): WorktreeBindingEntry {
  return {
    workspacePath: "/workspace/a",
    mode: "local",
    repoIdentifier: null,
    worktreePath: null,
    branch: null,
    isPrimary: true,
    isImported: false,
    setupState: "not_required",
    setupTerminalSessionId: null,
    setupExitCode: null,
    setupFailedAt: null,
    createdAt: 0,
    ownedSubmodules: [],
    ...overrides,
  };
}

describe("child conversation workspace seed", () => {
  it("returns null when the parent has no binding or legacy fallback folders", () => {
    expect(
      buildOwnerWorkspaceInheritanceSeed({
        binding: null,
        stagedIntent: null,
        fallbackWorkspaceFolders: [],
      }),
    ).toBeNull();
  });

  it("preserves a parent worktree binding as an import intent", () => {
    const seed = buildOwnerWorkspaceInheritanceSeed({
      binding: {
        entries: [
          bindingEntry({
            workspacePath: "/repo/source",
            mode: "worktree",
            worktreePath: "/worktrees/feature",
            branch: "feature",
            repoIdentifier: { owner: "acme", repo: "app" },
          }),
        ],
      },
      stagedIntent: null,
      fallbackWorkspaceFolders: ["/legacy/local"],
    });

    expect(seed?.intent).toEqual({
      entries: [
        {
          kind: "import",
          workspacePath: "/repo/source",
          repoIdentifier: { owner: "acme", repo: "app" },
          isPrimary: true,
          worktreePath: "/worktrees/feature",
        },
      ],
    });
  });

  it("keeps legacy terminal-agent folder fallback only when no binding exists", () => {
    const seed = buildOwnerWorkspaceInheritanceSeed({
      binding: null,
      stagedIntent: null,
      fallbackWorkspaceFolders: ["/workspace/a", "/workspace/b"],
    });

    expect(seed?.intent).toEqual({
      entries: [
        {
          kind: "local",
          workspacePath: "/workspace/a",
          repoIdentifier: null,
          isPrimary: true,
        },
        {
          kind: "local",
          workspacePath: "/workspace/b",
          repoIdentifier: null,
          isPrimary: false,
        },
      ],
    });
  });

  it("ignores stale staged owner intent when no parent binding exists", () => {
    const seed = buildOwnerWorkspaceInheritanceSeed({
      binding: null,
      stagedIntent: {
        entries: [
          {
            kind: "local",
            workspacePath: "/stale",
            repoIdentifier: null,
            isPrimary: true,
          },
        ],
      },
      fallbackWorkspaceFolders: ["/workspace/a"],
    });

    expect(seed?.intent).toEqual({
      entries: [
        {
          kind: "local",
          workspacePath: "/workspace/a",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    });
  });

  it("exposes an empty non-null seed (no fallback, no global fallback) while the parent binding read is unresolved", () => {
    const seed = resolveOwnerWorkspaceInheritanceSeed({
      enabled: true,
      bindingReadEnabled: true,
      bindingResultReady: false,
      binding: null,
      stagedIntent: null,
      fallbackWorkspaceFolders: ["/workspace/a"],
    });

    // Must be non-null: a `null` seed makes the picker fall back to the global
    // (start-page) workspace folders, which the auto-seed effect then stages as
    // a default launch intent that bypasses the parent-binding gate. A non-null
    // empty workspace snapshot resolves to zero folders, so nothing auto-stages.
    expect(seed).not.toBeNull();
    expect(seed?.intent).toBeNull();
    expect(seed?.workspace.folders).toEqual([]);
  });

  it("returns no seed before the add menu enables the binding read", () => {
    const seed = resolveOwnerWorkspaceInheritanceSeed({
      enabled: false,
      bindingReadEnabled: false,
      bindingResultReady: false,
      binding: null,
      stagedIntent: null,
      fallbackWorkspaceFolders: ["/workspace/a"],
    });

    expect(seed).toBeNull();
  });

  it("uses legacy fallback folders once the parent binding read resolves empty", () => {
    const seed = resolveOwnerWorkspaceInheritanceSeed({
      enabled: true,
      bindingReadEnabled: true,
      bindingResultReady: true,
      binding: null,
      stagedIntent: null,
      fallbackWorkspaceFolders: ["/workspace/a"],
    });

    expect(seed?.intent).toEqual({
      entries: [
        {
          kind: "local",
          workspacePath: "/workspace/a",
          repoIdentifier: null,
          isPrimary: true,
        },
      ],
    });
  });
});

describe("terminal agent workspace host scope", () => {
  it("keeps row terminal-agent workspace controls on the resolved create host", () => {
    expect(
      buildFixedHostWorkspaceControlsScope({
        hostId: "host-2",
        hostClient: null,
      }),
    ).toEqual({
      kind: "fixed",
      hostId: "host-2",
      hostClient: null,
    });
  });

  it("falls back to active scope only when no create host is resolved", () => {
    expect(
      buildFixedHostWorkspaceControlsScope({
        hostId: null,
        hostClient: null,
      }),
    ).toEqual({ kind: "active" });
  });
});
