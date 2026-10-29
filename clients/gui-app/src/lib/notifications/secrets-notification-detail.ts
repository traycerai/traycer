import { parseKnownHostNotificationPayloadForKind } from "@traycer/protocol/host/notifications/payloads";
import type { HostNotificationKind } from "@traycer/protocol/host/notifications/host-notifications";
import {
  SECRET_REQUEST_STATUS_OF_DECISION,
  type SecretRequestDecision,
} from "@traycer/protocol/host/sandbox-secrets";

/**
 * What a secrets notification row says beyond its title and body: the grant
 * request an agent raised. Parsed once, where the row is built, from the row's
 * own typed payload - so a row whose payload this build cannot read has no
 * detail and renders as any other row.
 *
 * Every string here was written by an agent or by the guest. It is rendered
 * as plain text and never interpreted.
 */
export type SecretsNotificationDetail = {
  readonly kind: "grant-request";
  /** The broker's request id: what the decision is posted against. */
  readonly requestId: string;
  /** `null` when the agent named only a destination. */
  readonly secretName: string | null;
  readonly destination: string | null;
  readonly port: number | null;
  readonly protocol: string | null;
  readonly reason: string;
  readonly sandboxName: string | null;
  /** The environment the request is decided in; `null` is Personal. */
  readonly environmentId: string | null;
  /** A team request's team, by display name; `null` for Personal. */
  readonly teamName: string | null;
  /** Once resolved: how (known: approved, declined, expired). */
  readonly decision: string | null;
  /** Once resolved: whose answer settled it, by display name. */
  readonly decidedBy: string | null;
};

export function secretsNotificationDetail(
  kind: HostNotificationKind,
  payload: unknown,
): SecretsNotificationDetail | null {
  const known = parseKnownHostNotificationPayloadForKind(kind, payload);
  if (known === null) return null;
  if (known.kind === "secret_grant_request") {
    return {
      kind: "grant-request",
      requestId: known.requestId,
      secretName: known.secretName,
      destination: known.destination,
      port: known.port ?? null,
      protocol: known.protocol,
      reason: known.reason,
      sandboxName: known.sandboxName ?? null,
      environmentId: known.environmentId ?? null,
      teamName: known.teamName ?? null,
      decision: known.decision ?? null,
      decidedBy: known.decidedBy ?? null,
    };
  }
  return null;
}

/** The longest agent-authored reason the card shows. */
const REASON_MAX_LENGTH = 400;

export function secretGrantRequestReason(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > REASON_MAX_LENGTH
    ? `${trimmed.slice(0, REASON_MAX_LENGTH)}…`
    : trimmed;
}

/** "db.internal:5432 (postgres)", "db.internal", or `null` with no destination. */
export function secretGrantRequestDestination(
  detail: Extract<SecretsNotificationDetail, { kind: "grant-request" }>,
): string | null {
  if (detail.destination === null) return null;
  const address =
    detail.port === null
      ? detail.destination
      : `${detail.destination}:${detail.port}`;
  return detail.protocol === null ? address : `${address} (${detail.protocol})`;
}

/**
 * The three answers, in the order the card offers them. On a team request
 * the wider approval names the team: it reaches every sandbox of the team,
 * including ones other members create.
 */
export function secretGrantDecisions(teamName: string | null): readonly {
  readonly decision: SecretRequestDecision;
  readonly label: string;
}[] {
  return [
    { decision: "approve", label: "Approve for this sandbox" },
    {
      decision: "approve_default",
      label:
        teamName === null
          ? "Approve for all sandboxes"
          : `Approve for all ${teamName} sandboxes`,
    },
    { decision: "decline", label: "Decline" },
  ];
}

/**
 * The confirmation a team's wider approval asks first, or `null` for a
 * personal request, which needs none.
 */
export function secretGrantDefaultConfirmation(
  teamName: string | null,
  secretName: string | null,
): string | null {
  if (teamName === null) return null;
  const secret = secretName ?? "this secret";
  return `Every current and future ${teamName} sandbox will hold ${secret}.`;
}

/**
 * Who settled a request, in words: "Approved by Ana." or "Declined by Ana.",
 * or `null` when the answer names nobody (an older broker, an expiry).
 */
export function secretRequestDecidedByLine(
  status: string,
  decidedBy: string | null,
): string | null {
  if (decidedBy === null) return null;
  if (status === "approved" || status === "approved_default") {
    return `Approved by ${decidedBy}.`;
  }
  if (status === "declined") return `Declined by ${decidedBy}.`;
  return null;
}

const STATUS_LINE: Readonly<Record<string, string>> = {
  [SECRET_REQUEST_STATUS_OF_DECISION.approve]:
    "Approved for this sandbox, for as long as it exists.",
  [SECRET_REQUEST_STATUS_OF_DECISION.approve_default]:
    "Approved for this sandbox, and every new sandbox gets it by default.",
  [SECRET_REQUEST_STATUS_OF_DECISION.decline]:
    "Declined. Nothing was granted and the agent has been told.",
  expired: "This request expired before it was answered.",
  pending: "This request is still waiting for an answer.",
};

/** Where a request stands, in words; a status this build does not know reads as closed. */
export function secretRequestStatusLine(status: string): string {
  return Object.hasOwn(STATUS_LINE, status)
    ? STATUS_LINE[status]
    : "This request is closed.";
}
