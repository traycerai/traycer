/**
 * Merges base keywords with the lowercased labels of every leaf
 * inside a sub-page. Lets fuzzy search match an entry row via a
 * term that only appears inside its sub-page (typing "Opus"
 * surfaces the "Switch model" entry).
 */
import type { CommandItem } from "@/lib/commands/types";

export function withSubpageLabels(
  base: ReadonlyArray<string>,
  leafGroups: ReadonlyArray<ReadonlyArray<CommandItem>>,
): ReadonlyArray<string> {
  const out: Array<string> = [...base];
  for (const group of leafGroups) {
    for (const leaf of group) {
      out.push(leaf.label.toLowerCase());
    }
  }
  return out;
}
