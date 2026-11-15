/**
 * A team's own bundle balance, read from authn's organization route on the
 * person's sign-in: the pot every wake of the team's sandboxes draws, whoever
 * starts it, readable by any accepted member of the team.
 *
 * Nothing here logs: no handle, value or body is written anywhere.
 */
import { z } from "zod";
import {
  parseSettings,
  sendSettings,
  type EnvironmentCloud,
} from "./environment-cloud";

const organizationBundleSchema = z.object({
  bundleSummary: z.object({ bundleRemaining: z.number() }).optional(),
});

/**
 * The team's remaining bundle credits, or null when the organization answers
 * with no bundle summary (no subscription to read it from). Throws the cloud
 * sender's error when the read is refused or nothing answered.
 */
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
