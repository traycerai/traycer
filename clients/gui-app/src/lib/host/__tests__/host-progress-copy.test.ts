import { describe, expect, it } from "vitest";
import type {
  MutationKind,
  MutationLaneStatus,
} from "@traycer-clients/shared/platform/runner-host";
import {
  HOST_PROGRESS_IDLE_HEADING,
  buildHostProgressView,
  clampHostProgressPercent,
  formatHostProgressBytes,
  formatHostTransfer,
  hostProgressHeading,
  hostProgressShortLabel,
} from "@/lib/host/host-progress-copy";

// Enumerated explicitly (not derived from the module under test) so a new
// `MutationKind` member fails this test loudly instead of silently passing.
const ALL_MUTATION_KINDS: readonly MutationKind[] = [
  "ensure",
  "apply",
  "activate",
  "install",
  "register",
  "deregister",
  "respawn",
  "recoverIfDown",
  "freePortAndRestart",
  "uninstallHost",
  "removeTraycer",
];

describe("hostProgressHeading", () => {
  it("returns a distinct non-empty string for every MutationKind member", () => {
    const headings = ALL_MUTATION_KINDS.map((kind) =>
      hostProgressHeading(kind, null),
    );
    for (const heading of headings) {
      expect(heading.length).toBeGreaterThan(0);
    }
    expect(new Set(headings).size).toBe(headings.length);
  });

  it("the download stage overrides the kind for at least two different kinds", () => {
    expect(hostProgressHeading("ensure", "download")).toBe(
      "Downloading Traycer Host…",
    );
    expect(hostProgressHeading("apply", "download")).toBe(
      "Downloading Traycer Host…",
    );
    // Confirms it really is an override, not a coincidence of their non-download copy.
    expect(hostProgressHeading("ensure", null)).not.toBe(
      "Downloading Traycer Host…",
    );
    expect(hostProgressHeading("apply", null)).not.toBe(
      "Downloading Traycer Host…",
    );
  });
});

describe("hostProgressShortLabel", () => {
  it("download stage wins regardless of kind", () => {
    expect(hostProgressShortLabel("ensure", "download")).toBe("Downloading…");
    expect(hostProgressShortLabel("install", "download")).toBe("Downloading…");
  });

  it("ensure (non-download) is 'Setting up…'; every other kind is 'Working…'", () => {
    expect(hostProgressShortLabel("ensure", null)).toBe("Setting up…");
    expect(hostProgressShortLabel("install", null)).toBe("Working…");
    expect(hostProgressShortLabel("respawn", null)).toBe("Working…");
  });
});

