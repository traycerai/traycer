import { z } from "zod";
import type { EnvironmentMovePersonal } from "@traycer/protocol/host/environment/move-contracts";
import { PATH_ID_PATTERN } from "../host-client/path-id";
import { readConfigurationItems } from "./configuration-settings";
import { listSecrets } from "./configuration-secrets";
import {
  type EnvironmentCloud,
  parseSettings,
  sendSettings,
} from "./environment-cloud";

/**
 * What the app hands the computer so it can draw a move into Personal
 * (`personal` on `environment.move.plan@2.0` and `environment.move.stage`):
 * every row of the item kinds the move compares, as the route answered them,
 * in the route's order, and whether Personal holds any secret, never a
 * secret's declaration. The computer draws the sheet from it and never reads
 * Personal itself; authn still decides each row at the acceptance.
 */
export type PersonalForMove = NonNullable<EnvironmentMovePersonal>;

/** The most items the plan and stage requests carry (`environmentMovePersonalSchema`). */
export const PERSONAL_FOR_MOVE_MAX_ITEMS = 4096;

/** `auto_policy` is a setting of the configuration, not a row a move compares. */
const NOT_COMPARED_KINDS: ReadonlySet<string> = new Set(["auto_policy"]);

const environmentMeSchema = z.object({
  environmentId: z.string().regex(PATH_ID_PATTERN),
});

/**
 * The person's Personal, read on their own sign-in, or `null` when it could
 * not be read whole: the computer then answers that Personal is unavailable
 * rather than drawing a sheet from part of it. Over the bound is not read
 * whole either.
 */
export async function readPersonalForMove(
  cloud: EnvironmentCloud,
): Promise<PersonalForMove | null> {
  try {
    const { environmentId } = parseSettings(
      await sendSettings(cloud, "GET", "api/v3/environments/me", null),
      environmentMeSchema,
    );
    const [read, secrets] = await Promise.all([
      readConfigurationItems(cloud, environmentId),
      listSecrets(cloud, environmentId),
    ]);
    const items = read.items
      .filter((item) => !NOT_COMPARED_KINDS.has(item.kind))
      .map(({ kind, key, os, value }) => ({ kind, key, os, value }));
    if (items.length > PERSONAL_FOR_MOVE_MAX_ITEMS) return null;
    return { items, holdsSecrets: secrets.secrets.length > 0 };
  } catch {
    // Any refusal, failure or unreadable answer: the sheet's own
    // "unavailable" covers it, and the reason is not the person's to act on.
    return null;
  }
}
