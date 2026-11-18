import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createWindowsController,
  setWindowsDefinitionDepsForTests,
  setWindowsTaskInstallDepsForTests,
  setWindowsTaskUserSidReaderForTests,
  type ProcessRunner,
} from "../windows";
import { serviceLabelFor } from "../../label";

// `writeHiddenHostLauncher` is the first write of the install's staging. When
// security software denies it the person must get actionable
// guidance with the original error kept as `cause`; any other write failure
// must surface unchanged. Driven through the real `installService` with the
// real default staging; only the launcher's `writeFile` is made to fail.

const TEST_HOME = mkdtempSync(join(tmpdir(), "traycer-windows-launcher-deny-"));
vi.mock("../../../store/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../store/paths")>();
  return {
    ...actual,
    cliInstallHomeDir: (environment: string) => join(TEST_HOME, environment),
  };
});
vi.mock("../../../host/pid-metadata", () => ({
  readHostPidMetadata: async () => null,
  removeHostPidMetadata: async () => undefined,
  readHostPidMetadataEvidence: async () => ({ kind: "absent" as const }),
}));

let launcherWriteError: NodeJS.ErrnoException | null = null;
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const writeFile: typeof actual.writeFile = async (file, data, options) => {
    if (
      launcherWriteError !== null &&
      typeof file === "string" &&
      file.endsWith("host-start-hidden.vbs")
    ) {
      throw launcherWriteError;
    }
    return actual.writeFile(file, data, options);
  };
  return { ...actual, writeFile };
});

afterAll(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
});

const CALLER_SID = "S-1-5-21-7000-8000-9000-1001";

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: write failed, open 'launcher'`), {
    code,
  });
}

function recordingRunner(): {
  run: ProcessRunner;
  schtasksVerbs: () => string[];
} {
  const verbs: string[] = [];
  const run: ProcessRunner = async (command, args) => {
    if (command === "schtasks") verbs.push(args[0]);
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return { run, schtasksVerbs: () => verbs };
}

async function installCaught(): Promise<{
  caught: unknown;
  schtasksVerbs: string[];
}> {
  // No existing task: the ownership gate reads "absent", so the install
  // reaches the real default staging, whose first write is the launcher.
  setWindowsDefinitionDepsForTests({
    queryTaskXml: async () => ({ kind: "absent" }),
    predictCli: async () => {
      throw new Error("not used");
    },
    resolveCli: async () => {
      throw new Error("not used");
    },
  });
  const { run, schtasksVerbs } = recordingRunner();
  const controller = createWindowsController(run, { now: () => 0 });
  const caught = await controller
    .install({
      label: serviceLabelFor("staging"),
      cli: { command: "C:\\traycer.exe", args: [] },
      enableLinger: false,
    })
    .then(
      () => null,
      (err: unknown) => err,
    );
  return { caught, schtasksVerbs: schtasksVerbs() };
}

beforeEach(() => {
  setWindowsTaskInstallDepsForTests(null);
  setWindowsTaskUserSidReaderForTests(() => CALLER_SID);
});
afterEach(() => {
  launcherWriteError = null;
  vi.restoreAllMocks();
  setWindowsDefinitionDepsForTests(null);
  setWindowsTaskInstallDepsForTests(null);
  setWindowsTaskUserSidReaderForTests(null);
});

describe("installService: a denied launcher write", () => {
  it.each(["EPERM", "EACCES"])(
    "%s explains the security-software block, keeps the cause, and registers no task",
    async (code) => {
      const denied = errnoError(code);
      launcherWriteError = denied;

      const { caught, schtasksVerbs } = await installCaught();

      if (!(caught instanceof Error)) throw new Error("expected an Error");
      const message = caught.message;
      expect(message).toContain("Windows denied permission");
      expect(message).toContain("security software");
      expect(message).toContain(".traycer");
      expect(message).toContain("restart Traycer");
      expect(message).not.toContain(code);
      expect(caught.cause).toBe(denied);
      expect(schtasksVerbs).not.toContain("/Create");
      expect(schtasksVerbs).not.toContain("/Run");
    },
  );

  it("rethrows an unrelated write failure (ENOSPC) as the same error", async () => {
    const full = errnoError("ENOSPC");
    launcherWriteError = full;

    const { caught, schtasksVerbs } = await installCaught();

    expect(caught).toBe(full);
    expect(schtasksVerbs).not.toContain("/Create");
    expect(schtasksVerbs).not.toContain("/Run");
  });
});
