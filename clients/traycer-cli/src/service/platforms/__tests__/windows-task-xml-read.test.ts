import { afterEach, describe, expect, it, vi } from "vitest";

// `queryScheduledTaskXml` (windows.ts) reads the task definition through Task
// Scheduler's COM API, run by PowerShell, which answers Base64 of the XML's
// UTF-8 bytes. Through a pipe `schtasks /Query /XML` instead writes UTF-16LE
// on Server 2022 but the OEM code page on Server 2025, which is the encoding
// defect these rows pin. Only `runCommandForBytes` is replaced: the answer is
// decoded by the real function under test, and a test that never reaches the
// seam fails loudly rather than spawning a process.
interface RunnerOptions {
  readonly env: NodeJS.ProcessEnv | undefined;
  readonly cwd: string | undefined;
  readonly timeoutMs: number;
}
interface RunnerAnswer {
  readonly stdout: Buffer;
  readonly exitCode: number;
  readonly stderr: string;
}
interface RunnerCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: RunnerOptions;
}
const runner = vi.hoisted(() => ({
  impl: null as
    | ((
        command: string,
        args: readonly string[],
        options: RunnerOptions,
      ) => Promise<RunnerAnswer>)
    | null,
  calls: [] as RunnerCall[],
}));
vi.mock("../../process-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../process-runner")>();
  return {
    ...actual,
    runCommandForBytes: async (
      command: string,
      args: readonly string[],
      options: RunnerOptions,
    ) => {
      runner.calls.push({ command, args: [...args], options });
      if (runner.impl === null) {
        throw new Error(
          "runCommandForBytes called without a configured mock impl",
        );
      }
      return runner.impl(command, args, options);
    },
  };
});

import { queryScheduledTaskXml } from "../windows";
import { canonicalTaskXml } from "../../../data-migration/external-actions/windows-task-actions";

afterEach(() => {
  runner.impl = null;
  runner.calls = [];
});

const TASK_NAME = "\\Traycer\\Host";
const DATA_DIR = "D:\\q8t\\p4\\Tráycer Data m";

/** What the COM read prints on success: Base64 of the XML's UTF-8 bytes. */
function base64Answer(xml: string): RunnerAnswer {
  return {
    stdout: Buffer.from(Buffer.from(xml, "utf8").toString("base64"), "latin1"),
    exitCode: 0,
    stderr: "",
  };
}

/**
 * The XML as `schtasks` writes it through a pipe on Server 2025: OEM code page
 * 437, where `á` is the single byte 0xA0. There is no cp437 TextEncoder, so
 * the bytes are assembled by hand and everything else must be ASCII.
 */
function oem437Bytes(text: string): Buffer {
  const pieces: Buffer[] = [];
  text.split("á").forEach((part, index) => {
    expect(/^[\u0020-\u007e\r\n]*$/u.test(part)).toBe(true);
    if (index > 0) pieces.push(Buffer.from([0xa0]));
    pieces.push(Buffer.from(part, "latin1"));
  });
  return Buffer.concat(pieces);
}

/** A Server 2025 machine: `schtasks /XML` answers OEM bytes, PowerShell the Base64. */
function modelServer2025(xml: string): void {
  runner.impl = async (command, args) => {
    if (command === "schtasks" && args.includes("/XML")) {
      return { stdout: oem437Bytes(xml), exitCode: 0, stderr: "" };
    }
    if (command === "powershell") return base64Answer(xml);
    throw new Error(`unexpected command ${command}`);
  };
}

/** The `.Xml` property of the COM task: UTF-16 declaration, `\r\n` endings. */
const COM_XML = [
  '<?xml version="1.0" encoding="UTF-16"?>',
  '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
  "  <Principals>",
  '    <Principal id="Author">',
  "      <UserId>S-1-5-21-1000-2000-3000-1001</UserId>",
  "    </Principal>",
  "  </Principals>",
  '  <Actions Context="Author">',
  "    <Exec>",
  `      <Command>${DATA_DIR}\\bin\\traycer.exe</Command>`,
  `      <Arguments>"${DATA_DIR}" host run</Arguments>`,
  "    </Exec>",
  "  </Actions>",
  "</Task>",
  "",
].join("\r\n");