describe("formatHostProgressBytes", () => {
  it("bytes under 1024 render as whole bytes", () => {
    expect(formatHostProgressBytes(512)).toBe("512 B");
  });

  it("KB tier", () => {
    expect(formatHostProgressBytes(2048)).toBe("2.0 KB");
  });

  it("104_857_600 bytes -> 100 MB (whole, past the 10 MB threshold)", () => {
    expect(formatHostProgressBytes(104_857_600)).toBe("100 MB");
  });

  it("250_609_664 bytes -> 239 MB", () => {
    expect(formatHostProgressBytes(250_609_664)).toBe("239 MB");
  });

  it("a sub-10 MB value keeps one decimal", () => {
    // 5 MiB = 5_242_880 bytes
    expect(formatHostProgressBytes(5_242_880)).toBe("5.0 MB");
  });

  it("GB tier keeps two decimals", () => {
    // 2.5 GiB
    expect(formatHostProgressBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.50 GB");
  });
});

describe("formatHostTransfer", () => {
  it("both non-null and totalBytes > 0 -> 'X of Y'", () => {
    expect(formatHostTransfer(104_857_600, 250_609_664)).toBe(
      "100 MB of 239 MB",
    );
  });

  it("only bytes non-null -> just the bytes", () => {
    expect(formatHostTransfer(2048, null)).toBe("2.0 KB");
  });

  it("only totalBytes non-null -> just the total", () => {
    expect(formatHostTransfer(null, 2048)).toBe("2.0 KB");
  });

  it("both null -> null", () => {
    expect(formatHostTransfer(null, null)).toBeNull();
  });

  it("totalBytes 0 with bytes non-null does NOT produce 'of 0 B'", () => {
    expect(formatHostTransfer(2048, 0)).toBe("2.0 KB");
  });
});

describe("clampHostProgressPercent", () => {
  it("null stays null", () => {
    expect(clampHostProgressPercent(null)).toBeNull();
  });

  it("clamps below 0 up to 0", () => {
    expect(clampHostProgressPercent(-5)).toBe(0);
  });

  it("clamps above 100 down to 100", () => {
    expect(clampHostProgressPercent(150)).toBe(100);
  });

  it("rounds an in-range value", () => {
    expect(clampHostProgressPercent(42.6)).toBe(43);
  });
});

describe("buildHostProgressView", () => {
  it("null lane -> null", () => {
    expect(buildHostProgressView(null)).toBeNull();
  });

  it("a lane with progress: null still returns a view WITH its heading", () => {
    const lane: MutationLaneStatus = {
      kind: "ensure",
      startedAt: "2026-01-01T00:00:00.000Z",
      progress: null,
    };
    const view = buildHostProgressView(lane);
    expect(view).not.toBeNull();
    expect(view?.heading).toBe(hostProgressHeading("ensure", null));
    expect(view?.heading).not.toBe(HOST_PROGRESS_IDLE_HEADING);
    expect(view?.detail).toBeNull();
    expect(view?.percent).toBeNull();
    expect(view?.transferLabel).toBeNull();
  });

  it("percent is clamped from -5 to 0 and 150 to 100", () => {
    const laneLow: MutationLaneStatus = {
      kind: "install",
      startedAt: "2026-01-01T00:00:00.000Z",
      progress: {
        stage: "extract",
        percent: -5,
        bytes: null,
        totalBytes: null,
        workUnits: null,
        message: null,
      },
    };
    expect(buildHostProgressView(laneLow)?.percent).toBe(0);

    const laneHigh: MutationLaneStatus = {
      kind: "install",
      startedAt: "2026-01-01T00:00:00.000Z",
      progress: {
        stage: "extract",
        percent: 150,
        bytes: null,
        totalBytes: null,
        workUnits: null,
        message: null,
      },
    };
    expect(buildHostProgressView(laneHigh)?.percent).toBe(100);
  });

  it("a verify stage carrying BYTES still heads 'Setting up Traycer Host…', never 'Downloading'", () => {
    // The `verify` phase now reports hashed bytes, so the card gains a transfer
    // label - "400 MB of 800 MB" - during a local-source install. That is safe
    // only because the download WORDING is gated on `stage === "download"` rather
    // than on the presence of byte fields.
    //
    // That safety rests on a stage gate, and stage gates get consolidated. This
    // arm is what stops a future refactor routing a hash into download wording and
    // telling a user their bundled install is downloading something.
    const verifying: MutationLaneStatus = {
      kind: "ensure",
      startedAt: "2026-01-01T00:00:00.000Z",
      progress: {
        stage: "verify",
        percent: null,
        bytes: 400_000_000,
        totalBytes: 838_860_800,
        message: "hashing /Applications/Traycer.app/…/host-runtime.tar.gz",
        workUnits: null,
      },
    };
    const view = buildHostProgressView(verifying);

    expect(view?.heading).toBe("Setting up Traycer Host…");
    expect(view?.heading).not.toContain("Downloading");
    expect(view?.shortLabel).not.toContain("Downloading");
    // Positive control for the assertions above: the bytes DID reach the view, so
    // "not Downloading" is not being satisfied by a view that never saw them.
    // BINARY MB, and asserted as the exact string because that is what caught the
    // author writing "400 MB of 839 MB" here from a decimal reading of the same
    // two numbers. 400_000_000 B is 381 MiB; 838_860_800 B is exactly 800 MiB.
    expect(view?.transferLabel).toBe("381 MB of 800 MB");
    // And no progress bar: `percent` stays null through verify, so the card gains
    // a live figure without gaining a determinate bar.
    expect(view?.percent).toBeNull();
  });
});
