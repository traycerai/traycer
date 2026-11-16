/**
 * What the app reads from authn itself, on the person's sign-in, before a
 * save made in a host's settings: the host's ownership generation and OS in
 * its environment, and the rows of the item the save writes. The app
 * recognises its own hold by these and by what it sent, never by anything a
 * host returned (`settings-save-mapping.ts` in the protocol).
 */
import { z } from "zod";
import {
  hostOsOfPlatform,
  type HostOs,
} from "@traycer/protocol/host/environment/host-os";
import {
  authnItemsResponseSchema,
  type AuthnItemRow,
} from "./authn-environment-schemas";
import {
  environmentPath,
  errorBodyCode,
  parseSettings,
  sendSettings,
  type EnvironmentCloud,
} from "./environment-cloud";

/** authn's host row with `include=binding`, as much as a save reads. Not strict. */
const authnBoundHostsSchema = z.object({
  hosts: z.array(
    z.object({
      hostId: z.string().min(1),
      sharingGeneration: z.number().int().nonnegative().nullable().optional(),
      hostPlatform: z.string().nullable().optional(),
    }),
  ),
});

/** The host a save is made on, as authn lists it in the environment. */
export interface SettingsSaveHost {
  readonly sharingGeneration: number;
  /** Null when authn does not know the host's platform. */
  readonly hostOs: HostOs | null;
}

/**
 * `hostId` in `environmentId` as authn lists it; null when authn does not
 * list it there or names no generation for it, so no save on it is
 * remembered.
 */
export async function readSettingsSaveHost(
  cloud: EnvironmentCloud,
  environmentId: string,
  hostId: string,
): Promise<SettingsSaveHost | null> {
  const { hosts } = parseSettings(
    await sendSettings(
      cloud,
      "GET",
      `${environmentPath(environmentId)}/hosts?include=binding`,
      null,
    ),
    authnBoundHostsSchema,
  );
  const row = hosts.find((host) => host.hostId === hostId);
  const generation = row?.sharingGeneration ?? null;
  if (row === undefined || generation === null) return null;
  return {
    sharingGeneration: generation,
    hostOs: hostOsOfPlatform(row.hostPlatform ?? null),
  };
}

/** Every row authn holds of `kind` in `environmentId`, every OS's. */
export async function readSettingsItemRows(
  cloud: EnvironmentCloud,
  environmentId: string,
  kind: string,
): Promise<readonly AuthnItemRow[]> {
  const answer = await sendSettings(
    cloud,
    "GET",
    `${environmentPath(environmentId)}/items?kind=${encodeURIComponent(kind)}`,
    null,
  );
  // An authn older than this app has no route for a newer kind: it holds no
  // row of it.
  if (
    answer.status === 400 &&
    errorBodyCode(answer.body) === "kind_not_item_route"
  ) {
    return [];
  }
  return parseSettings(answer, authnItemsResponseSchema).items;
}