describe("queryScheduledTaskXml: the task definition read", () => {
  it("returns the exact XML from the Base64 answer, asking PowerShell with the task name in the environment", async () => {
    runner.impl = async () => base64Answer(COM_XML);

    const result = await queryScheduledTaskXml(TASK_NAME);

    expect(result).toEqual({ kind: "xml", xml: COM_XML });
    expect(runner.calls).toHaveLength(1);
    const call = runner.calls[0];
    if (call === undefined) throw new Error("unreachable");
    expect(call.command).toBe("powershell");
    expect(call.args).toEqual(
      expect.arrayContaining(["-NoProfile", "-NonInteractive", "-Command"]),
    );
    expect(call.options.env?.["TRAYCER_TASK_NAME"]).toBe(TASK_NAME);
  });

  it("exit 2 (the task or its folder does not exist) is absent", async () => {
    runner.impl = async () => ({
      stdout: Buffer.alloc(0),
      exitCode: 2,
      stderr: "",
    });

    expect(await queryScheduledTaskXml(TASK_NAME)).toEqual({ kind: "absent" });
  });

  it("any other non-zero exit is failed, carrying only the script's own HRESULT", async () => {
    runner.impl = async () => ({
      stdout: Buffer.alloc(0),
      exitCode: 4,
      stderr: "0x80070005",
    });
    expect(await queryScheduledTaskXml(TASK_NAME)).toEqual({
      kind: "failed",
      reason: "the task definition read failed (exit 4, 0x80070005)",
    });

    // PowerShell's own text is unbounded and in the system's language: it is
    // never carried into the reason.
    runner.impl = async () => ({
      stdout: Buffer.alloc(0),
      exitCode: 4,
      stderr: "Access is denied.\r\nAt line:1 char:1\r\n",
    });
    expect(await queryScheduledTaskXml(TASK_NAME)).toEqual({
      kind: "failed",
      reason: "the task definition read failed (exit 4)",
    });
  });

  // A byte the strict decode does not expect is refused, never repaired: a
  // repaired payload would be a path the task never named.
  it.each([
    { name: "empty stdout", stdout: Buffer.alloc(0) },
    { name: "text that is not Base64", stdout: Buffer.from("not-base64!!") },
    {
      name: "a length that is not a multiple of 4",
      stdout: Buffer.from("QUJ", "latin1"),
    },
    {
      name: "a stray non-ASCII byte inside a Base64 payload",
      stdout: Buffer.concat([
        Buffer.from("QUJD", "latin1"),
        Buffer.from([0xe9]),
        Buffer.from("QUJ", "latin1"),
      ]),
    },
    {
      // Read as latin1, 0xA0 is U+00A0, which `trim()` strips as whitespace.
      name: "a trailing 0xA0 after a valid Base64 payload",
      stdout: Buffer.concat([
        Buffer.from("QUJD", "latin1"),
        Buffer.from([0xa0]),
      ]),
    },
    {
      name: "Base64 of invalid UTF-8 (the OEM bytes re-encoded)",
      stdout: Buffer.from(
        Buffer.from([0x3c, 0x41, 0xa0, 0x3e]).toString("base64"),
        "latin1",
      ),
    },
  ])("exit 0 with $name is failed", async ({ stdout }) => {
    runner.impl = async () => ({ stdout, exitCode: 0, stderr: "" });

    expect(await queryScheduledTaskXml(TASK_NAME)).toEqual({
      kind: "failed",
      reason: "the task definition read returned no XML",
    });
  });

  it("a runner that cannot run PowerShell is failed, not thrown", async () => {
    runner.impl = async () => {
      throw new Error("spawn powershell ENOENT");
    };

    const result = await queryScheduledTaskXml(TASK_NAME);

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("unreachable");
    expect(result.reason).toContain("could not run");
    expect(result.reason).toContain("spawn powershell ENOENT");
  });

  // On the `schtasks /Query /XML` reader this was
  // `failed: "schtasks /Query /XML output is not text"`: Server 2025 wrote the
  // OEM code page through the pipe, so `á` arrived as the lone byte 0xA0.
  it("Server 2025: a definition whose path is outside ASCII (OEM 0xA0 for á through schtasks) reads back as the exact XML", async () => {
    modelServer2025(COM_XML);

    const result = await queryScheduledTaskXml(TASK_NAME);

    expect(result).toEqual({ kind: "xml", xml: COM_XML });
    expect(runner.calls.map((call) => call.command)).toEqual(["powershell"]);
  });
});

describe("queryScheduledTaskXml: a read of a non-ASCII definition compares equal to the plan", () => {
  const PLANNED = [
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <Settings>",
    "    <Enabled>true</Enabled>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    `      <Command>${DATA_DIR}\\bin\\traycer.exe</Command>`,
    `      <Arguments>&quot;${DATA_DIR}&quot; host run</Arguments>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
  ].join("\n");

  // What Task Scheduler stores and COM returns: the task-level
  // `<Enabled>true</Enabled>` dropped, `&quot;` read back as `"`, a UTF-16
  // declaration and `\r\r\n` line endings.
  const STORED = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <Settings>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    `      <Command>${DATA_DIR}\\bin\\traycer.exe</Command>`,
    `      <Arguments>"${DATA_DIR}" host run</Arguments>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\r\n");

  it("the stored definition read back through the Base64 answer is canonically the planned one", async () => {
    runner.impl = async () => base64Answer(STORED);

    const result = await queryScheduledTaskXml(TASK_NAME);

    expect(result).toEqual({ kind: "xml", xml: STORED });
    if (result.kind !== "xml") throw new Error("unreachable");
    expect(canonicalTaskXml(result.xml)).toBe(canonicalTaskXml(PLANNED));
  });

  it("control: the same definition with the path a code page made of an unmappable character (Tr?ycer) is not canonically equal", async () => {
    runner.impl = async () =>
      base64Answer(STORED.replaceAll("Tráycer", "Tr?ycer"));

    const result = await queryScheduledTaskXml(TASK_NAME);

    expect(result.kind).toBe("xml");
    if (result.kind !== "xml") throw new Error("unreachable");
    expect(canonicalTaskXml(result.xml)).not.toBe(canonicalTaskXml(PLANNED));
  });
});
