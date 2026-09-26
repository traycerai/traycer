import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_ERROR_CODES } from "../../../runner/errors";
import { serviceLabelFor } from "../../label";
import type { CliInvocation } from "../../cli-binary";

// SSH-USERDOMAIN-WORKGROUP: an OpenSSH session on a workgroup machine sets
// `USERDOMAIN=WORKGROUP`, and schtasks rejects `WORKGROUP\<name>` from EVERY
// session - `host install` over ssh used to emit exactly that and then fail
// to register. `resolveTaskUserId` (via `buildScheduledTaskXml`, the
// `buildTaskXml`/`buildScheduledTaskXml` export used across this suite) now
// prefers the account SID from `whoami /user`, and only falls back to an
// environment-derived name - never `WORKGROUP\<name>` - when no SID can be
// read. See `windows.ts`'s `resolveTaskUserId` docblock for the full
// rationale and the live-VM probe (PROBE-TASK-USERID-SSH) this codifies.
//
// Every case stubs all four inputs (`USERDOMAIN`, `USERDNSDOMAIN`,
// `COMPUTERNAME`, `USERNAME`) explicitly - an empty string models "unset"
// exactly the way `resolveTaskUserIdFromEnvironment`'s own
// `process.env.X ?? ""` does, since `??` never fires on an already-empty
// string - so no case depends on whatever the real host machine happens to
// have set.

function stubUserIdEnv(env: {
  readonly USERDOMAIN: string;
  readonly USERDNSDOMAIN: string;
  readonly COMPUTERNAME: string;
  readonly USERNAME: string;
}): void {
  vi.stubEnv("USERDOMAIN", env.USERDOMAIN);
  vi.stubEnv("USERDNSDOMAIN", env.USERDNSDOMAIN);
  vi.stubEnv("COMPUTERNAME", env.COMPUTERNAME);
  vi.stubEnv("USERNAME", env.USERNAME);
}

function sampleCli(): CliInvocation {
  return {
    command: "C:\\Users\\test\\.traycer\\cli\\bin\\traycer.exe",
    args: [],
  };
}

