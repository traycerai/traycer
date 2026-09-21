import { afterEach, describe, expect, it } from "vitest";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { WorktreeIntent } from "@traycer/protocol/host/worktree-schemas";
import {
  DEFER_WORKTREE_PROVISIONING_MINOR,
  shouldDeferWorktreeProvisioning,
  type DeferWorktreeProvisioningFacts,
} from "@/lib/worktree/defer-worktree-provisioning";

const HOST_ID = "host-defer-opt-in";

const WORKTREE_INTENT: WorktreeIntent = {
  entries: [
    {
      kind: "worktree",
      scripts: null,
      workspacePath: "/repo",
      repoIdentifier: null,
      isPrimary: true,
      branch: {
        type: "new",
        name: "feat",
        source: "main",
        carryUncommittedChanges: false,
      },
    },
  ],
};

const LOCAL_INTENT: WorktreeIntent = {
  entries: [
    {
      kind: "local",
      workspacePath: "/repo",
      repoIdentifier: null,
      isPrimary: true,
    },
  ],
};

const IMPORT_INTENT: WorktreeIntent = {
  entries: [
    {
      kind: "import",
      workspacePath: "/repo",
      repoIdentifier: null,
      isPrimary: true,
      worktreePath: "/wt/repo",
    },
  ],
};

afterEach(() => {
  resetNegotiatedManifests();
});

function facts(
  overrides: Partial<DeferWorktreeProvisioningFacts>,
): DeferWorktreeProvisioningFacts {
  return {
    hostId: HOST_ID,
    method: "epic.create",
    hasInitialMessage: true,
    workspaceMode: "inherit",
    worktreeIntent: WORKTREE_INTENT,
    ...overrides,
  };
}

function negotiateCreate(minor: number): void {
  recordNegotiatedHostManifest(HOST_ID, {
    "epic.create": { major: 1, minor },
    "epic.createChat": { major: 1, minor },
  });
}

describe("shouldDeferWorktreeProvisioning", () => {
  it("is true when all four facts hold", () => {
    negotiateCreate(DEFER_WORKTREE_PROVISIONING_MINOR);
    expect(shouldDeferWorktreeProvisioning(facts({}))).toBe(true);
  });

  it("is false without an initial message", () => {
    negotiateCreate(2);
    expect(
      shouldDeferWorktreeProvisioning(facts({ hasInitialMessage: false })),
    ).toBe(false);
  });

  it("is false for workspaceMode folderless", () => {
    negotiateCreate(2);
    expect(
      shouldDeferWorktreeProvisioning(facts({ workspaceMode: "folderless" })),
    ).toBe(false);
  });

  it("is false for an intent with only kind: local entries", () => {
    negotiateCreate(2);
    expect(
      shouldDeferWorktreeProvisioning(facts({ worktreeIntent: LOCAL_INTENT })),
    ).toBe(false);
  });

  it("is false for an intent with only kind: import entries", () => {
    negotiateCreate(2);
    expect(
      shouldDeferWorktreeProvisioning(facts({ worktreeIntent: IMPORT_INTENT })),
    ).toBe(false);
  });

  it("is false for a null intent", () => {
    negotiateCreate(2);
    expect(
      shouldDeferWorktreeProvisioning(facts({ worktreeIntent: null })),
    ).toBe(false);
  });

  it("is false when the negotiated read is null (no handshake)", () => {
    expect(shouldDeferWorktreeProvisioning(facts({}))).toBe(false);
  });

  it("is false when the negotiated read is false (method absent)", () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "epic.listTasks": { major: 1, minor: 6 },
    });
    expect(shouldDeferWorktreeProvisioning(facts({}))).toBe(false);
  });

  it("is false on minor 1", () => {
    negotiateCreate(1);
    expect(shouldDeferWorktreeProvisioning(facts({}))).toBe(false);
  });

  it("is true on minor 2", () => {
    negotiateCreate(2);
    expect(shouldDeferWorktreeProvisioning(facts({}))).toBe(true);
  });

  it("is true on a higher minor", () => {
    negotiateCreate(3);
    expect(shouldDeferWorktreeProvisioning(facts({}))).toBe(true);
  });

  it("uses the method named on the facts, not a sibling create", () => {
    recordNegotiatedHostManifest(HOST_ID, {
      "epic.create": { major: 1, minor: 1 },
      "epic.createChat": { major: 1, minor: 2 },
    });
    expect(
      shouldDeferWorktreeProvisioning(facts({ method: "epic.create" })),
    ).toBe(false);
    expect(
      shouldDeferWorktreeProvisioning(facts({ method: "epic.createChat" })),
    ).toBe(true);
  });
});
