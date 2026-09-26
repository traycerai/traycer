import { describe, expect, it } from "vitest";
import {
  buildWindowsDeniedReadFallbackScript,
  compareObservedProcessStart,
  compareProcessStartIdentity,
  formatDarwinProcessStartIdentity,
  formatLinuxProcessStartIdentity,
  formatWindowsProcessStartIdentity,
  isProcessStartIdentity,
  parseWindowsDeniedReadFallbackOutput,
  parseWindowsWmiCreationDate,
  windowsProcessStartIdentityMicros,
  type ObservedProcessStart,
} from "../process-start-identity";

/*
 * These rows are the contract between two readers that cannot import each
 * other: `clients/shared/host-lock/process-identity.ts` (desktop + CLI) and
 * `traycer-host/src/lifecycle/process-start-identity.ts` (the publisher). If
 * the format drifts, a published token stops matching an observed one, so the
 * failure direction is "cannot attest" rather than a false match - but it
 * would silently retire recycled-pid detection everywhere, so the bytes are
 * pinned here.
 */
describe("token format", () => {
  it("pins the Linux token to boot id plus start ticks", () => {
    expect(formatLinuxProcessStartIdentity("boot-abc", 4242)).toBe(
      "linux:boot-abc 4242",
    );
  });

  it("pins the macOS token to the printed lstart text", () => {
    expect(formatDarwinProcessStartIdentity("Sun Jul 27 15:04:05 2026")).toBe(
      "darwin:Sun Jul 27 15:04:05 2026",
    );
  });

  it("pins the Windows token to the round-trip creation time", () => {
    expect(
      formatWindowsProcessStartIdentity("2026-07-27T15:04:05.1234567Z"),
    ).toBe("win32:2026-07-27T15:04:05.1234567Z");
  });

  /*
   * `ps` pads its columns, and the two readers trim differently by accident
   * of how each captures stdout. Normalising at format time means incidental
   * whitespace can never present as a different process.
   */
  it("normalises padding so column whitespace is not an identity change", () => {
    expect(
      formatDarwinProcessStartIdentity("  Sun Jul 27   15:04:05 2026\n"),
    ).toBe(formatDarwinProcessStartIdentity("Sun Jul 27 15:04:05 2026"));
  });

  it("refuses to build a token from an empty probe result", () => {
    expect(formatDarwinProcessStartIdentity("   \n")).toBeNull();
    expect(formatLinuxProcessStartIdentity("", 1)).toBeNull();
    expect(formatLinuxProcessStartIdentity("boot-abc", -1)).toBeNull();
    expect(formatLinuxProcessStartIdentity("boot-abc", 1.5)).toBeNull();
  });
});

describe("isProcessStartIdentity", () => {
  it("accepts tokens this module produced", () => {
    expect(isProcessStartIdentity("linux:boot-abc 4242")).toBe(true);
    expect(isProcessStartIdentity("darwin:Sun Jul 27 15:04:05 2026")).toBe(
      true,
    );
    expect(isProcessStartIdentity("win32:2026-07-27T15:04:05.1234567Z")).toBe(
      true,
    );
  });

  it("rejects anything else, so bad bytes stop at the decode boundary", () => {
    expect(isProcessStartIdentity(null)).toBe(false);
    expect(isProcessStartIdentity(4242)).toBe(false);
    expect(isProcessStartIdentity("")).toBe(false);
    expect(isProcessStartIdentity("no-separator")).toBe(false);
    expect(isProcessStartIdentity(":leading-separator")).toBe(false);
    expect(isProcessStartIdentity("linux:")).toBe(false);
    expect(isProcessStartIdentity("linux:   ")).toBe(false);
    expect(isProcessStartIdentity("solaris:1234")).toBe(false);
  });
});

