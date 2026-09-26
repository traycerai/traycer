import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostBusyBreakdownV2 } from "@traycer/protocol/host/status/index";

vi.mock("@/lib/keybindings/platform", () => ({
  isMac: vi.fn(() => false),
  isWindows: vi.fn(() => false),
}));

/** A zero-valued breakdown, overridden per test so every field is explicit. */
function breakdown(
  overrides: Partial<HostBusyBreakdownV2>,
): HostBusyBreakdownV2 {
  return {
    workingAgents: 0,
    activeTerminalAgents: 0,
    busyTerminals: 0,
    shells: 0,
    scheduledWakes: 0,
    ...overrides,
  };
}

describe("hostMachineNoun", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("returns Mac when isMac() is true", async () => {
    const platform = await import("@/lib/keybindings/platform");
    vi.mocked(platform.isMac).mockReturnValue(true);
    vi.mocked(platform.isWindows).mockReturnValue(false);
    const { hostMachineNoun } = await import("@/lib/host/host-lifecycle-copy");

    expect(hostMachineNoun()).toBe("Mac");
  });

  it("returns PC when isWindows() is true", async () => {
    const platform = await import("@/lib/keybindings/platform");
    vi.mocked(platform.isMac).mockReturnValue(false);
    vi.mocked(platform.isWindows).mockReturnValue(true);
    const { hostMachineNoun } = await import("@/lib/host/host-lifecycle-copy");

    expect(hostMachineNoun()).toBe("PC");
  });

  it("returns machine on Linux (neither Mac nor Windows)", async () => {
    const platform = await import("@/lib/keybindings/platform");
    vi.mocked(platform.isMac).mockReturnValue(false);
    vi.mocked(platform.isWindows).mockReturnValue(false);
    const { hostMachineNoun } = await import("@/lib/host/host-lifecycle-copy");

    expect(hostMachineNoun()).toBe("machine");
  });
});

describe("HOST_LIFECYCLE_MODE_ORDER", () => {
  it("lists the five modes in the card's order", async () => {
    const { HOST_LIFECYCLE_MODE_ORDER } =
      await import("@/lib/host/host-lifecycle-copy");

    expect(HOST_LIFECYCLE_MODE_ORDER).toEqual([
      "background",
      "ask",
      "stop-if-idle",
      "linked",
      "none",
    ]);
  });
});

describe("hostLifecycleModeName", () => {
  it("names every mode", async () => {
    const { hostLifecycleModeName } =
      await import("@/lib/host/host-lifecycle-copy");

    expect(hostLifecycleModeName("background")).toBe("Background");
    expect(hostLifecycleModeName("ask")).toBe("Ask");
    expect(hostLifecycleModeName("stop-if-idle")).toBe("Stop if idle");
    expect(hostLifecycleModeName("linked")).toBe("Linked");
    expect(hostLifecycleModeName("none")).toBe("No local host");
  });
});

describe("hostLifecycleOptionCopy", () => {
  it("returns five entries with the right mode/label and machine noun in description", async () => {
    const { hostLifecycleOptionCopy } =
      await import("@/lib/host/host-lifecycle-copy");

    const entries = hostLifecycleOptionCopy("Mac");
    expect(entries).toHaveLength(5);
    expect(entries.map((entry) => entry.mode)).toEqual([
      "background",
      "ask",
      "stop-if-idle",
      "linked",
      "none",
    ]);

    const background = entries.find((entry) => entry.mode === "background");
    expect(background?.label).toBe("Keep the host running in the background");
    expect(background?.description).toContain("Mac");

    const ask = entries.find((entry) => entry.mode === "ask");
    expect(ask?.label).toBe("Ask me each time");
    expect(ask?.description).not.toContain("Mac");

    const stopIfIdle = entries.find((entry) => entry.mode === "stop-if-idle");
    expect(stopIfIdle?.label).toBe(
      "Stop the host if nothing is running, otherwise ask",
    );

    const linked = entries.find((entry) => entry.mode === "linked");
    expect(linked?.label).toBe("Stop the host with the app");

    const none = entries.find((entry) => entry.mode === "none");
    expect(none?.label).toBe("Don't run a host on this Mac");
    expect(none?.description).toContain(
      "Traycer connects only to remote hosts",
    );
  });

  it("threads a different machine noun through the background and none descriptions", async () => {
    const { hostLifecycleOptionCopy } =
      await import("@/lib/host/host-lifecycle-copy");

    const entries = hostLifecycleOptionCopy("PC");
    const background = entries.find((entry) => entry.mode === "background");
    expect(background?.description).toContain("PC");
    const none = entries.find((entry) => entry.mode === "none");
    expect(none?.label).toBe("Don't run a host on this PC");
  });
});

