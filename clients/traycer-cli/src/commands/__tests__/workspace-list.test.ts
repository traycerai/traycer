import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeBindingSelectorRowV12 } from "@traycer/protocol/host";
import {
  buildWorkspaceListCommand,
  formatWorkspaceListTable,
} from "../workspace-list";
import { callHostRpc } from "../../internal/host-rpc";
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
const PREV_EPIC_ENV = process.env.TRAYCER_EPIC_ID;

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

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TRAYCER_EPIC_ID = "epic_test";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  if (PREV_EPIC_ENV === undefined) delete process.env.TRAYCER_EPIC_ID;
  else process.env.TRAYCER_EPIC_ID = PREV_EPIC_ENV;
});

function row(
  overrides: Partial<WorktreeBindingSelectorRowV12>,
): WorktreeBindingSelectorRowV12 {
  return {
    hostId: "host_1",
    runningDir: "/Users/dev/src/acme-web",
    workspacePath: "/Users/dev/src/acme-web",
    worktreePath: null,
    mode: "local",
    isGitRepo: true,
    repoIdentifier: { owner: "acme", repo: "web" },
    branch: "main",
    isPrimary: true,
    isImported: false,
    setupState: "not_required",
    disabledReason: null,
    sources: [],
    isGitResolvePending: false,
    ...overrides,
  };
}