describe("compareProcessStartIdentity", () => {
  it("is same for tokens with the same canonical payload", () => {
    expect(
      compareProcessStartIdentity("linux:boot-a 1", "linux:boot-a 1"),
    ).toBe("same");
  });

  /*
   * Validation and comparison have to agree on what "the same token" means.
   * `isProcessStartIdentity` accepts any payload that WOULD normalize to
   * something non-empty, so a writer storing raw probe output rather than
   * going through `formatToken` yields a token that is valid but not
   * canonical. Comparing raw bytes then answered `different` - the one
   * verdict that authorises treating a live pid as an impostor - for two
   * readings of one process.
   *
   * This is #740's failure mode arriving through formatting instead of
   * through the clock, so it is pinned at the comparator: the module
   * documents two independent writers on opposite sides of the OSS/internal
   * boundary, and correctness cannot depend on both remembering to normalize.
   */
  it("is same across non-canonical padding, not different", () => {
    // `ps -o lstart=` pads single-digit days to a fixed column width.
    expect(
      compareProcessStartIdentity(
        "darwin:Sun Jul  6 12:00:00 2026",
        "darwin:Sun Jul 6 12:00:00 2026",
      ),
    ).toBe("same");
    // Leading/trailing whitespace from a trimmed-vs-untrimmed read.
    expect(
      compareProcessStartIdentity("linux:boot-a 1", "linux:  boot-a   1  "),
    ).toBe("same");
    // Canonicalising must not erase a real disagreement.
    expect(
      compareProcessStartIdentity(
        "darwin:Sun Jul  6 12:00:00 2026",
        "darwin:Sun Jul 7 12:00:00 2026",
      ),
    ).toBe("different");
  });

  it("is different for a same-platform token that positively disagrees", () => {
    expect(
      compareProcessStartIdentity("linux:boot-a 1", "linux:boot-a 2"),
    ).toBe("different");
    // Same tick offset, different boot: a pid reused across a reboot is the
    // case the boot id exists to catch.
    expect(
      compareProcessStartIdentity("linux:boot-a 1", "linux:boot-b 1"),
    ).toBe("different");
  });

  /*
   * Everything below must be `unknown`, never `different`. `different` is the
   * only answer that lets a caller treat a live process as an impostor, and
   * the callers act on it by refusing to defer to a host or by allowing it to
   * be restarted. An absent, malformed, or cross-platform operand is a reason
   * to know less - turning it into positive evidence is exactly the class of
   * bug that produced traycerai/traycer#740.
   */
  it("is unknown when either operand is missing", () => {
    expect(compareProcessStartIdentity(null, "linux:boot-a 1")).toBe("unknown");
    expect(compareProcessStartIdentity("linux:boot-a 1", null)).toBe("unknown");
    expect(compareProcessStartIdentity(null, null)).toBe("unknown");
  });

  it("is unknown when either operand is malformed", () => {
    expect(compareProcessStartIdentity("garbage", "linux:boot-a 1")).toBe(
      "unknown",
    );
    expect(compareProcessStartIdentity("linux:boot-a 1", "linux:")).toBe(
      "unknown",
    );
  });

  it("is unknown across platforms rather than different", () => {
    expect(
      compareProcessStartIdentity("linux:boot-a 1", "darwin:Sun Jul 27 2026"),
    ).toBe("unknown");
  });
});

// ---- Windows: the denied-read fallback ------------------------------------
//
// The instant under test throughout: 2026-01-02T03:04:05.123456 UTC (six
// fractional digits - what WMI's `CreationDate` carries).
const INSTANT_FIELDS_MS = Date.UTC(2026, 0, 2, 3, 4, 5);
const INSTANT_MICROS = INSTANT_FIELDS_MS * 1000 + 123_456;

describe("parseWindowsWmiCreationDate", () => {
  it("reads the same instant identically whatever offset WMI chose to print", () => {
    // UTC = fields - offset (offset in minutes). All three name the SAME
    // instant: local fields shifted by the stated offset from UTC.
    expect(parseWindowsWmiCreationDate("20260102030405.123456+000")).toBe(
      INSTANT_MICROS,
    );
    // -420 minutes (-7h): local fields are 7h BEHIND UTC.
    expect(parseWindowsWmiCreationDate("20260101200405.123456-420")).toBe(
      INSTANT_MICROS,
    );
    // +330 minutes (+5h30m): local fields are 5h30m AHEAD of UTC.
    expect(parseWindowsWmiCreationDate("20260102083405.123456+330")).toBe(
      INSTANT_MICROS,
    );
  });

  it("is null for anything that is not a well-formed DMTF datetime", () => {
    expect(parseWindowsWmiCreationDate("not-a-date")).toBeNull();
    expect(parseWindowsWmiCreationDate("")).toBeNull();
    expect(parseWindowsWmiCreationDate("20260102030405.123456")).toBeNull();
    expect(parseWindowsWmiCreationDate("20260102030405+000")).toBeNull();
  });

  it("is null for a date that does not name a real instant, rather than rolling it over", () => {
    // Month 13.
    expect(parseWindowsWmiCreationDate("20261302030405.123456+000")).toBeNull();
    // February 30th.
    expect(parseWindowsWmiCreationDate("20260230030405.123456+000")).toBeNull();
  });
});

