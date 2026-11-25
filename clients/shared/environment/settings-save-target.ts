// The app recognises its own hold by these reads and what it sent, never by
// anything a host returned.
import { z } from "zod";
import { PATH_ID_PATTERN } from "../host-client/path-id";
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

const personalTargetSchema = z.object({
  environmentId: z.string().regex(PATH_ID_PATTERN),
});

const consumedPersonalMoveSchema = z.object({
  state: z.literal("consumed"),
  acceptanceId: z.uuid(),
  result: z.object({
    targetKind: z.literal("personal"),
    migration: z.object({
      acceptanceId: z.uuid(),
      migration: z.object({ revision: z.number().int().nonnegative() }),
    }),
  }),
});

export async function readSettingsSavePersonal(
  cloud: EnvironmentCloud,
): Promise<string> {
  return parseSettings(
    await sendSettings(cloud, "GET", "api/v3/environments/me", null),
    personalTargetSchema,
  ).environmentId;
}

/** This read is authorized for the person who accepted the Move. */
export async function readAcceptedPersonalMoveRevision(
  cloud: EnvironmentCloud,
  hostId: string,
  acceptanceId: string,
): Promise<number | null> {
  const answer = parseSettings(
    await sendSettings(
      cloud,
      "GET",
      `api/v3/hosts/${encodeURIComponent(hostId)}/move-acceptances/${encodeURIComponent(acceptanceId)}`,
      null,
    ),
    consumedPersonalMoveSchema,
  );
  const { migration } = answer.result;
  return answer.acceptanceId === acceptanceId &&
    migration.acceptanceId === acceptanceId
    ? migration.migration.revision
    : null;
}

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
