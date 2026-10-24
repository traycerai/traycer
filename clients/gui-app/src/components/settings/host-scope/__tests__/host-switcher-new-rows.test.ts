import { describe, expect, it } from "vitest";
import {
  splitNewRows,
  type HostSwitcherNewRow,
} from "@/components/settings/host-scope/host-switcher-new-rows";

function row(configurationKey: string): HostSwitcherNewRow {
  return {
    configurationKey,
    label: `New ${configurationKey} sandbox`,
    subLine: "2 vCPU · 4 GB",
    configurationName: configurationKey,
    disabled: false,
  };
}

function keys(rows: readonly HostSwitcherNewRow[]): readonly string[] {
  return rows.map((entry) => entry.configurationKey);
}

describe("splitNewRows", () => {
  it.each([[["personal"]], [["personal", "acme"]]])(
    "keeps %j all in the head",
    (configurations) => {
      const split = splitNewRows(configurations.map(row), "acme");
      expect(keys(split.head)).toEqual(configurations);
      expect(split.rest).toEqual([]);
    },
  );

  it("leads with the remembered configuration past two and collapses the rest in order", () => {
    const split = splitNewRows(
      [row("personal"), row("acme"), row("globex")],
      "globex",
    );
    expect(keys(split.head)).toEqual(["globex"]);
    expect(keys(split.rest)).toEqual(["personal", "acme"]);
  });

  it("leads with the first row when the remembered configuration is unknown or none", () => {
    const rows = [row("personal"), row("acme"), row("globex")];
    for (const remembered of ["initech", null]) {
      const split = splitNewRows(rows, remembered);
      expect(keys(split.head)).toEqual(["personal"]);
      expect(keys(split.rest)).toEqual(["acme", "globex"]);
    }
  });
});
