import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCommentsListCommand,
  buildCommentsSetStatusCommand,
} from "../comments";
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
  rpcMock.mockResolvedValue({ artifacts: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  if (PREV_EPIC_ENV === undefined) delete process.env.TRAYCER_EPIC_ID;
  else process.env.TRAYCER_EPIC_ID = PREV_EPIC_ENV;
});

describe("comments list artifact path normalization (CLI-022)", () => {
  it("forwards an absolute path unchanged", async () => {
    const absolute = path.resolve("/tmp/artifacts/spec/index.md");
    await buildCommentsListCommand({
      epicId: null,
      artifactPaths: [absolute],
      status: null,
    })(fakeCtx());

    expect(rpcMock).toHaveBeenCalledWith("comments.listThreads", {
      epicId: "epic_test",
      artifactPaths: [absolute],
      status: "all",
    });
  });

  it("resolves a relative path that does not exist on disk against process.cwd() (the regression)", async () => {
    const relative = "does-not-exist/spec/index.md";
    await buildCommentsListCommand({
      epicId: null,
      artifactPaths: [relative],
      status: null,
    })(fakeCtx());

    expect(rpcMock).toHaveBeenCalledWith("comments.listThreads", {
      epicId: "epic_test",
      artifactPaths: [path.resolve(relative)],
      status: "all",
    });
  });

  it("resolves a relative path that DOES exist on disk to the same absolute form", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "traycer-comments-"));
    const existingFile = path.join(tmpDir, "index.md");
    fs.writeFileSync(existingFile, "# artifact");
    try {
      const originalCwd = process.cwd();
      process.chdir(tmpDir);
      try {
        await buildCommentsListCommand({
          epicId: null,
          artifactPaths: ["index.md"],
          status: null,
        })(fakeCtx());
      } finally {
        process.chdir(originalCwd);
      }

      expect(rpcMock).toHaveBeenCalledWith("comments.listThreads", {
        epicId: "epic_test",
        artifactPaths: [existingFile],
        status: "all",
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("sends artifactPaths: null when no paths are given", async () => {
    await buildCommentsListCommand({
      epicId: null,
      artifactPaths: [],
      status: null,
    })(fakeCtx());

    expect(rpcMock).toHaveBeenCalledWith("comments.listThreads", {
      epicId: "epic_test",
      artifactPaths: null,
      status: "all",
    });
  });

  it("collapses '.' and '..' segments via path.resolve", async () => {
    const messy = "docs/../docs/./spec.md";
    await buildCommentsListCommand({
      epicId: null,
      artifactPaths: [messy],
      status: null,
    })(fakeCtx());

    expect(rpcMock).toHaveBeenCalledWith("comments.listThreads", {
      epicId: "epic_test",
      artifactPaths: [path.resolve(messy)],
      status: "all",
    });
  });
});

describe("comments set-status artifact path normalization (CLI-022)", () => {
  beforeEach(() => {
    rpcMock.mockResolvedValue({ updated: [], failed: [] });
  });

  it("resolves a relative --artifact against process.cwd() before the request", async () => {
    const relative = "docs/spec.md";
    await buildCommentsSetStatusCommand({
      epicId: null,
      artifactPath: relative,
      threadIds: ["t1"],
      status: "resolved",
    })(fakeCtx());

    expect(rpcMock).toHaveBeenCalledWith("comments.setThreadStatus", {
      epicId: "epic_test",
      updates: [
        {
          artifactPath: path.resolve(relative),
          threadIds: ["t1"],
          status: "resolved",
        },
      ],
    });
  });

  it("forwards an absolute --artifact unchanged", async () => {
    const absolute = path.resolve("/tmp/docs/spec.md");
    await buildCommentsSetStatusCommand({
      epicId: null,
      artifactPath: absolute,
      threadIds: ["t1", "t2"],
      status: "open",
    })(fakeCtx());

    expect(rpcMock).toHaveBeenCalledWith("comments.setThreadStatus", {
      epicId: "epic_test",
      updates: [
        {
          artifactPath: absolute,
          threadIds: ["t1", "t2"],
          status: "open",
        },
      ],
    });
  });
});
