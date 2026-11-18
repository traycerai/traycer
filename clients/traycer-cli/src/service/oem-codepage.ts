import { execFile } from "node:child_process";

/**
 * WHATWG `TextDecoder` label for each Windows codepage the decoder can read.
 * Most OEM pages (437, 850, 852, ...) have no WHATWG label, so they are absent
 * on purpose: they fall back to UTF-8, which is what every Windows child was
 * decoded as before this table existed.
 */
export const DECODER_LABEL_BY_CODEPAGE: ReadonlyMap<number, string> = new Map([
  [866, "ibm866"],
  [874, "windows-874"],
  [932, "shift_jis"],
  [936, "gbk"],
  [949, "euc-kr"],
  [950, "big5"],
  [1250, "windows-1250"],
  [1251, "windows-1251"],
  [1252, "windows-1252"],
  [1253, "windows-1253"],
  [1254, "windows-1254"],
  [1255, "windows-1255"],
  [1256, "windows-1256"],
  [1257, "windows-1257"],
  [1258, "windows-1258"],
  [20866, "koi8-r"],
  [21866, "koi8-u"],
  [54936, "gb18030"],
]);

/** How long the one-time `reg query` probe may run before it is read as "unknown". */
const OEM_PROBE_TIMEOUT_MS = 5_000;

const NLS_CODEPAGE_KEY =
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage";

/**
 * The number in the `OEMCP    REG_SZ    866` row of `reg query ... /v OEMCP`,
 * whatever language `reg.exe` localizes the rest of its output into.
 */
export function parseOemCodePage(output: Buffer): number | null {
  // `latin1`: only the ASCII value row is read.
  const match = /^\s*OEMCP\s+REG_SZ\s+(\d+)\s*$/m.exec(
    output.toString("latin1"),
  );
  if (match === null || match[1] === undefined) return null;
  const codePage = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(codePage) && codePage > 0 ? codePage : null;
}

function windowsSystemExecutable(filename: string): string {
  const root =
    process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  return `${root.replace(/[\\/]+$/, "")}\\System32\\${filename}`;
}

/**
 * The slice of `execFile` the probe uses, so a test can stand in for the real
 * child. `callback` receives the error (or `null`) and the captured stdout.
 */
export type RegQueryExec = (
  file: string,
  args: readonly string[],
  options: {
    readonly timeout: number;
    readonly windowsHide: true;
    readonly encoding: "buffer";
  },
  callback: (err: Error | null, stdout: Buffer) => void,
) => void;

const execRegQuery: RegQueryExec = (file, args, options, callback) => {
  execFile(file, [...args], { ...options }, (err, stdout) => {
    callback(err, stdout);
  });
};

/**
 * A once-per-process probe of the system OEM codepage that runs `exec` on
 * first use and resolves `null` for every failure (a spawn error, a non-zero
 * exit, a timeout, unparseable output, `exec` throwing). It never rejects, and
 * what it resolved is what every later call gets.
 *
 * It reads the registry rather than asking a console (`chcp`): the runner
 * spawns with `windowsHide` and piped stdio, which libuv turns into
 * `CREATE_NO_WINDOW`, so neither the commands nor a `chcp` child have a
 * console to ask. `reg.exe` needs none.
 */
export function cachedCodePageProbe(
  exec: RegQueryExec,
): () => Promise<number | null> {
  let cached: Promise<number | null> | null = null;
  return () => {
    cached ??= new Promise<number | null>((resolve) => {
      try {
        exec(
          windowsSystemExecutable("reg.exe"),
          ["query", NLS_CODEPAGE_KEY, "/v", "OEMCP"],
          {
            timeout: OEM_PROBE_TIMEOUT_MS,
            windowsHide: true,
            encoding: "buffer",
          },
          (err, stdout) => {
            resolve(err === null ? parseOemCodePage(stdout) : null);
          },
        );
      } catch {
        resolve(null);
      }
    });
    return cached;
  };
}

/**
 * The system OEM codepage a console-less command (which is how the runner
 * spawns every child) writes its text in, `null` when it cannot be read.
 * Probed once per process, on first use.
 */
export const systemOemCodePage: () => Promise<number | null> =
  cachedCodePageProbe(execRegQuery);

/** `bytes` as text, or `null` when they are not well-formed UTF-8. */
function strictUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function hasNonAscii(bytes: Buffer): boolean {
  return bytes.some((byte) => byte >= 0x80);
}

/**
 * Decode a Windows child's captured output.
 *
 * A console program writes in the system OEM codepage (cp866 on a Russian
 * install), not UTF-8. The order is:
 * 1. all ASCII: every codepage agrees, so nothing is probed;
 * 2. well-formed UTF-8: a child that chose UTF-8 on purpose keeps it. A
 *    legacy-codepage message is almost never well-formed UTF-8; a bare
 *    lowercase cp866 word of 3, 6 or 9 letters can be by accident, and no
 *    realistic localized sentence is;
 * 3. the OEM codepage, through the WHATWG decoder for it;
 * 4. lossy UTF-8 (the behaviour before this existed) when the codepage is
 *    unknown, UTF-8 itself, or has no decoder in this Node build.
 */
export async function decodeChildOutput(
  bytes: Buffer,
  codePageSource: () => Promise<number | null>,
): Promise<string> {
  if (!hasNonAscii(bytes)) return bytes.toString("utf8");
  const utf8 = strictUtf8(bytes);
  if (utf8 !== null) return utf8;
  let codePage: number | null;
  try {
    codePage = await codePageSource();
  } catch {
    return bytes.toString("utf8");
  }
  const label =
    codePage === null ? undefined : DECODER_LABEL_BY_CODEPAGE.get(codePage);
  if (label === undefined) return bytes.toString("utf8");
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    // A Node built without full ICU has no legacy decoders.
    return bytes.toString("utf8");
  }
}
