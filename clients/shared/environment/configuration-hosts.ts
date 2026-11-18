// `environment.host.list` answered by authn directly: no host has to be asked.
import { z } from "zod";
import type {
  EnvironmentHostItemApply,
  EnvironmentHostListResponseV12,
} from "@traycer/protocol/host/environment/contracts";
import {
  EnvironmentCloudError,
  NEEDS_PERMISSION_MESSAGE,
  SETTINGS_REFUSED_MESSAGE,
  environmentPath,
  errorBodyCode,
  parseSettings,
  sendSettings,
  type EnvironmentCloud,
} from "./environment-cloud";

// The binding fields come only with `include=binding`; an older authn sends none
// and each reads null.
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
 * authn's 404 `environment_not_found` and 403 `environment_action_forbidden` are
 * `not_readable`, so the last list is not kept through them; the same statuses
 * without the code are a malformed request and a plain `forbidden`.
 */
export async function listConfigurationHosts(
  cloud: EnvironmentCloud,
  environmentId: string,
): Promise<EnvironmentHostListResponseV12> {
  const answer = await sendSettings(
    cloud,
    "GET",
    `${environmentPath(environmentId)}/hosts?include=localRow,binding`,
    null,
  );
  const code = errorBodyCode(answer.body);
  if (answer.status === 404 && code === "environment_not_found") {
    throw new EnvironmentCloudError("not_readable", SETTINGS_REFUSED_MESSAGE);
  }
  if (answer.status === 403 && code === "environment_action_forbidden") {
    throw new EnvironmentCloudError("not_readable", NEEDS_PERMISSION_MESSAGE);
  }
  const { hosts } = parseSettings(answer, authnHostsSchema);
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
