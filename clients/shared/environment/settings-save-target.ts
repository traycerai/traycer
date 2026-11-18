// The app recognises its own hold by these reads and what it sent, never by
// anything a host returned.
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

const authnBoundHostsSchema = z.object({
  hosts: z.array(
    z.object({
      hostId: z.string().min(1),
      sharingGeneration: z.number().int().nonnegative().nullable().optional(),
      hostPlatform: z.string().nullable().optional(),
    }),
  ),
});

export interface SettingsSaveHost {
  readonly sharingGeneration: number;
  readonly hostOs: HostOs | null;
}

/** Null when authn does not list it or names no generation, so no save on it is remembered. */
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
  // An older authn has no route for a newer kind: it holds no row of it.
  if (
    answer.status === 400 &&
    errorBodyCode(answer.body) === "kind_not_item_route"
  ) {
    return [];
  }
  return parseSettings(answer, authnItemsResponseSchema).items;
}
