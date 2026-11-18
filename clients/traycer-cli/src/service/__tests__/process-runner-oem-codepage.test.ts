import { afterEach, describe, expect, it, vi } from "vitest";

// The probe is the only part that needs Windows; everything else in
// the decode path is real. `vi.hoisted` because the factory runs before the
// imports below.
const probe = vi.hoisted(() => ({
  codePage: null as number | null,
  rejects: false,
}));
vi.mock("../oem-codepage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../oem-codepage")>();
  return {
    ...actual,
    systemOemCodePage: () =>
      probe.rejects
        ? Promise.reject(new Error("probe failed"))
        : Promise.resolve(probe.codePage),
  };
});

import {
  cachedCodePageProbe,
  DECODER_LABEL_BY_CODEPAGE,
  decodeChildOutput,
  parseOemCodePage,
  type RegQueryExec,
} from "../oem-codepage";
import {
  ProcessRunError,
  runCommand,
  runCommandForBytes,
} from "../process-runner";

// What a Russian Windows `schtasks` prints for a missing task, written from
// the Cyrillic text and the decoder's own table rather than pasted as bytes.
const LOCALIZED_NOT_FOUND = "ОШИБКА: Не удается найти указанный файл.";

// There is no cp866 TextEncoder: a single-byte encoding is a 256-entry table,
// so build the encoder by inverting the decoder.
function encodeIbm866(text: string): Buffer {
  const decoder = new TextDecoder("ibm866");
  const byChar = new Map<string, number>();
  for (let byte = 0; byte < 256; byte += 1) {
    byChar.set(decoder.decode(Uint8Array.of(byte)), byte);
  }
  const out: number[] = [];
  for (const char of text) {
    const byte = byChar.get(char);
    if (byte === undefined) throw new Error(`not in cp866: ${char}`);
    out.push(byte);
  }
  return Buffer.from(out);
}

const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform });
}

afterEach(() => {
  if (ORIGINAL_PLATFORM !== undefined) {
    Object.defineProperty(process, "platform", ORIGINAL_PLATFORM);
  }
  probe.codePage = null;
  probe.rejects = false;
});

const options = {
  env: undefined,
  cwd: undefined,
  timeoutMs: 30_000,
  tolerateNonZeroExit: false,
};

function childWriting(stream: "stdout" | "stderr", bytes: Buffer): string[] {
  return [
    "-e",
    `process.${stream}.write(Buffer.from(${JSON.stringify(bytes.toString("base64"))}, "base64")); process.exit(1)`,
  ];
}

describe("the fixture", () => {
  it("is not valid UTF-8, so only the codepage can read it", () => {
    const bytes = encodeIbm866(LOCALIZED_NOT_FOUND);
    expect(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ).toThrow();
    expect(new TextDecoder("ibm866").decode(bytes)).toBe(LOCALIZED_NOT_FOUND);
  });
});

