import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WorktreeBranchSelection,
  WorktreeCreatePathsResponse,
} from "@traycer/protocol/host";
import {
  buildWorktreeCreateCommand,
  formatWorktreeCreateResult,
  resolveWorktreeBranchSelection,
} from "../worktree-create";
import { callHostRpc } from "../../internal/host-rpc";
import { CliError, CLI_ERROR_CODES } from "../../runner/errors";
import type { CommandContext } from "../../runner/runner";

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../logger", () => ({
  createCliLogger: () => loggerMock,
  errorFromUnknown: (value: unknown) =>
    value instanceof Error ? value : new Error(String(value)),
  noopLogger: loggerMock,
}));

vi.mock("../../internal/host-rpc", async () => {
  const actual = await vi.importActual<
    typeof import("../../internal/host-rpc")
  >("../../internal/host-rpc");
  return {
    ...actual,
    callHostRpc: vi.fn(),
  };
});

const rpcMock = vi.mocked(callHostRpc);

const WORKSPACE = "/Users/dev/src/traycer";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("resolveWorktreeBranchSelection", () => {
  it("builds the new variant with an explicit --source-branch (no host call)", async () => {
    const branch = await resolveWorktreeBranchSelection({
      workspacePath: WORKSPACE,
      newBranch: "feature/x",
      existingBranch: null,
      sourceBranch: "main",
      carryUncommittedChanges: true,
    });

    expect(branch).toEqual({
      type: "new",
      name: "feature/x",
      source: "main",
      carryUncommittedChanges: true,
      collision: "fail",
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("resolves the workspace's current branch when --source-branch is omitted", async () => {
    rpcMock.mockResolvedValue({
      branches: [
        { name: "main", isCurrent: false, isRemoteOnly: false },
        { name: "develop", isCurrent: true, isRemoteOnly: false },
      ],
      uncommittedFileCount: 0,
    });

    const branch = await resolveWorktreeBranchSelection({
      workspacePath: WORKSPACE,
      newBranch: "feature/x",
      existingBranch: null,
      sourceBranch: null,
      carryUncommittedChanges: false,
    });

    expect(rpcMock).toHaveBeenCalledWith("worktree.listBranches", {
      workspacePath: WORKSPACE,
      includeRemote: false,
    });
    expect(branch).toEqual({
      type: "new",
      name: "feature/x",
      source: "develop",
      carryUncommittedChanges: false,
      collision: "fail",
    });
  });

  it("treats a whitespace-only --source-branch as omitted (falls back to current branch)", async () => {
    rpcMock.mockResolvedValue({
      branches: [{ name: "develop", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 0,
    });

    const branch = await resolveWorktreeBranchSelection({
      workspacePath: WORKSPACE,
      newBranch: "feature/x",
      existingBranch: null,
      sourceBranch: "   ",
      carryUncommittedChanges: false,
    });

    // The whitespace value is not used verbatim; the current branch is resolved.
    expect(rpcMock).toHaveBeenCalledWith("worktree.listBranches", {
      workspacePath: WORKSPACE,
      includeRemote: false,
    });
    expect(branch).toEqual({
      type: "new",
      name: "feature/x",
      source: "develop",
      carryUncommittedChanges: false,
      collision: "fail",
    });
  });

  it("errors when no current branch resolves (detached HEAD / non-git)", async () => {
    rpcMock.mockResolvedValue({
      branches: [{ name: "main", isCurrent: false, isRemoteOnly: false }],
      uncommittedFileCount: 0,
    });

    await expect(
      resolveWorktreeBranchSelection({
        workspacePath: WORKSPACE,
        newBranch: "feature/x",
        existingBranch: null,
        sourceBranch: null,
        carryUncommittedChanges: false,
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.INVALID_ARGUMENT });
  });

  it("builds the existing variant with no source/carry (no host call)", async () => {
    const branch = await resolveWorktreeBranchSelection({
      workspacePath: WORKSPACE,
      newBranch: null,
      existingBranch: "release/1.0",
      sourceBranch: null,
      carryUncommittedChanges: false,
    });

    expect(branch).toEqual({ type: "existing", name: "release/1.0" });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects an empty/missing new-branch name with a clear error and no host call", async () => {
    await expect(
      resolveWorktreeBranchSelection({
        workspacePath: WORKSPACE,
        newBranch: "   ",
        existingBranch: null,
        sourceBranch: null,
        carryUncommittedChanges: false,
      }),
    ).rejects.toBeInstanceOf(CliError);

    await expect(
      resolveWorktreeBranchSelection({
        workspacePath: WORKSPACE,
        newBranch: null,
        existingBranch: null,
        sourceBranch: null,
        carryUncommittedChanges: false,
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.INVALID_ARGUMENT });

    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects combining --branch and --existing", async () => {
    await expect(
      resolveWorktreeBranchSelection({
        workspacePath: WORKSPACE,
        newBranch: "feature/x",
        existingBranch: "release/1.0",
        sourceBranch: null,
        carryUncommittedChanges: false,
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.INVALID_ARGUMENT });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects combining --source-branch with --existing instead of silently dropping it", async () => {
    await expect(
      resolveWorktreeBranchSelection({
        workspacePath: WORKSPACE,
        newBranch: null,
        existingBranch: "release/1.0",
        sourceBranch: "main",
        carryUncommittedChanges: false,
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.INVALID_ARGUMENT });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects combining --carry-uncommitted with --existing instead of silently dropping it", async () => {
    await expect(
      resolveWorktreeBranchSelection({
        workspacePath: WORKSPACE,
        newBranch: null,
        existingBranch: "release/1.0",
        sourceBranch: null,
        carryUncommittedChanges: true,
      }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.INVALID_ARGUMENT,
      message: expect.stringContaining("--carry-uncommitted"),
    });
    await expect(
      resolveWorktreeBranchSelection({
        workspacePath: WORKSPACE,
        newBranch: null,
        existingBranch: "release/1.0",
        sourceBranch: null,
        carryUncommittedChanges: true,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("--existing"),
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("still resolves the existing variant when --carry-uncommitted is explicitly false", async () => {
    const branch = await resolveWorktreeBranchSelection({
      workspacePath: WORKSPACE,
      newBranch: null,
      existingBranch: "release/1.0",
      sourceBranch: null,
      carryUncommittedChanges: false,
    });

    expect(branch).toEqual({ type: "existing", name: "release/1.0" });
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

// The `new` selection is itself a two-arm union - `collision?: "fail"` carries
// no `retryIdentity`, `collision: "random"` requires one - so a bare
// `Extract<…, { type: "new" }>` keeps both arms and TS resolves the spread
// against the wrong one. Dropping the random arm leaves the single shape
// `resolveWorktreeBranchSelection` actually produces, which lets this use the
// same `Partial<…>` override idiom as `createResponse` below. (Extracting on
// `collision: "fail"` directly yields `never` - it is OPTIONAL on that arm, so
// the arm is not assignable to a required-property matcher.)
type NewBranchSelection = Exclude<
  Extract<WorktreeBranchSelection, { readonly type: "new" }>,
  { readonly collision: "random" }
>;

function newBranchSelection(
  overrides: Partial<NewBranchSelection>,
): WorktreeBranchSelection {
  return {
    type: "new",
    name: "feature/x",
    source: "main",
    carryUncommittedChanges: false,
    collision: "fail",
    ...overrides,
  };
}

function existingBranchSelection(name: string): WorktreeBranchSelection {
  return { type: "existing", name };
}

function createResponse(
  overrides: Partial<WorktreeCreatePathsResponse>,
): WorktreeCreatePathsResponse {
  return {
    entries: [],
    perEntry: [],
    ...overrides,
  };
}

describe("formatWorktreeCreateResult", () => {
  it("new-branch success: created path, branch/source/repo/mode, and the carry row when carrying", () => {
    const branch = newBranchSelection({
      name: "feature/x",
      source: "main",
      carryUncommittedChanges: true,
    });
    const response = createResponse({
      entries: [
        {
          workspacePath: WORKSPACE,
          path: "/Users/dev/.traycer/worktrees/acme__web/feature-x",
          mode: "worktree",
          repoIdentifier: { owner: "acme", repo: "web" },
          branch: "feature/x",
        },
      ],
      perEntry: [
        {
          workspacePath: WORKSPACE,
          ok: true,
          worktreePath: "/Users/dev/.traycer/worktrees/acme__web/feature-x",
          branch: "feature/x",
          errorMessage: null,
        },
      ],
    });

    const summary = formatWorktreeCreateResult(response, branch);

    expect(summary).toContain(
      "Created worktree /Users/dev/.traycer/worktrees/acme__web/feature-x",
    );
    expect(summary).toContain("feature/x (new branch, forked from main)");
    expect(summary).toContain(WORKSPACE);
    expect(summary).toContain("acme/web");
    expect(summary).toContain("worktree");
    expect(summary).toContain(
      "carry requested - best effort, confirm in the new worktree",
    );
  });

  it("new-branch success: the carry row reads 'left in the source workspace' when not carrying", () => {
    const branch = newBranchSelection({ carryUncommittedChanges: false });
    const response = createResponse({
      entries: [
        {
          workspacePath: WORKSPACE,
          path: "/Users/dev/.traycer/worktrees/acme__web/feature-x",
          mode: "worktree",
          repoIdentifier: { owner: "acme", repo: "web" },
          branch: "feature/x",
        },
      ],
      perEntry: [
        {
          workspacePath: WORKSPACE,
          ok: true,
          worktreePath: "/Users/dev/.traycer/worktrees/acme__web/feature-x",
          branch: "feature/x",
          errorMessage: null,
        },
      ],
    });

    const summary = formatWorktreeCreateResult(response, branch);

    expect(summary).toContain("left in the source workspace");
  });

  it("existing-branch success: '(checked out; the branch already existed)', Source/Repo/Mode rows, and no Uncommitted changes row", () => {
    const branch = existingBranchSelection("release/1.0");
    const response = createResponse({
      entries: [
        {
          workspacePath: WORKSPACE,
          path: "/Users/dev/.traycer/worktrees/acme__web/release-1.0",
          mode: "worktree",
          repoIdentifier: { owner: "acme", repo: "web" },
          branch: "release/1.0",
        },
      ],
      perEntry: [
        {
          workspacePath: WORKSPACE,
          ok: true,
          worktreePath: "/Users/dev/.traycer/worktrees/acme__web/release-1.0",
          branch: "release/1.0",
          errorMessage: null,
        },
      ],
    });

    const summary = formatWorktreeCreateResult(response, branch);

    expect(summary).toContain(
      "release/1.0 (checked out; the branch already existed)",
    );
    expect(summary).toContain(WORKSPACE);
    expect(summary).toContain("acme/web");
    expect(summary).toContain("worktree");
    expect(summary).not.toContain("Uncommitted changes");
  });

  // Regression: `entry.branch` is nullable
  // (`worktreeCreatedPathEntrySchema`), and the requested name used to fill
  // the gap dressed as an observed outcome - "(new branch, forked from x)"
  // even though the host never said the branch materialized. A null is the
  // host DECLINING to state the result, not "same as requested".
  it("REGRESSION: new-branch success with entry.branch: null reports the request was made, not an assumed outcome", () => {
    const branch = newBranchSelection({ name: "feature/x", source: "main" });
    const response = createResponse({
      entries: [
        {
          workspacePath: WORKSPACE,
          path: "/Users/dev/.traycer/worktrees/acme__web/feature-x",
          mode: "worktree",
          repoIdentifier: { owner: "acme", repo: "web" },
          branch: null,
        },
      ],
      perEntry: [
        {
          workspacePath: WORKSPACE,
          ok: true,
          worktreePath: "/Users/dev/.traycer/worktrees/acme__web/feature-x",
          branch: null,
          errorMessage: null,
        },
      ],
    });

    const summary = formatWorktreeCreateResult(response, branch);

    expect(summary).toContain(
      "feature/x (requested; the host did not report the resulting branch)",
    );
    expect(summary).not.toContain("new branch, forked from");
  });

  it("REGRESSION: existing-branch success with entry.branch: null reports the request was made, not an assumed outcome", () => {
    const branch = existingBranchSelection("release/1.0");
    const response = createResponse({
      entries: [
        {
          workspacePath: WORKSPACE,
          path: "/Users/dev/.traycer/worktrees/acme__web/release-1.0",
          mode: "worktree",
          repoIdentifier: { owner: "acme", repo: "web" },
          branch: null,
        },
      ],
      perEntry: [
        {
          workspacePath: WORKSPACE,
          ok: true,
          worktreePath: "/Users/dev/.traycer/worktrees/acme__web/release-1.0",
          branch: null,
          errorMessage: null,
        },
      ],
    });

    const summary = formatWorktreeCreateResult(response, branch);

    expect(summary).toContain(
      "release/1.0 (requested; the host did not report the resulting branch)",
    );
    expect(summary).not.toContain("checked out; the branch already existed");
  });

  it("repoIdentifier: null renders the no-parseable-remote wording", () => {
    const branch = newBranchSelection({});
    const response = createResponse({
      entries: [
        {
          workspacePath: WORKSPACE,
          path: "/Users/dev/.traycer/worktrees/local/feature-x",
          mode: "worktree",
          repoIdentifier: null,
          branch: "feature/x",
        },
      ],
      perEntry: [
        {
          workspacePath: WORKSPACE,
          ok: true,
          worktreePath: "/Users/dev/.traycer/worktrees/local/feature-x",
          branch: "feature/x",
          errorMessage: null,
        },
      ],
    });

    const summary = formatWorktreeCreateResult(response, branch);

    expect(summary).toContain(
      "(no parseable Git remote - filed under a local path)",
    );
  });

  it("a failed perEntry reports 'Could not create a worktree for' with the host's errorMessage", () => {
    const branch = newBranchSelection({});
    const response = createResponse({
      entries: [],
      perEntry: [
        {
          workspacePath: WORKSPACE,
          ok: false,
          worktreePath: null,
          branch: null,
          errorMessage: "branch already checked out elsewhere",
        },
      ],
    });

    const summary = formatWorktreeCreateResult(response, branch);

    expect(summary).toContain(`Could not create a worktree for ${WORKSPACE}`);
    expect(summary).toContain("branch already checked out elsewhere");
  });

  it("a failed perEntry with errorMessage: null falls back to 'The host reported no reason.'", () => {
    const branch = newBranchSelection({});
    const response = createResponse({
      entries: [],
      perEntry: [
        {
          workspacePath: WORKSPACE,
          ok: false,
          worktreePath: null,
          branch: null,
          errorMessage: null,
        },
      ],
    });

    const summary = formatWorktreeCreateResult(response, branch);

    expect(summary).toContain("The host reported no reason.");
  });

  it("perEntry all ok but entries empty: reports the host contradicting itself", () => {
    const branch = newBranchSelection({});
    const response = createResponse({
      entries: [],
      perEntry: [
        {
          workspacePath: WORKSPACE,
          ok: true,
          worktreePath: "/Users/dev/.traycer/worktrees/acme__web/feature-x",
          branch: "feature/x",
          errorMessage: null,
        },
      ],
    });

    const summary = formatWorktreeCreateResult(response, branch);

    expect(summary).toContain("reported success but returned no worktree path");
  });
});

function fakeCtx(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: false,
      environment: "production",
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    },
    output: {
      progress: vi.fn(),
      human: vi.fn(),
      humanRequired: vi.fn(),
      emitResult: vi.fn(),
      emitError: vi.fn(),
    },
    progress: vi.fn(),
  };
}

describe("buildWorktreeCreateCommand", () => {
  it("preserves --json (data is the raw parsed protocol response) and sets exitCode from perEntry.ok", async () => {
    const successResponse: WorktreeCreatePathsResponse = {
      entries: [
        {
          workspacePath: WORKSPACE,
          path: "/Users/dev/.traycer/worktrees/acme__web/feature-x",
          mode: "worktree",
          repoIdentifier: { owner: "acme", repo: "web" },
          branch: "feature/x",
        },
      ],
      perEntry: [
        {
          workspacePath: WORKSPACE,
          ok: true,
          worktreePath: "/Users/dev/.traycer/worktrees/acme__web/feature-x",
          branch: "feature/x",
          errorMessage: null,
        },
      ],
    };
    rpcMock.mockResolvedValue(successResponse);

    const successResult = await buildWorktreeCreateCommand({
      workspacePath: WORKSPACE,
      newBranch: "feature/x",
      existingBranch: null,
      sourceBranch: "main",
      carryUncommittedChanges: false,
    })(fakeCtx());

    expect(successResult.data).toEqual(successResponse);
    expect(successResult.exitCode).toBe(0);

    const failureResponse: WorktreeCreatePathsResponse = {
      entries: [],
      perEntry: [
        {
          workspacePath: WORKSPACE,
          ok: false,
          worktreePath: null,
          branch: null,
          errorMessage: "conflict",
        },
      ],
    };
    rpcMock.mockResolvedValue(failureResponse);

    const failureResult = await buildWorktreeCreateCommand({
      workspacePath: WORKSPACE,
      newBranch: "feature/y",
      existingBranch: null,
      sourceBranch: "main",
      carryUncommittedChanges: false,
    })(fakeCtx());

    expect(failureResult.data).toEqual(failureResponse);
    expect(failureResult.exitCode).toBe(1);
  });
});
