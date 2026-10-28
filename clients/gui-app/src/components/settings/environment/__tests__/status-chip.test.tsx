import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { EnvironmentStatusResponseV11 } from "@traycer/protocol/host/environment-schemas";
import { ConfigurationStatusChip } from "@/components/settings/environment/status-chip";
import type { ConfigurationChipHost } from "@/components/settings/environment/status-chip-model";
import { hostConfigurationChip } from "@/components/settings/environment/status-chip-hosts";
import { poolConfigurationChip } from "@/components/settings/environment/status-chip-pool-hosts";
import type { DetailsRecovery } from "@/lib/settings-details-entry";
import {
  environmentStatusFixture,
  itemStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";

// Dates read against now: this year drops the year, today drops the date.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 25, 12, 0));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const REPORTED_AT = Date.UTC(2026, 9, 20, 9, 30);
const STEP_AT = Date.UTC(2026, 9, 20, 9, 5);

function formatted(at: number): string {
  const day = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
  }).format(at);
  const clock = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
  return `${day} ${clock}`;
}

interface PoolReport {
  readonly hostId: string;
  readonly hostLabel: string | null;
  readonly lastReportedAt: number | null;
  readonly applied: readonly {
    readonly itemKey: string;
    readonly state: "received" | "applied" | "not_applied" | "waiting_resume";
    readonly reason: string | null;
    readonly at: number;
  }[];
}

function reportWith(label: string, applied: PoolReport["applied"]): PoolReport {
  return {
    hostId: `host-${label}`,
    hostLabel: label,
    lastReportedAt: REPORTED_AT,
    applied,
  };
}

function poolReport(label: string): PoolReport {
  return reportWith(label, []);
}

function appliedItem(itemKey: string): PoolReport["applied"][number] {
  return { itemKey, state: "applied", reason: null, at: STEP_AT };
}

function poolOf(
  reports: readonly PoolReport[],
  kinds: ReadonlySet<string> | null,
): ConfigurationChipHost[] {
  return reports.map((report) => poolConfigurationChip(report, kinds, null));
}

function pool(reports: readonly PoolReport[]): ConfigurationChipHost[] {
  return poolOf(reports, null);
}

interface Rendered {
  readonly onRecover: Mock<(r: DetailsRecovery) => void>;
  readonly onDetails: Mock<() => void>;
}

function renderChip(hosts: readonly ConfigurationChipHost[]): Rendered {
  return renderChipWith(hosts, { savingOffline: false, local: false });
}

function renderChipWith(
  hosts: readonly ConfigurationChipHost[],
  options: { savingOffline: boolean; local: boolean },
): Rendered {
  const onRecover = vi.fn<(r: DetailsRecovery) => void>();
  const onDetails = vi.fn<() => void>();
  render(
    <ConfigurationStatusChip
      hosts={hosts}
      emptyText="Nothing runs this yet"
      savingOffline={options.savingOffline}
      local={options.local}
      onDetails={onDetails}
      onRecover={onRecover}
      recoveryPending={false}
    />,
  );
  return { onRecover, onDetails };
}

function chipText(): string {
  return screen.getByRole("button").textContent;
}

