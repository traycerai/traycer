import { describe, expect, it } from "vitest";
import {
  ABSENT,
  disabledBy,
  INDEPENDENT,
  LIVE,
  orderedRows,
  type LayoutFormContext,
  type RowDependency,
  type RowRule,
} from "@/components/layout-editor/regions/row-availability";
import { DEFAULT_ARRANGEMENT } from "@/lib/layout/layout-arrangement";
import { effectiveLayoutValues } from "@/lib/layout/layout-presets";
import { DEFAULT_LAYOUT_SNAPSHOT } from "@/stores/layout/layout-store";

const BASE_VALUES = effectiveLayoutValues(
  DEFAULT_LAYOUT_SNAPSHOT.basePreset,
  DEFAULT_LAYOUT_SNAPSHOT.overrides,
);

function contextWith(values: LayoutFormContext["values"]): LayoutFormContext {
  return {
    values,
    arrangement: DEFAULT_ARRANGEMENT,
    shell: {
      runnerHost: null,
      featureSettings: null,
      mobileApp: false,
      phoneLayout: false,
    },
    facts: { voiceInputEnabled: true },
  };
}

interface TestRow {
  readonly id: string;
  readonly depends: RowDependency;
}

function row(id: string, under: string | null, rule: RowRule): TestRow {
  return { id, depends: { under, availability: rule } };
}

function ids(rows: ReadonlyArray<{ readonly row: TestRow }>): string[] {
  return rows.map((entry) => entry.row.id);
}

describe("orderedRows", () => {
  it("draws each controller, then the rows declared under it one level in, in declared order", () => {
    const rows = [
      row("a", null, INDEPENDENT.availability),
      row("b", null, INDEPENDENT.availability),
      // Declared after `b` but under `a`: it moves up to sit under its
      // controller, and the two dependents keep the order they were declared in.
      row("a-second", "a", INDEPENDENT.availability),
      row("a-first-declared-later", "a", INDEPENDENT.availability),
      row("b-child", "b", INDEPENDENT.availability),
    ];

    const drawn = orderedRows(rows, contextWith(BASE_VALUES));

    expect(drawn.map((entry) => [entry.row.id, entry.depth])).toEqual([
      ["a", 0],
      ["a-second", 1],
      ["a-first-declared-later", 1],
      ["b", 0],
      ["b-child", 1],
    ]);
  });

  it("never moves a row because a value changed: the live dependent and the disabled one keep their declared places", () => {
    const rule = (flag: boolean): RowRule => {
      return (context) =>
        (context.values.minimap.shown === "shown") === flag
          ? LIVE
          : disabledBy("off", null);
    };
    const rows = [
      row("controller", null, INDEPENDENT.availability),
      row("when-shown", "controller", rule(true)),
      row("when-hidden", "controller", rule(false)),
    ];

    const shown = orderedRows(
      rows,
      contextWith({
        ...BASE_VALUES,
        minimap: { ...BASE_VALUES.minimap, shown: "shown" },
      }),
    );
    const hidden = orderedRows(
      rows,
      contextWith({
        ...BASE_VALUES,
        minimap: { ...BASE_VALUES.minimap, shown: "hidden" },
      }),
    );

    expect(ids(shown)).toEqual(["controller", "when-shown", "when-hidden"]);
    expect(ids(hidden)).toEqual(ids(shown));
    expect(shown.map((entry) => entry.availability.kind)).toEqual([
      "live",
      "live",
      "disabled",
    ]);
    expect(hidden.map((entry) => entry.availability.kind)).toEqual([
      "live",
      "disabled",
      "live",
    ]);
  });

  it("drops an absent row and keeps its siblings", () => {
    const rows = [
      row("controller", null, INDEPENDENT.availability),
      row("gone", "controller", () => ABSENT),
      row("kept", "controller", INDEPENDENT.availability),
    ];

    expect(ids(orderedRows(rows, contextWith(BASE_VALUES)))).toEqual([
      "controller",
      "kept",
    ]);
  });

  it("throws in development on a row nested two deep or under an id the section does not have", () => {
    const twoDeep = [
      row("a", null, INDEPENDENT.availability),
      row("b", "a", INDEPENDENT.availability),
      row("c", "b", INDEPENDENT.availability),
    ];
    const orphan = [
      row("a", null, INDEPENDENT.availability),
      row("b", "elsewhere", INDEPENDENT.availability),
    ];

    expect(() => orderedRows(twoDeep, contextWith(BASE_VALUES))).toThrow(
      /nest one level/,
    );
    expect(() => orderedRows(orphan, contextWith(BASE_VALUES))).toThrow(
      /nest one level/,
    );
  });
});
