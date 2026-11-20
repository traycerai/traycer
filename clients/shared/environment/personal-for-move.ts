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
 * Whether Personal holds any secret, never a secret's declaration. The computer
 * draws the sheet from this and never reads Personal; authn decides each row.
 */
export type PersonalForMove = NonNullable<EnvironmentMovePersonal>;

export const PERSONAL_FOR_MOVE_MAX_ITEMS = 4096;

/** `auto_policy` is a setting of the configuration, not a row a move compares. */
const NOT_COMPARED_KINDS: ReadonlySet<string> = new Set(["auto_policy"]);

const environmentMeSchema = z.object({
  environmentId: z.string().regex(PATH_ID_PATTERN),
});

/**
 * `null` when Personal could not be read whole (over the bound too): the computer
 * then answers unavailable rather than draw from part of it.
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
    return null;
  }
}