describe("runCommand on Windows with a cp866 system", () => {
  it("builds the ProcessRunError message from the decoded stderr", async () => {
    setPlatform("win32");
    probe.codePage = 866;
    let error: unknown;
    try {
      await runCommand(
        process.execPath,
        childWriting("stderr", encodeIbm866(LOCALIZED_NOT_FOUND)),
        options,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ProcessRunError);
    const failure = error as ProcessRunError;
    expect(failure.message).toContain(
      `exited with code 1: ${LOCALIZED_NOT_FOUND}`,
    );
    expect(failure.stderr).toBe(LOCALIZED_NOT_FOUND);
  });

  it("decodes stdout the same way when the command exits 0 or is tolerated", async () => {
    setPlatform("win32");
    probe.codePage = 866;
    const result = await runCommand(
      process.execPath,
      childWriting("stdout", encodeIbm866(LOCALIZED_NOT_FOUND)),
      { ...options, tolerateNonZeroExit: true },
    );
    expect(result.stdout).toBe(LOCALIZED_NOT_FOUND);
  });

  it("decodes the stderr of the bytes variant, and leaves stdout as bytes", async () => {
    setPlatform("win32");
    probe.codePage = 866;
    const result = await runCommandForBytes(
      process.execPath,
      childWriting("stderr", encodeIbm866(LOCALIZED_NOT_FOUND)),
      { env: undefined, cwd: undefined, timeoutMs: 30_000 },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(LOCALIZED_NOT_FOUND);
    expect(Buffer.isBuffer(result.stdout)).toBe(true);
  });

  it("still settles, with the UTF-8 text, when the codepage probe rejects", async () => {
    setPlatform("win32");
    probe.rejects = true;
    const bytes = encodeIbm866(LOCALIZED_NOT_FOUND);
    let error: unknown;
    try {
      await runCommand(
        process.execPath,
        childWriting("stderr", bytes),
        options,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ProcessRunError);
    expect((error as ProcessRunError).message).toContain(
      `exited with code 1: ${bytes.toString("utf8").trim()}`,
    );
    const result = await runCommandForBytes(
      process.execPath,
      childWriting("stderr", bytes),
      { env: undefined, cwd: undefined, timeoutMs: 30_000 },
    );
    expect(result.stderr).toBe(bytes.toString("utf8"));
  });

  it("keeps UTF-8 a child wrote on purpose, whatever the system codepage", async () => {
    setPlatform("win32");
    probe.codePage = 866;
    const result = await runCommand(
      process.execPath,
      childWriting("stdout", Buffer.from(LOCALIZED_NOT_FOUND, "utf8")),
      { ...options, tolerateNonZeroExit: true },
    );
    expect(result.stdout).toBe(LOCALIZED_NOT_FOUND);
  });
});

describe("decodeChildOutput fallbacks", () => {
  const bytes = encodeIbm866(LOCALIZED_NOT_FOUND);
  const lossy = bytes.toString("utf8");

  it("codepage 866 decodes as cp866", async () => {
    expect(await decodeChildOutput(bytes, () => Promise.resolve(866))).toBe(
      LOCALIZED_NOT_FOUND,
    );
  });

  it.each([65001, null])(
    "codepage %s (UTF-8 system page, or failed probe) decodes as UTF-8",
    async (codePage) => {
      expect(
        await decodeChildOutput(bytes, () => Promise.resolve(codePage)),
      ).toBe(lossy);
    },
  );

  it("an unsupported codepage falls back to UTF-8 without throwing", async () => {
    // 437 and 850 are real OEM pages the WHATWG decoder has no label for.
    for (const codePage of [437, 850, 123456]) {
      expect(
        await decodeChildOutput(bytes, () => Promise.resolve(codePage)),
      ).toBe(lossy);
    }
  });

  it("a source that rejects or throws falls back to UTF-8", async () => {
    expect(
      await decodeChildOutput(bytes, () =>
        Promise.reject(new Error("probe failed")),
      ),
    ).toBe(lossy);
    expect(
      await decodeChildOutput(bytes, () => {
        throw new Error("probe threw");
      }),
    ).toBe(lossy);
  });

  it("reads a literal cp866 byte vector, not only the table-inverted fixture", async () => {
    // "ОШИБКА" in cp866, written as the bytes the OS emits.
    const literal = Buffer.from([0x8e, 0x98, 0x88, 0x81, 0x8a, 0x80]);
    expect(await decodeChildOutput(literal, () => Promise.resolve(866))).toBe(
      "ОШИБКА",
    );
  });

  it("every codepage in the label table has a decoder in this Node", () => {
    for (const [codePage, label] of DECODER_LABEL_BY_CODEPAGE) {
      expect(
        () => new TextDecoder(label),
        `codepage ${String(codePage)} -> ${label}`,
      ).not.toThrow();
    }
  });

  it("does not probe for ASCII or for valid UTF-8", async () => {
    const neverProbed = (): Promise<number | null> => {
      throw new Error("probed");
    };
    expect(
      await decodeChildOutput(
        Buffer.from("ERROR: Access is denied."),
        neverProbed,
      ),
    ).toBe("ERROR: Access is denied.");
    expect(
      await decodeChildOutput(
        Buffer.from(LOCALIZED_NOT_FOUND, "utf8"),
        neverProbed,
      ),
    ).toBe(LOCALIZED_NOT_FOUND);
  });
});

describe("non-Windows platforms", () => {
  it("never consult the OEM codepage", async () => {
    setPlatform("linux");
    probe.codePage = 866;
    const result = await runCommand(
      process.execPath,
      childWriting("stdout", encodeIbm866(LOCALIZED_NOT_FOUND)),
      { ...options, tolerateNonZeroExit: true },
    );
    expect(result.stdout).toBe(
      encodeIbm866(LOCALIZED_NOT_FOUND).toString("utf8"),
    );
  });
});

// The shape `reg query ... /v OEMCP` prints: a blank first line, the key, the
// value row with its REG_SZ type, a trailing blank line, CRLF throughout.
const REG_OUTPUT_866 =
  "\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage\r\n    OEMCP    REG_SZ    866\r\n\r\n";

describe("parseOemCodePage", () => {
  it("reads the OEMCP row of real reg query output", () => {
    expect(parseOemCodePage(Buffer.from(REG_OUTPUT_866, "latin1"))).toBe(866);
    expect(
      parseOemCodePage(
        Buffer.from(REG_OUTPUT_866.replace("866", "65001"), "latin1"),
      ),
    ).toBe(65001);
    expect(
      parseOemCodePage(
        Buffer.from(REG_OUTPUT_866.replaceAll("\r\n", "\n"), "latin1"),
      ),
    ).toBe(866);
  });

  it("is null for output with no OEMCP value row", () => {
    expect(parseOemCodePage(Buffer.alloc(0))).toBeNull();
    expect(
      parseOemCodePage(
        Buffer.from(
          "\r\nERROR: The system was unable to find the specified registry key or value.\r\n",
        ),
      ),
    ).toBeNull();
    // A different value, a wrong type and a non-numeric data are not the page.
    expect(
      parseOemCodePage(Buffer.from("    ACP    REG_SZ    1251\r\n")),
    ).toBeNull();
    expect(
      parseOemCodePage(Buffer.from("    OEMCP    REG_DWORD    0x362\r\n")),
    ).toBeNull();
    expect(
      parseOemCodePage(Buffer.from("    OEMCP    REG_SZ    abc\r\n")),
    ).toBeNull();
  });

  it("reads the value row from a localized reg.exe in cp866 bytes", () => {
    // reg.exe localizes its header text; the OEMCP row's name and data are not.
    const localized = encodeIbm866(
      "\r\nПуть реестра\r\n    OEMCP    REG_SZ    866\r\n",
    );
    expect(parseOemCodePage(localized)).toBe(866);
  });
});

describe("cachedCodePageProbe", () => {
  type Call = {
    file: string;
    args: readonly string[];
    windowsHide: true;
    timeout: number;
  };

  function probeOf(
    behave: (callback: (err: Error | null, stdout: Buffer) => void) => void,
  ): { run: () => Promise<number | null>; calls: Call[] } {
    const calls: Call[] = [];
    const exec: RegQueryExec = (file, args, options, callback) => {
      calls.push({
        file,
        args,
        windowsHide: options.windowsHide,
        timeout: options.timeout,
      });
      behave(callback);
    };
    return { run: cachedCodePageProbe(exec), calls };
  }

  it("queries OEMCP with reg.exe, hidden and with a timeout, and parses it", async () => {
    const { run, calls } = probeOf((callback) => {
      callback(null, Buffer.from(REG_OUTPUT_866, "latin1"));
    });
    expect(await run()).toBe(866);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toMatch(/System32\\reg\.exe$/);
    expect(calls[0]?.args).toEqual([
      "query",
      "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage",
      "/v",
      "OEMCP",
    ]);
    expect(calls[0]?.windowsHide).toBe(true);
    expect(calls[0]?.timeout).toBeGreaterThan(0);
  });

  it("is null when reg.exe fails to spawn", async () => {
    const { run } = probeOf((callback) => {
      callback(new Error("spawn reg.exe ENOENT"), Buffer.alloc(0));
    });
    expect(await run()).toBeNull();
  });

  it("is null when reg.exe exits non-zero (value missing)", async () => {
    const { run } = probeOf((callback) => {
      callback(
        Object.assign(new Error("Command failed"), { code: 1 }),
        Buffer.alloc(0),
      );
    });
    expect(await run()).toBeNull();
  });

  it("is null when reg.exe is killed by the timeout", async () => {
    const { run } = probeOf((callback) => {
      callback(
        Object.assign(new Error("Command failed"), {
          killed: true,
          signal: "SIGTERM",
        }),
        Buffer.alloc(0),
      );
    });
    expect(await run()).toBeNull();
  });

  it("is null when the exec itself throws, and never rejects", async () => {
    const { run } = probeOf(() => {
      throw new Error("spawn threw");
    });
    expect(await run()).toBeNull();
  });

  it("runs the child once per process, sharing the result", async () => {
    const { run, calls } = probeOf((callback) => {
      callback(null, Buffer.from(REG_OUTPUT_866, "latin1"));
    });
    const results = await Promise.all([run(), run()]);
    expect(await run()).toBe(866);
    expect(results).toEqual([866, 866]);
    expect(calls).toHaveLength(1);
  });
});