describe("parseWindowsDeniedReadFallbackOutput", () => {
  it("reads the creation time out of a 'denied <DMTF>' line", () => {
    expect(
      parseWindowsDeniedReadFallbackOutput("denied 20260102030405.123456+000"),
    ).toBe(INSTANT_MICROS);
  });

  it("tolerates the surrounding whitespace and CRLF a real spawn's stdout carries", () => {
    expect(
      parseWindowsDeniedReadFallbackOutput(
        "  \r\ndenied 20260102030405.123456+000\r\n  ",
      ),
    ).toBe(INSTANT_MICROS);
  });

  it("is null for 'readable', empty output, or a denied line with a malformed DMTF tail", () => {
    expect(parseWindowsDeniedReadFallbackOutput("readable")).toBeNull();
    expect(parseWindowsDeniedReadFallbackOutput("")).toBeNull();
    expect(parseWindowsDeniedReadFallbackOutput("denied garbage")).toBeNull();
  });
});

describe("windowsProcessStartIdentityMicros", () => {
  it("truncates the token's 7th fractional digit rather than rounding it", () => {
    const token = formatWindowsProcessStartIdentity(
      "2026-01-02T03:04:05.1234567Z",
    );
    expect(windowsProcessStartIdentityMicros(token)).toBe(INSTANT_MICROS);
  });

  it("is null for a non-Windows token, a null token, or a malformed Windows payload", () => {
    expect(windowsProcessStartIdentityMicros(null)).toBeNull();
    expect(windowsProcessStartIdentityMicros("linux:boot-a 1")).toBeNull();
    expect(
      windowsProcessStartIdentityMicros("darwin:Sun Jul 27 15:04:05 2026"),
    ).toBeNull();
    // Only three fractional digits - not the seven a round-trip ("o") string
    // always carries.
    expect(
      windowsProcessStartIdentityMicros(
        formatWindowsProcessStartIdentity("2026-01-02T03:04:05.123Z"),
      ),
    ).toBeNull();
  });
});

describe("compareObservedProcessStart", () => {
  it("compares an identity observation exactly as compareProcessStartIdentity does", () => {
    const observation = (identity: string): ObservedProcessStart => ({
      kind: "identity",
      identity,
    });
    expect(
      compareObservedProcessStart(
        "linux:boot-a 1",
        observation("linux:boot-a 1"),
      ),
    ).toBe("same");
    expect(
      compareObservedProcessStart(
        "linux:boot-a 1",
        observation("linux:boot-a 2"),
      ),
    ).toBe("different");
    expect(
      compareObservedProcessStart(
        "linux:boot-a 1",
        observation("darwin:Sun Jul 27 15:04:05 2026"),
      ),
    ).toBe("unknown");
  });

  it("decides a denied-read observation at the microsecond, within the published tolerance", () => {
    const recorded = formatWindowsProcessStartIdentity(
      "2026-01-02T03:04:05.1234567Z",
    );
    expect(
      compareObservedProcessStart(recorded, {
        kind: "windows-denied-read",
        creationMicros: INSTANT_MICROS + 1,
      }),
    ).toBe("same");
    expect(
      compareObservedProcessStart(recorded, {
        kind: "windows-denied-read",
        creationMicros: INSTANT_MICROS + 2,
      }),
    ).toBe("different");
  });

  it("is unknown whenever either side is missing - never a soft different", () => {
    expect(
      compareObservedProcessStart(null, {
        kind: "identity",
        identity: "linux:boot-a 1",
      }),
    ).toBe("unknown");
    expect(compareObservedProcessStart("linux:boot-a 1", null)).toBe("unknown");
    expect(
      compareObservedProcessStart(null, {
        kind: "windows-denied-read",
        creationMicros: INSTANT_MICROS,
      }),
    ).toBe("unknown");
  });
});

describe("buildWindowsDeniedReadFallbackScript", () => {
  it("pins the script's shape for a given pid", () => {
    const script = buildWindowsDeniedReadFallbackScript(1234);
    expect(script).toContain("get_StartTime()");
    expect(script).toContain("NativeErrorCode -ne 5");
    expect(script).toContain(
      "Get-WmiObject Win32_Process -Filter 'ProcessId = 1234'",
    );
    expect(script).toContain("'denied '");
    expect(script).toContain("exit 3");
  });

  it("refuses a non-integer or non-positive pid rather than embedding it in the script", () => {
    expect(() => buildWindowsDeniedReadFallbackScript(1.5)).toThrow(RangeError);
    expect(() => buildWindowsDeniedReadFallbackScript(-1)).toThrow(RangeError);
    expect(() => buildWindowsDeniedReadFallbackScript(0)).toThrow(RangeError);
    expect(() => buildWindowsDeniedReadFallbackScript(Number.NaN)).toThrow(
      RangeError,
    );
  });
});