function userIdsIn(xml: string): readonly string[] {
  const matches = xml.match(/<UserId>([^<]*)<\/UserId>/g);
  return matches === null ? [] : matches;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Windows Task XML <UserId>: SID-first, env fallback never names WORKGROUP", () => {
  afterEach(async () => {
    const { setWindowsTaskUserSidReaderForTests } = await import("../windows");
    setWindowsTaskUserSidReaderForTests(null);
  });

  it("U1: a readable SID wins over every env field, including an ssh WORKGROUP domain", async () => {
    const { buildScheduledTaskXml, setWindowsTaskUserSidReaderForTests } =
      await import("../windows");
    const sid = "S-1-5-21-1-2-3-1001";
    setWindowsTaskUserSidReaderForTests(() => sid);
    stubUserIdEnv({
      USERDOMAIN: "WORKGROUP",
      USERDNSDOMAIN: "",
      COMPUTERNAME: "BOX",
      USERNAME: "alice",
    });

    const xml = buildScheduledTaskXml({
      label: serviceLabelFor("staging"),
      cli: sampleCli(),
    });

    expect(userIdsIn(xml)).toEqual([
      `<UserId>${sid}</UserId>`,
      `<UserId>${sid}</UserId>`,
    ]);
    expect(xml).not.toContain("WORKGROUP");
  });

  it("U2: no SID, ssh WORKGROUP domain: falls back to COMPUTERNAME, never WORKGROUP\\alice", async () => {
    const { buildScheduledTaskXml, setWindowsTaskUserSidReaderForTests } =
      await import("../windows");
    setWindowsTaskUserSidReaderForTests(() => null);
    stubUserIdEnv({
      USERDOMAIN: "WORKGROUP",
      USERDNSDOMAIN: "",
      COMPUTERNAME: "BOX",
      USERNAME: "alice",
    });

    const xml = buildScheduledTaskXml({
      label: serviceLabelFor("staging"),
      cli: sampleCli(),
    });

    expect(userIdsIn(xml)).toEqual([
      "<UserId>BOX\\alice</UserId>",
      "<UserId>BOX\\alice</UserId>",
    ]);
    expect(xml).not.toContain("WORKGROUP\\alice");
  });

  it("U3: no SID, interactive logon (USERDOMAIN === COMPUTERNAME): unchanged BOX\\alice", async () => {
    const { buildScheduledTaskXml, setWindowsTaskUserSidReaderForTests } =
      await import("../windows");
    setWindowsTaskUserSidReaderForTests(() => null);
    stubUserIdEnv({
      USERDOMAIN: "BOX",
      USERDNSDOMAIN: "",
      COMPUTERNAME: "BOX",
      USERNAME: "alice",
    });

    const xml = buildScheduledTaskXml({
      label: serviceLabelFor("staging"),
      cli: sampleCli(),
    });

    expect(userIdsIn(xml)).toEqual([
      "<UserId>BOX\\alice</UserId>",
      "<UserId>BOX\\alice</UserId>",
    ]);
  });

  it("U4: no SID, a domain logon (USERDNSDOMAIN set): unchanged CORP\\alice", async () => {
    const { buildScheduledTaskXml, setWindowsTaskUserSidReaderForTests } =
      await import("../windows");
    setWindowsTaskUserSidReaderForTests(() => null);
    stubUserIdEnv({
      USERDOMAIN: "CORP",
      USERDNSDOMAIN: "corp.example.com",
      COMPUTERNAME: "BOX",
      USERNAME: "alice",
    });

    const xml = buildScheduledTaskXml({
      label: serviceLabelFor("staging"),
      cli: sampleCli(),
    });

    expect(userIdsIn(xml)).toEqual([
      "<UserId>CORP\\alice</UserId>",
      "<UserId>CORP\\alice</UserId>",
    ]);
  });

  it("U5: no SID, no COMPUTERNAME: falls back to USERDOMAIN, then to a bare name", async () => {
    const { buildScheduledTaskXml, setWindowsTaskUserSidReaderForTests } =
      await import("../windows");
    setWindowsTaskUserSidReaderForTests(() => null);
    stubUserIdEnv({
      USERDOMAIN: "CORP",
      USERDNSDOMAIN: "",
      COMPUTERNAME: "",
      USERNAME: "alice",
    });

    const withDomain = buildScheduledTaskXml({
      label: serviceLabelFor("staging"),
      cli: sampleCli(),
    });
    expect(userIdsIn(withDomain)).toEqual([
      "<UserId>CORP\\alice</UserId>",
      "<UserId>CORP\\alice</UserId>",
    ]);

    stubUserIdEnv({
      USERDOMAIN: "",
      USERDNSDOMAIN: "",
      COMPUTERNAME: "",
      USERNAME: "alice",
    });
    const bare = buildScheduledTaskXml({
      label: serviceLabelFor("staging"),
      cli: sampleCli(),
    });
    expect(userIdsIn(bare)).toEqual([
      "<UserId>alice</UserId>",
      "<UserId>alice</UserId>",
    ]);
  });

  it("U6: no SID, no USERNAME: fails closed with SERVICE_INSTALL_FAILED", async () => {
    const { buildScheduledTaskXml, setWindowsTaskUserSidReaderForTests } =
      await import("../windows");
    setWindowsTaskUserSidReaderForTests(() => null);
    stubUserIdEnv({
      USERDOMAIN: "",
      USERDNSDOMAIN: "",
      COMPUTERNAME: "",
      USERNAME: "",
    });

    let caught: unknown = null;
    try {
      buildScheduledTaskXml({
        label: serviceLabelFor("staging"),
        cli: sampleCli(),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
    });
  });
});

