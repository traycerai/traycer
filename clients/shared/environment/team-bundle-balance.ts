// The pot every wake of the team's sandboxes draws; any accepted member may read
// it. Nothing here logs.
import { z } from "zod";
import {
  parseSettings,
  sendSettings,
  type EnvironmentCloud,
} from "./environment-cloud";

const organizationBundleSchema = z.object({
  bundleSummary: z.object({ bundleRemaining: z.number() }).optional(),
});

/** Null when the organization has no bundle summary (no subscription). */
export async function readTeamBundleRemaining(
  cloud: EnvironmentCloud,
  providerHandle: string,
): Promise<number | null> {
  const answer = await sendSettings(
    cloud,
    "GET",
    `api/organization/${encodeURIComponent(providerHandle)}`,
    null,
  );
  const parsed = parseSettings(answer, organizationBundleSchema);
  return parsed.bundleSummary?.bundleRemaining ?? null;
}
