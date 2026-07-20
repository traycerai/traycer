import { describe, expect, it } from "vitest";

import type { SlashCommand } from "@/lib/composer/types";

import {
  NATIVE_COMMAND_DISABLED_REASON,
  slashItemsForScope,
} from "../use-slash-items";

function command(name: string, kind: SlashCommand["kind"]): SlashCommand {
  return {
    harnessId: "claude",
    name,
    description: "",
    argumentHint: null,
    kind,
    metadata: {},
    source: "provider",
    preview: { kind: "text", primary: "", secondary: null, mono: false },
  };
}

const CATALOG: ReadonlyArray<SlashCommand> = [
  command("plan", "slash-command"),
  command("frontend-design", "skill"),
];

function namesAndReasons(
  items: ReadonlyArray<{
    readonly id: string;
    readonly disabledReason?: string | null;
  }>,
): Array<[string, string | null]> {
  return items.map((item) => [item.id, item.disabledReason ?? null]);
}

describe("slashItemsForScope", () => {
  it("leaves everything selectable at the start of the prompt", () => {
    expect(namesAndReasons(slashItemsForScope(CATALOG, "all"))).toEqual([
      ["slash:plan", null],
      ["slash:frontend-design", null],
    ]);
  });

  // Under `/` the user asked for the catalog, so a native command has to stay
  // visible and account for itself rather than disappear as they type.
  it("keeps native commands listed but disabled under an inline slash", () => {
    expect(namesAndReasons(slashItemsForScope(CATALOG, "skills"))).toEqual([
      ["slash:plan", NATIVE_COMMAND_DISABLED_REASON],
      ["slash:frontend-design", null],
    ]);
  });

  // Under `$` they asked for skills. A native command was never on offer at any
  // position, so listing it disabled would answer a question nobody asked - and
  // the "only at the start of the message" reason would be untrue here.
  it("drops native commands entirely under a skills trigger", () => {
    expect(namesAndReasons(slashItemsForScope(CATALOG, "skills-only"))).toEqual(
      [["slash:frontend-design", null]],
    );
  });

  it("returns nothing to publish when the catalog is empty", () => {
    expect(slashItemsForScope([], "skills-only")).toEqual([]);
  });
});
