/**
 * `environment.host.list` as the app's own call to authn's environment
 * routes: the hosts of an environment, with whether each is reachable, when
 * it last reported, how it applied each item, and whether it still holds a
 * Local row. It answers the protocol's `@1.2` shape as the host's forwarder
 * built it (`listConfigurationHosts` in the internal repository), except
 * that the binding fields are authn's own: no host had to be asked.
 */
import { z } from "zod";
import type {
  EnvironmentHostItemApply,
  EnvironmentHostListResponseV12,
} from "@traycer/protocol/host/environment/contracts";
import {
  environmentPath,
  parseSettings,
  sendSettings,
  type EnvironmentCloud,
} from "./environment-cloud";

/**
 * authn's host row, as much of it as this read uses. Not strict: authn adds
 * fields this app does not read. The binding fields come with
 * `include=binding`; an authn that does not know it sends none of them, and
 * each then reads null.
 */
const authnHostRowSchema = z.object({
  hostId: z.string().min(1),
  hostName: z.string().nullable(),
  hostKind: z.enum(["personal", "sandbox"]),
  reportedAt: z.number().int().nonnegative().nullable(),
  online: z.boolean(),
  purgePending: z.boolean(),
  items: z.array(
    z.object({
      kind: z.string(),
      key: z.string(),
      status: z.enum(["applied", "pending", "failed", "unsupported"]),
      code: z.string().min(1).max(64),
    }),
  ),
  hasLocalRow: z.boolean().nullable().optional(),
  enrolledByUserId: z.string().min(1).nullable().optional(),
  boundAt: z.number().int().nullable().optional(),
  hostPlatform: z.string().nullable().optional(),
});
const authnHostsSchema = z.object({ hosts: z.array(authnHostRowSchema) });

function reportedItemState(
  status: "applied" | "pending" | "failed" | "unsupported",
  hostKind: "personal" | "sandbox",
  online: boolean,
): EnvironmentHostItemApply["state"] {
  if (status === "applied") return "applied";
  if (status !== "pending") return "not_applied";
  return !online && hostKind === "sandbox" ? "waiting_resume" : "received";
}

/**
 * Every host authn lists for the environment, less those removed and not
 * seen since (`purgePending`). A failure is the settings mapping of every
 * other read here: an environment the person cannot read answers 404, which
 * is the settings refusal.
 */
export async function listConfigurationHosts(
  cloud: EnvironmentCloud,
  environmentId: string,
): Promise<EnvironmentHostListResponseV12> {
  const { hosts } = parseSettings(
    await sendSettings(
      cloud,
      "GET",
      `${environmentPath(environmentId)}/hosts?include=localRow,binding`,
      null,
    ),
    authnHostsSchema,
  );
  return {
    hosts: hosts
      .filter((row) => !row.purgePending)
      .map((row) => {
        const reportedAt = row.reportedAt;
        return {
          hostId: row.hostId,
          hostLabel: row.hostName,
          hostPlatform: row.hostPlatform ?? null,
          enrolledByUserId: row.enrolledByUserId ?? null,
          kind: row.hostKind,
          boundAt: row.boundAt ?? null,
          reachable: row.online,
          lastReportedAt: reportedAt,
          hasLocalRow: row.hasLocalRow ?? null,
          applied:
            reportedAt === null
              ? []
              : row.items.map((item) => {
                  const state = reportedItemState(
                    item.status,
                    row.hostKind,
                    row.online,
                  );
                  return {
                    itemKey: `${item.kind}:${item.key}`,
                    state,
                    reason:
                      state === "not_applied" && item.code !== "ok"
                        ? item.code
                        : null,
                    at: reportedAt,
                  };
                }),
        };
      }),
  };
}
