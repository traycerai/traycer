import { parseKnownHostNotificationPayloadForKind } from "@traycer/protocol/host/notifications/payloads";
import type { HostNotificationKind } from "@traycer/protocol/host/notifications/host-notifications";

/**
 * What a P2 environment / team / secret-removed row says beyond its title
 * and body. Parsed once where the row is built, from the row's own typed
 * payload. A payload this build cannot read has no detail and renders as
 * any other row.
 */
export type EnvironmentNotificationDetail =
  | {
      readonly kind: "team_role_changed";
      readonly environmentId: string;
      readonly teamName: string;
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly kind: "team_member_welcome";
      readonly environmentId: string;
      readonly teamName: string;
      readonly role: string;
    }
  | {
      readonly kind: "team_host_returned";
      readonly environmentId: string;
      readonly teamName: string;
      readonly hostName: string;
    }
  | {
      readonly kind: "environment_move_stalled";
      readonly environmentId: string;
      readonly hostId: string;
      readonly hostName: string;
      readonly remaining: number;
      readonly reason: string;
    }
  | {
      readonly kind: "secret_removed";
      readonly environmentId: string;
      readonly secretName: string;
      readonly outcome: "revoked" | "cleanup_requested" | "destroyed";
    };

export function environmentNotificationDetail(
  kind: HostNotificationKind,
  payload: unknown,
): EnvironmentNotificationDetail | null {
  const known = parseKnownHostNotificationPayloadForKind(kind, payload);
  if (known === null) return null;
  if (known.kind === "team_role_changed") {
    return {
      kind: "team_role_changed",
      environmentId: known.environmentId,
      teamName: known.teamName,
      from: known.from,
      to: known.to,
    };
  }
  // The newcomer's own row, when it names their role: the grant they got.
  if (
    known.kind === "team_member_joined" &&
    known.toNewcomer &&
    known.role !== undefined
  ) {
    return {
      kind: "team_member_welcome",
      environmentId: known.environmentId,
      teamName: known.teamName,
      role: known.role,
    };
  }
  if (known.kind === "team_host_returned") {
    return {
      kind: "team_host_returned",
      environmentId: known.environmentId,
      teamName: known.teamName,
      hostName: known.hostName,
    };
  }
  if (known.kind === "environment_move_stalled") {
    return {
      kind: "environment_move_stalled",
      environmentId: known.environmentId,
      hostId: known.hostId,
      hostName: known.hostName,
      remaining: known.remaining,
      reason: known.reason,
    };
  }
  if (known.kind === "secret_removed") {
    return {
      kind: "secret_removed",
      environmentId: known.environmentId,
      secretName: known.secretName,
      outcome: known.outcome,
    };
  }
  return null;
}