describe("the six chip texts", () => {
  it("reads applied, naming the hosts by the naming rule", () => {
    const cases: readonly [readonly string[], string][] = [
      [["dev-box"], "✓ On dev-box"],
      [["dev-box", "laptop"], "✓ On dev-box and laptop"],
      [["dev-box", "laptop", "ci"], "✓ On dev-box, laptop and 1 more"],
      [["dev-box", "laptop", "ci", "nas"], "✓ On 4 hosts"],
      [["a", "b", "c", "d", "e"], "✓ On 5 hosts"],
    ];
    for (const [names, text] of cases) {
      renderChip(pool(names.map((name) => poolReport(name))));
      expect(chipText()).toBe(text);
      cleanup();
    }
  });

  it("reads Applying while a host has only received an item", () => {
    renderChip(
      pool([
        reportWith("dev-box", [
          { itemKey: "variable:FOO", state: "received", reason: null, at: 1 },
        ]),
      ]),
    );
    expect(chipText()).toBe("Applying on dev-box…");
  });

  it("reads Applying for a host whose items wait for it to resume", () => {
    renderChip(
      pool([
        reportWith("sandbox-1", [
          {
            itemKey: "variable:FOO",
            state: "waiting_resume",
            reason: null,
            at: 1,
          },
        ]),
      ]),
    );
    expect(chipText()).toBe("Applying on sandbox-1…");
  });

  it("counts the items a host did not apply", () => {
    renderChip(
      pool([
        reportWith("dev-box", [
          {
            itemKey: "variable:A",
            state: "not_applied",
            reason: "apply_failed",
            at: 1,
          },
          {
            itemKey: "variable:B",
            state: "not_applied",
            reason: "apply_failed",
            at: 1,
          },
          appliedItem("variable:C"),
        ]),
      ]),
    );
    expect(chipText()).toBe("2 not applied on dev-box");
  });

  it("reads the caller's empty text for a configuration with no host", () => {
    renderChip([]);
    expect(chipText()).toBe("Nothing runs this yet");
  });

  it("asks to update a host that negotiates below 1.1 and opens that host's Overview", async () => {
    const hosts = [
      poolConfigurationChip(poolReport("dev-box"), null, {
        major: 1,
        minor: 0,
      }),
    ];
    const { onRecover } = renderChip(hosts);

    expect(chipText()).toBe("Update dev-box to use your settings");
    await userEvent.click(screen.getByRole("button"));

    expect(onRecover).toHaveBeenCalledExactlyOnceWith({
      kind: "overview",
      hostId: "host-dev-box",
    });
    expect(screen.queryByText(/Last reported/)).toBeNull();
  });

  it("treats a host that does not serve the status method as needing an update", () => {
    renderChip([poolConfigurationChip(poolReport("dev-box"), null, false)]);
    expect(chipText()).toBe("Update dev-box to use your settings");
  });

  it("says Saving when back online ahead of every host state", () => {
    renderChipWith(
      [poolConfigurationChip(poolReport("dev-box"), null, false)],
      { savingOffline: true, local: false },
    );
    expect(chipText()).toBe("Saving when back online");
  });

  it("draws no chip for a Local row", () => {
    renderChipWith(pool([poolReport("dev-box")]), {
      savingOffline: false,
      local: true,
    });
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("the detail rows of a pool source", () => {
  const kindsPage = new Set(["variable", "mcp_server", "env_override"]);

  function openProblems(): Rendered {
    return renderChip(
      poolOf(
        [
          reportWith("dev-box", [
            {
              itemKey: "variable:MISSING_CLI",
              state: "not_applied",
              reason: "not_installed",
              at: STEP_AT,
            },
            {
              itemKey: "variable:READONLY",
              state: "not_applied",
              reason: "permission_denied",
              at: STEP_AT,
            },
            {
              itemKey: "variable:OTHER",
              state: "not_applied",
              reason: "apply_failed",
              at: STEP_AT,
            },
            {
              itemKey: "variable:PAUSED",
              state: "waiting_resume",
              reason: null,
              at: STEP_AT,
            },
            appliedItem("variable:FINE"),
          ]),
        ],
        kindsPage,
      ),
    );
  }

  it("lists one row per host, however many of its items failed", async () => {
    const { onRecover } = renderChip(
      poolOf(
        [
          reportWith("dev-box", [
            {
              itemKey: "variable:MISSING_CLI",
              state: "not_applied",
              reason: "not_installed",
              at: STEP_AT,
            },
            {
              itemKey: "variable:OTHER",
              state: "not_applied",
              reason: "apply_failed",
              at: STEP_AT,
            },
            appliedItem("variable:FINE"),
          ]),
          reportWith("ops-box", [
            {
              itemKey: "variable:READONLY",
              state: "not_applied",
              reason: "permission_denied",
              at: STEP_AT,
            },
          ]),
          reportWith("sandbox-1", [
            {
              itemKey: "variable:PAUSED",
              state: "waiting_resume",
              reason: null,
              at: STEP_AT,
            },
          ]),
        ],
        kindsPage,
      ),
    );
    await userEvent.click(screen.getByRole("button"));

    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("dev-box"),
      expect.stringContaining("ops-box"),
      expect.stringContaining("sandbox-1"),
    ]);
    for (const row of rows) {
      expect(row.textContent).toContain(
        `Last reported ${formatted(REPORTED_AT)}`,
      );
    }
    expect(screen.queryByText(/MISSING_CLI|OTHER|FINE/)).toBeNull();
    // A paused host states that it applies on resume, with no action; a
    // failed setting's reason has no Retry, since Retry reruns the setup script.
    expect(rows[2]?.textContent).toContain("applies when it resumes");
    expect(within(rows[2]).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Install on dev-box" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Open ops-box" }));
    expect(onRecover.mock.calls.map(([recovery]) => recovery)).toEqual([
      { kind: "install", hostId: "host-dev-box" },
      { kind: "repair", hostId: "host-ops-box" },
    ]);
  });

  it("offers Retry on a failed setup script", async () => {
    const { onRecover } = renderChip(
      poolOf(
        [
          reportWith("dev-box", [
            {
              itemKey: "setup_script:macos",
              state: "not_applied",
              reason: "apply_failed",
              at: STEP_AT,
            },
          ]),
        ],
        new Set(["setup_script"]),
      ),
    );
    await userEvent.click(screen.getByRole("button"));

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRecover.mock.calls.map(([recovery]) => recovery)).toEqual([
      { kind: "retry", hostId: "host-dev-box" },
    ]);
  });

  it("filters a page's chip to its own kinds and drops keys with no kind", () => {
    renderChip(
      poolOf(
        [
          reportWith("dev-box", [
            {
              itemKey: "shell:zsh",
              state: "not_applied",
              reason: "apply_failed",
              at: STEP_AT,
            },
            {
              itemKey: "nocolon",
              state: "not_applied",
              reason: "apply_failed",
              at: STEP_AT,
            },
            {
              itemKey: ":empty-kind",
              state: "not_applied",
              reason: "apply_failed",
              at: STEP_AT,
            },
            appliedItem("variable:FOO"),
          ]),
        ],
        kindsPage,
      ),
    );
    expect(chipText()).toBe("✓ On dev-box");
  });

  it("does not count a configuration's sandbox defaults a host has not applied", () => {
    renderChip(
      pool([
        reportWith("dev-box", [
          appliedItem("variable:FOO"),
          {
            itemKey: "sandbox_defaults:sandbox",
            state: "not_applied",
            reason: "unsupported_kind",
            at: STEP_AT,
          },
        ]),
      ]),
    );
    expect(chipText()).toBe("✓ On dev-box");
  });

  it("footers the last report and opens Details", async () => {
    const { onDetails } = openProblems();
    await userEvent.click(screen.getByRole("button"));

    expect(
      screen.getByText(`Last reported by dev-box ${formatted(REPORTED_AT)}`),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(onDetails).toHaveBeenCalledOnce();
  });

  it("prints no unknown text for a host that never reported", async () => {
    renderChip([
      poolConfigurationChip(
        { ...poolReport("dev-box"), lastReportedAt: null },
        null,
        null,
      ),
    ]);
    await userEvent.click(screen.getByRole("button"));
    const popover = screen.getByRole("listitem").parentElement;
    expect(popover?.textContent).toContain("dev-box");
    expect(popover?.textContent).not.toMatch(/unknown/i);
    expect(screen.queryByText(/Last report/)).toBeNull();
  });
});

