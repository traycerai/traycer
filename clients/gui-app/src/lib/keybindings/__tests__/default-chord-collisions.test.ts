/**
 * Cross-action guard, on both platforms: no two chord-kind actions resolve to
 * the same default chord.
 */
import { describe, expect, it, vi } from "vitest";
import { createPlatformMock } from "@/__tests__/create-platform-mock";

const platformMock = vi.hoisted(() => ({ mac: false }));
vi.mock("@/lib/keybindings/platform", () => createPlatformMock(platformMock));

import {
  ACTION_IDS,
  ACTION_META,
  resolveActionDefaultChord,
} from "@/lib/keybindings/actions";

describe.each([
  { isMac: true, label: "mac" },
  { isMac: false, label: "non-mac" },
])("chord-kind action defaults on $label", ({ isMac }) => {
  it("has no duplicate resolved default across actions", () => {
    platformMock.mac = isMac;
    const holders = new Map<string, string>();
    for (const id of ACTION_IDS) {
      const meta = ACTION_META[id];
      if (meta.kind !== "chord") continue;
      const chord = resolveActionDefaultChord(meta);
      if (chord === null) continue;
      const holder = holders.get(chord);
      expect(
        holder,
        `${id} and ${holder ?? ""} both default to "${chord}"`,
      ).toBeUndefined();
      holders.set(chord, id);
    }
  });
});