describe("hostLifecycleModePromise", () => {
  it("gives each mode's promise, and null for none", async () => {
    const { hostLifecycleModePromise } =
      await import("@/lib/host/host-lifecycle-copy");

    expect(hostLifecycleModePromise("background")).toBe(
      "keeps running after quit",
    );
    expect(hostLifecycleModePromise("linked")).toBe("stops with app");
    expect(hostLifecycleModePromise("ask")).toBe("asks when you quit");
    expect(hostLifecycleModePromise("stop-if-idle")).toBe(
      "stops at quit if idle",
    );
    expect(hostLifecycleModePromise("none")).toBeNull();
  });
});

describe("hostQuitStoppingLine", () => {
  it("says just 'Stopping host…' for a null breakdown", async () => {
    const { hostQuitStoppingLine } =
      await import("@/lib/host/host-lifecycle-copy");

    expect(hostQuitStoppingLine(null)).toBe("Stopping host…");
  });

  it("names the work phrase for a breakdown that yields one", async () => {
    const { hostQuitStoppingLine } =
      await import("@/lib/host/host-lifecycle-copy");

    expect(hostQuitStoppingLine(breakdown({ workingAgents: 2 }))).toBe(
      "Stopping host… ending 2 agents",
    );
  });

  it("falls back to the bare line for a breakdown with no nameable work", async () => {
    const { hostQuitStoppingLine } =
      await import("@/lib/host/host-lifecycle-copy");

    // shells/scheduledWakes never feed `busyWorkPhrase` - only
    // workingAgents/activeTerminalAgents/busyTerminals do.
    expect(
      hostQuitStoppingLine(breakdown({ shells: 3, scheduledWakes: 1 })),
    ).toBe("Stopping host…");
  });
});

