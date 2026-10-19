import {
  SANDBOX_EGRESS_REFUSAL_CODES,
  type SandboxEgressRefusalCode,
} from "@traycer/protocol/host/sandbox-egress";

/**
 * The copy for a sandbox's brokered-egress refusals, keyed by code. ONE table
 * for every channel a refusal reaches the app on: a turn's typed error block
 * (the transcript), and the sandbox host's typed egress events (the card), so
 * a database, SSH or broker refusal reads the same as an HTTPS one.
 *
 * Each row names what the refusal is about - the secret, the host, the
 * protocol - from whatever the channel carried. A typed event carries all
 * three where the emitter knows them; an error block carries none, and its
 * host message is shown beside the row instead.
 */
export interface SandboxEgressRefusalSubject {
  /** The bound secret's NAME, never a value. */
  readonly secret: string | null;
  readonly host: string | null;
  readonly protocol: string | null;
}

export const NO_EGRESS_REFUSAL_SUBJECT: SandboxEgressRefusalSubject = {
  secret: null,
  host: null,
  protocol: null,
};

export interface SandboxEgressRefusalCopy {
  readonly headline: string;
  readonly description: string;
  /**
   * Whether a grant from the user is the remedy. Exactly one row sets it, and
   * `authorization_stale` deliberately does not: a stale authorization clears
   * by itself, and asking the user for a grant they already gave is the
   * mistake the two rows exist to keep apart.
   */
  readonly asksForGrant: boolean;
}

interface RefusalRow {
  readonly headline: string;
  readonly describe: (subject: SandboxEgressRefusalSubject) => string;
  readonly asksForGrant: boolean;
}

/** "db.internal (postgres)", "db.internal", "this postgres destination". */
function destinationOf(subject: SandboxEgressRefusalSubject): string {
  if (subject.host === null) {
    return subject.protocol === null
      ? "this destination"
      : `this ${subject.protocol} destination`;
  }
  return subject.protocol === null
    ? subject.host
    : `${subject.host} (${subject.protocol})`;
}

function secretOf(subject: SandboxEgressRefusalSubject): string {
  return subject.secret === null
    ? "the secret"
    : `the secret ${subject.secret}`;
}

const REFUSAL_ROWS: Readonly<Record<SandboxEgressRefusalCode, RefusalRow>> = {
  grant_missing: {
    headline: "No grant for this destination",
    describe: (subject) =>
      subject.secret === null
        ? `This sandbox has no secret granted for ${destinationOf(subject)}. The agent can ask you for one, or you can grant it in Secrets.`
        : `The secret ${subject.secret} is not granted to this sandbox for ${destinationOf(subject)}. The agent can ask you for it, or you can grant it in Secrets.`,
    asksForGrant: true,
  },
  sandbox_not_awake: {
    headline: "Sandbox is not awake",
    describe: (subject) =>
      `Secrets are brokered only while the sandbox is awake, so the request to ${destinationOf(subject)} was refused. Nothing is lost: wake the sandbox and retry.`,
    asksForGrant: false,
  },
  sandbox_resuming: {
    headline: "Sandbox is still waking",
    describe: (subject) =>
      `The request to ${destinationOf(subject)} arrived before the sandbox finished waking. Retry in a few seconds.`,
    asksForGrant: false,
  },
  authorization_stale: {
    headline: "Authorization is stale, retry shortly",
    describe: (subject) =>
      `Traycer could not confirm this sandbox's grants just now, so the request to ${destinationOf(subject)} was refused. No grant is missing and nothing needs approving: retry shortly.`,
    asksForGrant: false,
  },
  protocol_not_brokered: {
    headline: "Protocol is not brokered",
    describe: (subject) =>
      `${subject.protocol ?? "This protocol"} is not one Traycer brokers, so ${secretOf(subject)} cannot be used for ${subject.host ?? "this destination"} through the gateway. Store it as an exposed secret to use it on a sandbox.`,
    asksForGrant: false,
  },
  signing_shape_unsupported: {
    headline: "Not a request the gateway can sign",
    describe: (subject) =>
      `A presigned URL, or credentials handed on to a third party, cannot be signed in transit${subject.host === null ? "" : ` for ${subject.host}`}. Ask for a short-lived export of ${secretOf(subject)} instead.`,
    asksForGrant: false,
  },
  leaf_unavailable: {
    headline: "Certificate unavailable",
    describe: (subject) =>
      `The sandbox's certificate for ${destinationOf(subject)} is missing or expired, so its local endpoint cannot answer. Repair the sandbox's setup from its card, then retry.`,
    asksForGrant: false,
  },
  connector_offline: {
    headline: "Connector is offline",
    describe: (subject) =>
      `${destinationOf(subject)} is behind a private connector that is not connected. Start the connector in that network, then retry.`,
    asksForGrant: false,
  },
  connector_not_enrolled: {
    headline: "Connector is not enrolled",
    describe: (subject) =>
      `${destinationOf(subject)} is behind a private connector that was never enrolled or has been revoked. Enroll it again in Connectors.`,
    asksForGrant: false,
  },
  socks_command_unsupported: {
    headline: "Connection type not supported",
    describe: (subject) =>
      `The sandbox's proxy carries outbound TCP connections only. The connection to ${destinationOf(subject)} asked for something else (a listening socket, or UDP).`,
    asksForGrant: false,
  },
  port_not_supported: {
    headline: "Port not covered by the grant",
    describe: (subject) =>
      `The connection to ${destinationOf(subject)} named a port other than the one ${secretOf(subject)} is bound to. Use the bound port, or bind the secret to this one in Secrets.`,
    asksForGrant: false,
  },
  endpoint_unavailable: {
    headline: "Local endpoint unavailable",
    describe: (subject) =>
      `The sandbox could not open its local endpoint for ${destinationOf(subject)}: another process on the sandbox holds that port. Stop that process, then repair the sandbox's setup from its card.`,
    asksForGrant: false,
  },
  h3_only_destination: {
    headline: "Destination answers HTTP/3 only",
    describe: (subject) =>
      `${destinationOf(subject)} answers HTTP/3 only, which the way ${secretOf(subject)} is bound cannot carry. Bind it as an HTTP/3 destination in Secrets.`,
    asksForGrant: false,
  },
  SANDBOX_GUEST_NOT_CONFIGURED: {
    headline: "Sandbox setup is not finished",
    describe: (subject) =>
      `This sandbox's setup has not finished, so the request to ${destinationOf(subject)} was not brokered. Retry in a minute, or repair the setup from its card.`,
    asksForGrant: false,
  },
};

function isKnownRefusalCode(code: string): code is SandboxEgressRefusalCode {
  return SANDBOX_EGRESS_REFUSAL_CODES.some((known) => known === code);
}

/**
 * The row for `code`, or `null` for a code this build has no copy for (a
 * worker class's own, or one from a newer host): the caller shows the code
 * and whatever the channel said, never a guessed sentence.
 */
export function sandboxEgressRefusalCopyFor(
  code: string,
  subject: SandboxEgressRefusalSubject,
): SandboxEgressRefusalCopy | null {
  if (!isKnownRefusalCode(code)) return null;
  const row = REFUSAL_ROWS[code];
  return {
    headline: row.headline,
    description: row.describe(subject),
    asksForGrant: row.asksForGrant,
  };
}