// U7: the real `whoami /user /fo csv /nh` reader, end to end. `windows.ts`
// imports `execFileSync` directly from `node:child_process`, so this block
// mocks that module (spreading `importOriginal` - `process-runner.ts` and
// others reached transitively from `windows.ts` import other members of
// `node:child_process`, and a bare replacement would break them) and stubs
// `process.platform` to `win32`, since `readCurrentUserSidFromWhoami` is a
// no-op everywhere else.
class WhoamiNonZeroExitError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Command failed: whoami.exe /user /fo csv /nh`);
    this.status = status;
  }
}

class WhoamiTimeoutError extends Error {
  readonly code: string;
  readonly signal: string;
  constructor(code: string, signal: string) {
    super(`Command timed out`);
    this.code = code;
    this.signal = signal;
  }
}

interface ExecFileSyncCall {
  readonly file: string;
  readonly args: readonly string[];
}

let execFileSyncImpl: (() => string) | null = null;
const execFileSyncCalls: ExecFileSyncCall[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (file: string, args: readonly string[]): string => {
      execFileSyncCalls.push({ file, args: [...args] });
      if (execFileSyncImpl === null) {
        throw new Error("execFileSync not configured for this test");
      }
      return execFileSyncImpl();
    },
  };
});

describe("Windows Task XML <UserId>: the real whoami SID reader (U7)", () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    "platform",
  );

  beforeEach(() => {
    execFileSyncImpl = null;
    execFileSyncCalls.length = 0;
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
  });

  afterEach(async () => {
    if (originalPlatformDescriptor !== undefined) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    const { setWindowsTaskUserSidReaderForTests } = await import("../windows");
    setWindowsTaskUserSidReaderForTests(null);
  });

  it("U7a: a well-formed csv row resolves the SID from whoami, called exactly once with the System32 path", async () => {
    const { buildScheduledTaskXml, setWindowsTaskUserSidReaderForTests } =
      await import("../windows");
    setWindowsTaskUserSidReaderForTests(null);
    vi.stubEnv("SystemRoot", "C:\\Windows");
    vi.stubEnv("SYSTEMROOT", "C:\\Windows");
    stubUserIdEnv({
      USERDOMAIN: "WORKGROUP",
      USERDNSDOMAIN: "",
      COMPUTERNAME: "BOX",
      USERNAME: "alice",
    });
    execFileSyncImpl = () => '"box\\alice","S-1-5-21-1-2-3-1001"\r\n';

    const xml = buildScheduledTaskXml({
      label: serviceLabelFor("staging"),
      cli: sampleCli(),
    });

    expect(userIdsIn(xml)).toEqual([
      "<UserId>S-1-5-21-1-2-3-1001</UserId>",
      "<UserId>S-1-5-21-1-2-3-1001</UserId>",
    ]);
    expect(execFileSyncCalls).toEqual([
      {
        file: "C:\\Windows\\System32\\whoami.exe",
        args: ["/user", "/fo", "csv", "/nh"],
      },
    ]);
  });

  it("U7b: execFileSync throwing a non-zero-exit error falls back to the env form", async () => {
    const { buildScheduledTaskXml, setWindowsTaskUserSidReaderForTests } =
      await import("../windows");
    setWindowsTaskUserSidReaderForTests(null);
    stubUserIdEnv({
      USERDOMAIN: "WORKGROUP",
      USERDNSDOMAIN: "",
      COMPUTERNAME: "BOX",
      USERNAME: "alice",
    });
    execFileSyncImpl = () => {
      throw new WhoamiNonZeroExitError(1);
    };

    const xml = buildScheduledTaskXml({
      label: serviceLabelFor("staging"),
      cli: sampleCli(),
    });

    expect(userIdsIn(xml)).toEqual([
      "<UserId>BOX\\alice</UserId>",
      "<UserId>BOX\\alice</UserId>",
    ]);
    expect(xml).not.toContain("WORKGROUP\\alice");
  });

  it("U7c: execFileSync throwing a timeout error falls back to the env form", async () => {
    const { buildScheduledTaskXml, setWindowsTaskUserSidReaderForTests } =
      await import("../windows");
    setWindowsTaskUserSidReaderForTests(null);
    stubUserIdEnv({
      USERDOMAIN: "WORKGROUP",
      USERDNSDOMAIN: "",
      COMPUTERNAME: "BOX",
      USERNAME: "alice",
    });
    execFileSyncImpl = () => {
      throw new WhoamiTimeoutError("ETIMEDOUT", "SIGTERM");
    };

    const xml = buildScheduledTaskXml({
      label: serviceLabelFor("staging"),
      cli: sampleCli(),
    });

    expect(userIdsIn(xml)).toEqual([
      "<UserId>BOX\\alice</UserId>",
      "<UserId>BOX\\alice</UserId>",
    ]);
    expect(xml).not.toContain("WORKGROUP\\alice");
  });

  it("U7d: garbage stdout with no SID falls back to the env form", async () => {
    const { buildScheduledTaskXml, setWindowsTaskUserSidReaderForTests } =
      await import("../windows");
    setWindowsTaskUserSidReaderForTests(null);
    stubUserIdEnv({
      USERDOMAIN: "WORKGROUP",
      USERDNSDOMAIN: "",
      COMPUTERNAME: "BOX",
      USERNAME: "alice",
    });
    execFileSyncImpl = () => "INFO: blah\r\n";

    const xml = buildScheduledTaskXml({
      label: serviceLabelFor("staging"),
      cli: sampleCli(),
    });

    expect(userIdsIn(xml)).toEqual([
      "<UserId>BOX\\alice</UserId>",
      "<UserId>BOX\\alice</UserId>",
    ]);
    expect(xml).not.toContain("WORKGROUP\\alice");
  });

  it("U7e: empty stdout falls back to the env form", async () => {
    const { buildScheduledTaskXml, setWindowsTaskUserSidReaderForTests } =
      await import("../windows");
    setWindowsTaskUserSidReaderForTests(null);
    stubUserIdEnv({
      USERDOMAIN: "WORKGROUP",
      USERDNSDOMAIN: "",
      COMPUTERNAME: "BOX",
      USERNAME: "alice",
    });
    execFileSyncImpl = () => "";

    const xml = buildScheduledTaskXml({
      label: serviceLabelFor("staging"),
      cli: sampleCli(),
    });

    expect(userIdsIn(xml)).toEqual([
      "<UserId>BOX\\alice</UserId>",
      "<UserId>BOX\\alice</UserId>",
    ]);
    expect(xml).not.toContain("WORKGROUP\\alice");
  });
});