describe("hostQuitCountsLine", () => {
  describe("busy leads", () => {
    it("names the work phrase, capitalized, when the breakdown yields one", async () => {
      const { hostQuitCountsLine } =
        await import("@/lib/host/host-lifecycle-copy");

      expect(
        hostQuitCountsLine({
          busy: true,
          busySessionCount: 5,
          breakdown: breakdown({ workingAgents: 2, busyTerminals: 1 }),
          statusMinor: 6,
        }),
      ).toBe("2 agents and 1 terminal working.");
    });

    // A null breakdown always falls into extrasSentence's "both unreported"
    // branch, so these three isolate the lead by passing an all-zero
    // (non-null) breakdown with a reporting statusMinor - the one shape
    // whose extras sentence is genuinely absent.
    it("uses the singular session count", async () => {
      const { hostQuitCountsLine } =
        await import("@/lib/host/host-lifecycle-copy");

      expect(
        hostQuitCountsLine({
          busy: true,
          busySessionCount: 1,
          breakdown: breakdown({}),
          statusMinor: 6,
        }),
      ).toBe("1 session working.");
    });

    it("uses the plural session count", async () => {
      const { hostQuitCountsLine } =
        await import("@/lib/host/host-lifecycle-copy");

      expect(
        hostQuitCountsLine({
          busy: true,
          busySessionCount: 3,
          breakdown: breakdown({}),
          statusMinor: 6,
        }),
      ).toBe("3 sessions working.");
    });

    it("falls back to the generic busy sentence when the session count is null", async () => {
      const { hostQuitCountsLine } =
        await import("@/lib/host/host-lifecycle-copy");

      expect(
        hostQuitCountsLine({
          busy: true,
          busySessionCount: null,
          breakdown: breakdown({}),
          statusMinor: 6,
        }),
      ).toBe("The host reports it is busy.");
    });

    it("falls back to the generic busy sentence when breakdown is all-zero and count is 0", async () => {
      const { hostQuitCountsLine } =
        await import("@/lib/host/host-lifecycle-copy");

      expect(
        hostQuitCountsLine({
          busy: true,
          busySessionCount: 0,
          breakdown: breakdown({}),
          statusMinor: null,
        }),
      ).toBe("The host reports it is busy.");
    });

    it("appends the unreported-extras sentence when busy and the breakdown is genuinely null", async () => {
      const { hostQuitCountsLine } =
        await import("@/lib/host/host-lifecycle-copy");

      // A null breakdown means shells/wakes are unreported too, so the
      // extras sentence is never silently dropped even though the lead
      // itself is the plain session-count sentence.
      expect(
        hostQuitCountsLine({
          busy: true,
          busySessionCount: 1,
          breakdown: null,
          statusMinor: null,
        }),
      ).toBe(
        "1 session working. Shells and scheduled wakes: unknown on this host version.",
      );
    });
  });

  describe("idle leads", () => {
    it("says nothing is running (no extras) when the breakdown is all-zero and known", async () => {
      const { hostQuitCountsLine } =
        await import("@/lib/host/host-lifecycle-copy");

      expect(
        hostQuitCountsLine({
          busy: false,
          busySessionCount: 0,
          breakdown: breakdown({}),
          statusMinor: 6,
        }),
      ).toBe("Nothing is running on this host right now.");
    });

    it("appends the unreported-extras sentence when the breakdown is genuinely null", async () => {
      const { hostQuitCountsLine } =
        await import("@/lib/host/host-lifecycle-copy");

      expect(
        hostQuitCountsLine({
          busy: false,
          busySessionCount: 0,
          breakdown: null,
          statusMinor: null,
        }),
      ).toBe(
        "Nothing is running on this host right now. Shells and scheduled wakes: unknown on this host version.",
      );
    });

    it("names shells/wakes instead of claiming nothing is running when either is positive", async () => {
      const { hostQuitCountsLine } =
        await import("@/lib/host/host-lifecycle-copy");

      expect(
        hostQuitCountsLine({
          busy: false,
          busySessionCount: 0,
          breakdown: breakdown({ shells: 1 }),
          statusMinor: 6,
        }),
      ).toBe(
        "No agents or terminals are working on this host right now. Also on this host: 1 shell.",
      );
      expect(
        hostQuitCountsLine({
          busy: false,
          busySessionCount: 0,
          breakdown: breakdown({ scheduledWakes: 2 }),
          statusMinor: 6,
        }),
      ).toBe(
        "No agents or terminals are working on this host right now. Also on this host: 2 scheduled wakes.",
      );
    });
  });

  describe("extras sentence - unreported (both null)", () => {
    it("says unknown-on-this-host-version when statusMinor is null", async () => {
      const { hostQuitCountsLine } =
        await import("@/lib/host/host-lifecycle-copy");

      expect(
        hostQuitCountsLine({
          busy: false,
          busySessionCount: 0,
          breakdown: breakdown({ shells: null, scheduledWakes: null }),
          statusMinor: null,
        }),
      ).toBe(
        "Nothing is running on this host right now. Shells and scheduled wakes: unknown on this host version.",
      );
    });

    it("says unknown-on-this-host-version when statusMinor is below 6", async () => {
      const { hostQuitCountsLine } =
        await import("@/lib/host/host-lifecycle-copy");

      expect(
        hostQuitCountsLine({
          busy: false,
          busySessionCount: 0,
          breakdown: breakdown({ shells: null, scheduledWakes: null }),
          statusMinor: 5,
        }),
      ).toBe(
        "Nothing is running on this host right now. Shells and scheduled wakes: unknown on this host version.",
      );
    });

    it("says not-reported when statusMinor is 6 or above", async () => {
      const { hostQuitCountsLine } =
        await import("@/lib/host/host-lifecycle-copy");

      expect(
        hostQuitCountsLine({
          busy: false,
          busySessionCount: 0,
          breakdown: breakdown({ shells: null, scheduledWakes: null }),
          statusMinor: 6,
        }),
      ).toBe(
        "Nothing is running on this host right now. Shells and scheduled wakes: not reported by this host.",
      );
    });
  });

  describe("extras sentence - known counts", () => {
    it("joins two positive counts with the right singular/plural forms", async () => {
      const { hostQuitCountsLine } =
        await import("@/lib/host/host-lifecycle-copy");

      expect(
        hostQuitCountsLine({
          busy: false,
          busySessionCount: 0,
          breakdown: breakdown({ shells: 2, scheduledWakes: 1 }),
          statusMinor: 6,
        }),
      ).toBe(
        "No agents or terminals are working on this host right now. Also on this host: 2 shells, 1 scheduled wake.",
      );
    });

    it("omits the extras sentence entirely when both known counts are zero", async () => {
      const { hostQuitCountsLine } =
        await import("@/lib/host/host-lifecycle-copy");

      expect(
        hostQuitCountsLine({
          busy: false,
          busySessionCount: 0,
          breakdown: breakdown({ shells: 0, scheduledWakes: 0 }),
          statusMinor: 6,
        }),
      ).toBe("Nothing is running on this host right now.");
      expect(
        hostQuitCountsLine({
          busy: true,
          busySessionCount: 2,
          breakdown: breakdown({ shells: 0, scheduledWakes: 0 }),
          statusMinor: 6,
        }),
      ).toBe("2 sessions working.");
    });
  });

  describe("extras sentence - one known, one unreported", () => {
    it("combines the known-count sentence with a not-reported sentence for the unknown one, source order", async () => {
      const { hostQuitCountsLine } =
        await import("@/lib/host/host-lifecycle-copy");

      // shells unreported, wakes known and positive: the known sentence
      // comes first, then "Shells: not reported...".
      expect(
        hostQuitCountsLine({
          busy: false,
          busySessionCount: 0,
          breakdown: breakdown({ shells: null, scheduledWakes: 2 }),
          statusMinor: 6,
        }),
      ).toBe(
        "No agents or terminals are working on this host right now. Also on this host: 2 scheduled wakes. Shells: not reported by this host.",
      );

      // wakes unreported, shells known and positive: the known sentence
      // still comes first, then "Scheduled wakes: not reported...".
      expect(
        hostQuitCountsLine({
          busy: false,
          busySessionCount: 0,
          breakdown: breakdown({ shells: 3, scheduledWakes: null }),
          statusMinor: 6,
        }),
      ).toBe(
        "No agents or terminals are working on this host right now. Also on this host: 3 shells. Scheduled wakes: not reported by this host.",
      );
    });

    it("drops the known-count sentence when the known side is zero, keeping only the not-reported half", async () => {
      const { hostQuitCountsLine } =
        await import("@/lib/host/host-lifecycle-copy");

      expect(
        hostQuitCountsLine({
          busy: false,
          busySessionCount: 0,
          breakdown: breakdown({ shells: null, scheduledWakes: 0 }),
          statusMinor: 6,
        }),
      ).toBe(
        "Nothing is running on this host right now. Shells: not reported by this host.",
      );
    });
  });

  it("space-joins the busy/idle lead with the extras sentence in one string", async () => {
    const { hostQuitCountsLine } =
      await import("@/lib/host/host-lifecycle-copy");

    const line = hostQuitCountsLine({
      busy: false,
      busySessionCount: 0,
      breakdown: breakdown({ shells: 1, scheduledWakes: 1 }),
      statusMinor: 6,
    });
    expect(line).toBe(
      "No agents or terminals are working on this host right now. Also on this host: 1 shell, 1 scheduled wake.",
    );
    expect(line.includes("  ")).toBe(false);
  });
});
