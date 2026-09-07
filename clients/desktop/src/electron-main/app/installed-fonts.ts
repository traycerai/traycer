import { getFonts } from "font-list";
import { log } from "./logger";
import type { InstalledFont } from "../../ipc-contracts/platform-types";

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
