import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { EpicCreateOwner } from "@traycer/protocol/host/epic/unary-schemas";
import {
  HostMethodVersionUnsatisfiedError,
  HostRpcError,
  type RequiredHostMethodVersion,
} from "@traycer-clients/shared/host-transport/host-messenger";

/**
 * The `epic.create` minor from which the create is known to be LOCAL-FIRST -
 * seeded into this machine's store and made durable here, rather than sent to
 * the cloud on whatever credential the client still holds.
 *
 * The same minor that carries the typed `refusal`, and that is not a
 * coincidence worth hiding: both are properties of the release whose create
 * runs through the local room store. A host advertising `@1.1` is a host from
 * that release or later.
 */
export const EPIC_CREATE_LOCAL_FIRST_MINOR = 1;

/**
 * Whether this host's `epic.create` is the local-first one.
 *
 * The question a session with no cloud verdict has to answer before creating.
 * `admitsLocalPlane` lets an `unverified` session onto the landing workspace
 * and its composer is live, so the create is reachable; what must not happen
 * is that create going to the cloud on the retained credential, spending
 * exactly the capability the verdict withheld.
 *
 * Until `@1.1` this was asked of `epic.listTasks@1.6` instead - a PROXY, on
 * the reasoning that the release serving the local-first initial LIST leg is
 * the release whose CREATE is local-first. True when written, and it was the
 * only version-bearing signal available, because `epic.create` advertised a
 * single `@1.0` line and so could not distinguish a local-first host from an
 * older one. It was still two methods' release histories tied together by a
 * claim nothing enforced: any release that moved one without the other would
 * have made the gate answer about the wrong method, silently and in the
 * permissive direction. `@1.1` retires the proxy - the subject is now the
 * method actually being called.
 *
 * FAILS CLOSED on both non-version answers. `false` (handshook, method
 * absent) and `null` (no handshake yet) are different facts that both refuse,
 * because admitting on either would be acting on a capability with no evidence
 * for it. Refusing strands nothing: the chip re-resolves when the manifest
 * lands.
 */
export function negotiatedCreateServesLocalFirst(
  version: SchemaVersion | null | false,
): boolean {
  if (version === null || version === false) return false;
  return version.major === 1 && version.minor >= EPIC_CREATE_LOCAL_FIRST_MINOR;
}

/**
 * The `epic.create` minor that carries `owner`. A `@1.2` host's frozen request
 * strips the key, so a team create sent to it would land as the person's own
 * epic.
 */
export const EPIC_CREATE_TEAM_OWNER_MINOR = 3;

/** Verbatim: the host predates `epic.create@1.3`. */
export const TEAM_CREATE_HOST_TOO_OLD =
  "This host can't create team tasks yet. Update the host, or choose Personal.";

/** Verbatim: the cloud refused a team create (`FORBIDDEN`). */
export function teamCreateForbiddenLine(slug: string): string {
  return `You're not a member of ${slug}.`;
}

/**
 * The floor a create pays before any frame: a team owner requires
 * `epic.create@1.3`, which is also above the local-first floor; otherwise the
 * local-first floor for a session with no cloud verdict, and none for a
 * signed-in one.
 */
export function epicCreateFloor(input: {
  readonly owner: EpicCreateOwner | null;
  readonly cloudAuthorized: boolean;
}): RequiredHostMethodVersion | null {
  if (input.owner?.kind === "team") {
    return {
      method: "epic.create",
      version: { major: 1, minor: EPIC_CREATE_TEAM_OWNER_MINOR },
    };
  }
  if (input.cloudAuthorized) return null;
  return {
    method: "epic.create",
    version: { major: 1, minor: EPIC_CREATE_LOCAL_FIRST_MINOR },
  };
}

/**
 * What a rejected team create says, or `null` to leave the error to the
 * generic toast: the transport's `@1.3` floor refusal, and the cloud's
 * `FORBIDDEN` keyed on the code alone, never on the message.
 */
export function teamCreateRejectionMessage(
  error: unknown,
  teamSlug: string | null,
): string | null {
  if (error instanceof HostMethodVersionUnsatisfiedError) {
    return error.requirement.method === "epic.create" &&
      error.requirement.version.minor >= EPIC_CREATE_TEAM_OWNER_MINOR
      ? TEAM_CREATE_HOST_TOO_OLD
      : null;
  }
  if (
    error instanceof HostRpcError &&
    error.code === "FORBIDDEN" &&
    teamSlug !== null
  ) {
    return teamCreateForbiddenLine(teamSlug);
  }
  return null;
}
