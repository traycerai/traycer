import { describe, expect, it } from "vitest";
import {
  compareProcessStartIdentity,
  formatDarwinProcessStartIdentity,
  formatLinuxProcessStartIdentity,
  formatWindowsProcessStartIdentity,
  isProcessStartIdentity,
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