describe("the detail rows of the host source", () => {
  function hostChip(
    status: Partial<EnvironmentStatusResponseV11>,
  ): ConfigurationChipHost {
    return hostConfigurationChip({
      host: { hostId: "host-a", name: "dev-box" },
      status: environmentStatusFixture(status),
      version: null,
      kinds: null,
      lastReportedAt: REPORTED_AT,
    });
  }

  it("shows the host once, with no unknown time, and offers its first recovery", async () => {
    const { onRecover } = renderChip([
      hostChip({
        items: [
          itemStatusFixture({
            kind: "variable",
            key: "NEEDS_CLI",
            status: "failed",
            code: "not_installed",
          }),
          itemStatusFixture({
            kind: "variable",
            key: "NO_WRITE",
            status: "failed",
            code: "permission_denied",
          }),
          itemStatusFixture({
            kind: "variable",
            key: "BROKEN",
            status: "failed",
            code: "apply_failed",
          }),
          itemStatusFixture({
            kind: "setup_script",
            key: "macos",
            status: "failed",
            code: "apply_failed",
          }),
          itemStatusFixture({ kind: "variable", key: "OK" }),
        ],
      }),
    ]);

    expect(chipText()).toBe("4 not applied on dev-box");
    await userEvent.click(screen.getByRole("button"));

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("dev-box");
    expect(rows[0]?.textContent).not.toMatch(/unknown/i);
    expect(rows[0]?.textContent).toContain(
      `Last reported ${formatted(REPORTED_AT)}`,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Install on dev-box" }),
    );
    expect(onRecover).toHaveBeenCalledExactlyOnceWith({
      kind: "install",
      hostId: "host-a",
    });
  });

  it("asks to update a host that does not support an item yet", async () => {
    const { onRecover } = renderChip([
      hostChip({
        items: [
          itemStatusFixture({
            kind: "variable",
            key: "NEW",
            status: "unsupported",
            minimumHostVersion: "1.9.0",
          }),
        ],
      }),
    ]);

    expect(chipText()).toBe("Update dev-box to use your settings");
    await userEvent.click(screen.getByRole("button"));
    expect(onRecover).toHaveBeenCalledExactlyOnceWith({
      kind: "overview",
      hostId: "host-a",
    });
  });

  it.each(["unsupported", "pending"] as const)(
    "reads applied for a host whose sandbox defaults are %s",
    (status) => {
      renderChip([
        hostChip({
          items: [
            itemStatusFixture({
              kind: "variable",
              key: "FOO",
              status: "applied",
            }),
            itemStatusFixture({
              kind: "sandbox_defaults",
              key: "sandbox",
              status,
              minimumHostVersion: status === "unsupported" ? "1.9.0" : null,
            }),
          ],
        }),
      ]);
      expect(chipText()).toBe("✓ On dev-box");
    },
  );

  it("reads applying while the host has not reached the desired revision", () => {
    renderChip([hostChip({ desiredRevision: 3, appliedRevision: 2 })]);
    expect(chipText()).toBe("Applying on dev-box…");
  });
});