describe("formatWorkspaceListTable", () => {
  it("shows the empty-state message and create hint when there are no rows", () => {
    const table = formatWorkspaceListTable([]);
    expect(table).toContain("No workspace folders are bound to this Task.");
    expect(table).toContain(
      "traycer worktree create --workspace <path> --branch <name>",
    );
    expect(table).toContain("traycer agent create --cwd <path>");
  });

  it("renders a header row and correct cells for a local row and a worktree row", () => {
    const localRow = row({
      mode: "local",
      workspacePath: "/Users/dev/src/acme-web",
      runningDir: "/Users/dev/src/acme-web",
      branch: "main",
      sources: [
        {
          ownerKind: "chat",
          ownerId: "c1",
          workspacePath: "/Users/dev/src/acme-web",
          isPrimary: true,
          mode: "local",
        },
      ],
    });
    const worktreeRow = row({
      mode: "worktree",
      workspacePath: "/Users/dev/src/acme-web",
      worktreePath: "/Users/dev/.traycer/worktrees/acme__web/feature-x",
      runningDir: "/Users/dev/.traycer/worktrees/acme__web/feature-x",
      branch: "feature/x",
      sources: [],
    });
    const table = formatWorkspaceListTable([localRow, worktreeRow]);
    const lines = table.split("\n");

    expect(lines[0]).toContain("REPO");
    expect(lines[0]).toContain("MODE");
    expect(lines[0]).toContain("BRANCH");
    expect(lines[0]).toContain("GIT");
    expect(lines[0]).toContain("STATE");
    expect(lines[0]).toContain("AGENTS");
    expect(lines[0]).toContain("DIRECTORY");

    expect(lines[1]).toContain("acme/web");
    expect(lines[1]).toContain("local");
    expect(lines[1]).toContain("main");
    expect(lines[1]).toContain("yes");
    expect(lines[1]).toContain("ready");
    expect(lines[1]).toContain("1");
    expect(lines[1]).toContain("/Users/dev/src/acme-web");

    // DIRECTORY must show `runningDir`, not `workspacePath` - for the
    // worktree row those differ.
    expect(lines[2]).toContain("worktree");
    expect(lines[2]).toContain(
      "/Users/dev/.traycer/worktrees/acme__web/feature-x",
    );
    expect(lines[2]).not.toMatch(/\/Users\/dev\/src\/acme-web\s*$/);
  });

  it("renders a dash for a null repoIdentifier and a null branch", () => {
    const table = formatWorkspaceListTable([
      row({ repoIdentifier: null, branch: null }),
    ]);
    const line = table.split("\n")[1];
    // Split on runs of 2+ spaces (the column separator) rather than
    // asserting `toContain("-")` on the whole line - a bare substring check
    // would also match a hyphen inside the DIRECTORY path or a repo name.
    // Column order is REPO, MODE, BRANCH, GIT, STATE, AGENTS, DIRECTORY.
    const cells = line.split(/\s{2,}/);
    expect(cells[0]).toBe("-"); // REPO
    expect(cells[2]).toBe("-"); // BRANCH
  });

  // The default fixture is `mode: "local"`, so a legacy `setup_*`
  // `disabledReason` never trips the blocking check below (that only
  // applies to `mode === "worktree" && !isGitRepo`) and falls through to
  // the setup-lifecycle branch, matching the GUI's
  // `worktreeFolderRowBadge` labels exactly - "setup_running" now reads
  // "setting up", not "setup running".
  it.each([
    [null, "ready"],
    ["setup_pending", "setup pending"],
    ["setup_running", "setting up"],
    ["setup_failed", "setup failed"],
    ["setup_cancelled", "setup cancelled"],
    ["missing_worktree_path", "missing on disk"],
  ] as const)(
    "renders disabledReason %j as %j in the STATE column",
    (disabledReason, label) => {
      const table = formatWorkspaceListTable([row({ disabledReason })]);
      const line = table.split("\n")[1];
      expect(line).toContain(label);
    },
  );

  // Regression coverage for the "creation is the selector gate" fix: once a
  // worktree exists, setup progress/outcomes live in `setupState` with
  // `disabledReason: null`, so `formatState` must read `setupState` too -
  // keying on `disabledReason` alone reported a worktree whose setup script
  // FAILED as plain "ready".
  it.each([
    ["failed", "setup failed"],
    ["running", "setting up"],
    ["pending", "setup pending"],
    ["cancelled", "setup cancelled"],
    ["succeeded", "ready"],
    ["not_required", "ready"],
  ] as const)(
    "REGRESSION: setupState %j with disabledReason: null renders %j (not masked by a null reason)",
    (setupState, label) => {
      const table = formatWorkspaceListTable([
        row({ setupState, disabledReason: null }),
      ]);
      const line = table.split("\n")[1];
      const cells = line.split(/\s{2,}/);
      expect(cells[4]).toBe(label); // STATE
    },
  );

  it("a legacy host's setup_failed reason on a mode: 'local' row is not blocking - it reports 'setup failed'", () => {
    const table = formatWorkspaceListTable([
      row({ mode: "local", disabledReason: "setup_failed" }),
    ]);
    const line = table.split("\n")[1];
    const cells = line.split(/\s{2,}/);
    expect(cells[4]).toBe("setup failed"); // STATE
  });

  it("a legacy host's setup_failed reason on a mode: 'worktree' row with isGitRepo: false IS blocking - it reports 'missing on disk'", () => {
    const table = formatWorkspaceListTable([
      row({
        mode: "worktree",
        isGitRepo: false,
        disabledReason: "setup_failed",
        isGitResolvePending: false,
      }),
    ]);
    const line = table.split("\n")[1];
    const cells = line.split(/\s{2,}/);
    expect(cells[4]).toBe("missing on disk"); // STATE
  });

  it("a legacy host's setup_failed reason on a mode: 'worktree' row with isGitRepo: false reports 'checking' while resolve is pending", () => {
    const table = formatWorkspaceListTable([
      row({
        mode: "worktree",
        isGitRepo: false,
        disabledReason: "setup_failed",
        isGitResolvePending: true,
      }),
    ]);
    const line = table.split("\n")[1];
    const cells = line.split(/\s{2,}/);
    expect(cells[4]).toBe("checking"); // STATE
  });

  it("REGRESSION: a pending row's missing_worktree_path reason is not reported as 'missing on disk' - it renders 'checking' with GIT '?'", () => {
    const table = formatWorkspaceListTable([
      row({
        isGitResolvePending: true,
        disabledReason: "missing_worktree_path",
      }),
    ]);
    const line = table.split("\n")[1];
    const cells = line.split(/\s{2,}/);
    expect(cells[3]).toBe("?"); // GIT
    expect(cells[4]).toBe("checking"); // STATE
    expect(line).not.toContain("missing on disk");
  });

  it("a pending row that is otherwise selectable reports STATE 'ready' but GIT stays '?'", () => {
    const table = formatWorkspaceListTable([
      row({ isGitResolvePending: true, disabledReason: null }),
    ]);
    const line = table.split("\n")[1];
    const cells = line.split(/\s{2,}/);
    expect(cells[3]).toBe("?"); // GIT
    expect(cells[4]).toBe("ready"); // STATE
  });

  it("a pending row with a resolved setup reason is NOT masked by the pending git marker", () => {
    const table = formatWorkspaceListTable([
      row({ isGitResolvePending: true, disabledReason: "setup_failed" }),
    ]);
    const line = table.split("\n")[1];
    const cells = line.split(/\s{2,}/);
    expect(cells[3]).toBe("?"); // GIT
    expect(cells[4]).toBe("setup failed"); // STATE
  });

  it("isGitResolvePending: false keeps the existing yes/no GIT rendering and reason-derived STATE, unchanged", () => {
    const table = formatWorkspaceListTable([
      row({
        isGitResolvePending: false,
        isGitRepo: false,
        disabledReason: "missing_worktree_path",
      }),
    ]);
    const line = table.split("\n")[1];
    const cells = line.split(/\s{2,}/);
    expect(cells[3]).toBe("no"); // GIT
    expect(cells[4]).toBe("missing on disk"); // STATE
  });

  it("aligns every non-final column to a consistent start offset across header and rows", () => {
    const table = formatWorkspaceListTable([
      row({
        repoIdentifier: { owner: "acme", repo: "web" },
        mode: "local",
        branch: "main",
        isGitRepo: true,
        disabledReason: null,
        sources: [
          {
            ownerKind: "chat",
            ownerId: "c1",
            workspacePath: "/x",
            isPrimary: true,
            mode: "local",
          },
        ],
        runningDir: "/short",
      }),
      row({
        repoIdentifier: { owner: "acme", repo: "a-much-longer-repo-name" },
        mode: "worktree",
        branch: "feature-x",
        isGitRepo: false,
        // A worktree row (isGitRepo: false) with a legacy `setup_failed`
        // REASON is now blocking ("missing on disk") under the production
        // fix - use the canonical `setupState` spelling instead, which
        // `hasBlockingWorktreeSelectorReason` never inspects, so this row stays a plain
        // "setup failed" STATE for the column-alignment check below.
        disabledReason: null,
        setupState: "failed",
        sources: [],
        runningDir: "/a/much/longer/directory/path",
      }),
    ]);
    const [header, row1, row2] = table.split("\n");

    // Every non-final column's content begins at the same character offset
    // on the header line and on every data row - proof the padEnd widths
    // are computed consistently across the whole column, not per-row.
    const modeStart = header.indexOf("MODE");
    expect(row1.indexOf("local")).toBe(modeStart);
    expect(row2.indexOf("worktree")).toBe(modeStart);

    const branchStart = header.indexOf("BRANCH");
    expect(row1.indexOf("main")).toBe(branchStart);
    expect(row2.indexOf("feature-x")).toBe(branchStart);

    const gitStart = header.indexOf("GIT");
    expect(row1.indexOf("yes")).toBe(gitStart);
    expect(row2.indexOf("no")).toBe(gitStart);

    const stateStart = header.indexOf("STATE");
    expect(row1.indexOf("ready")).toBe(stateStart);
    expect(row2.indexOf("setup failed")).toBe(stateStart);

    // AGENTS is a bare digit ("1"/"0"), so this only isolates the right
    // column because no earlier cell in either row happens to contain that
    // digit (no digits in the mode/branch/git/state text, and the chosen
    // `runningDir` fixtures below are digit-free) - keep it that way rather
    // than "improving" the fixture with a path that has a stray digit.
    const agentsStart = header.indexOf("AGENTS");
    expect(row1.indexOf("1")).toBe(agentsStart);
    expect(row2.indexOf("0")).toBe(agentsStart);

    // The final DIRECTORY column is never right-padded: no rendered line
    // has trailing whitespace.
    for (const line of table.split("\n")) {
      expect(line).toBe(line.trimEnd());
    }
  });

  it("includes the trailing hint lines", () => {
    const table = formatWorkspaceListTable([row({})]);
    expect(table).toContain(
      "Run an agent in one with `traycer agent create --cwd <directory>`.",
    );
    expect(table).toContain("Run with --json for the full binding records.");
  });
});

describe("buildWorkspaceListCommand", () => {
  it("preserves --json: data is the raw parsed v1.2 host response, including folderlessCwd and isGitResolvePending", async () => {
    const rows = [row({ isGitResolvePending: true })];
    const v12Response = { rows, folderlessCwd: null };
    rpcMock.mockResolvedValue(v12Response);

    const result = await buildWorkspaceListCommand({ epicId: null })(fakeCtx());

    expect(rpcMock).toHaveBeenCalledWith("worktree.listBindingsForEpic", {
      epicId: "epic_test",
    });
    expect(result.data).toEqual(v12Response);
    expect(result.exitCode).toBe(0);
  });
});
