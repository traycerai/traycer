import { getFonts } from "font-list";
import { log } from "./logger";
import type { InstalledFont } from "../../ipc-contracts/platform-types";

/**
 * Enumerates fonts installed on this machine so Settings → Appearance can
 * offer them as UI/code/terminal font choices. Font enumeration is
 * OS/font-manager dependent and can throw or return duplicate/quoted family
 * names, so this normalises the result and degrades to an empty list on
 * failure rather than surfacing an error - the font pickers already accept a
 * free-typed name as a fallback.
 */
export async function listInstalledFonts(): Promise<readonly InstalledFont[]> {
  try {
    const families = await getFonts();
    const byFamily = new Map<string, InstalledFont>();
    for (const raw of families) {
      const family = stripSurroundingQuotes(raw);
      if (family.length === 0 || byFamily.has(family)) continue;
      byFamily.set(family, { family });
    }
    return Array.from(byFamily.values()).sort((a, b) =>
      a.family.localeCompare(b.family),
    );
  } catch (err) {
    log.warn("[installed-fonts] font enumeration failed", { err });
    return [];
  }
}

function stripSurroundingQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}
