import type { SandboxRouteReadiness } from "@traycer/protocol/host/sandbox-control";
import {
  SANDBOX_GRANT_MODE_BROKERED,
  SANDBOX_GRANT_MODE_EXPOSED,
  SANDBOX_ROUTE_UNREADY_CONNECTOR_OFFLINE,
  type SandboxGitHubAccess,
  type SandboxGrant,
  type SandboxGrantsSummary,
} from "@traycer/protocol/host/sandbox-secrets";
import { sandboxEgressRefusalCopyFor } from "@/lib/sandboxes/sandbox-egress-refusal-copy";
import {
  grantRotationLine,
  type SecretRotationLine,
} from "@/lib/sandboxes/secret-rotation-line";

/**
 * The sandbox card's secrets summary: each secret the sandbox may use, how it
 * holds it, and for a brokered one each destination with where that route
 * stands. Two reads joined by route id - the broker's grants summary (what is
 * granted) and the sandbox row's per-route readiness (what its host last
 * reported) - kept free of React so the join is read and tested in one place.
 */
export interface SandboxGrantRouteView {
  readonly route: string;
  /** "db.internal:5432", or the bare host when the broker names no port. */
  readonly address: string;
  /**
   * `null` when the sandbox has reported nothing for this route: asleep, a
   * server from before the field, a route bound since its last heartbeat, or
   * a host that no longer vouches for its reports (`sandboxHostVouches`).
   * Shown as no state at all, never as ready.
   */
  readonly readiness: "pending" | "ready" | "unavailable" | null;
  readonly readinessText: string | null;
}

export interface SandboxGrantView {
  readonly secretName: string;
  /** "postgres · brokered", "https · exposed, readable on the sandbox". */
  readonly modeLine: string;
  readonly exposed: boolean;
  /** "through connector office-vpc", or `null`. */
  readonly via: string | null;
  /** Why this sandbox has it, or `null` for a source this build has no word for. */
  readonly source: string | null;
  readonly routes: readonly SandboxGrantRouteView[];
  /**
   * A replaced value's progress on this sandbox: "New value accepted, closing
   * old sessions.", then "New value enforced: postgres, 3 sessions closed."
   * `null` when the grant has no rotation.
   */
  readonly rotation: SecretRotationLine | null;
}

/**
 * The card's one clause about what an agent sees: for a brokered secret, a
 * stand-in, with the real value attached as a request leaves the sandbox.
 */
export const SANDBOX_STAND_IN_CLAUSE =
  "Agents here see a stand-in for each brokered secret; the real value is attached as a request leaves the sandbox.";

/** Whether the card says the stand-in clause: any brokered grant. */
export function sandboxHasBrokeredGrant(
  summary: SandboxGrantsSummary,
): boolean {
  return summary.grants.some(
    (grant) => grant.mode === SANDBOX_GRANT_MODE_BROKERED,
  );
}

const SOURCE_WORDS: Readonly<Record<string, string>> = {
  default: "granted to every sandbox",
  inherited: "inherited from the sandbox that created this one",
  approved: "approved for this sandbox",
};

function modeWords(mode: string): string {
  if (mode === SANDBOX_GRANT_MODE_BROKERED) return "brokered";
  if (mode === SANDBOX_GRANT_MODE_EXPOSED) {
    return "exposed, readable on the sandbox";
  }
  return mode;
}

function addressOf(destination: string, port: number | null): string {
  return port === null ? destination : `${destination}:${port}`;
}

function unreadyText(grant: SandboxGrant, unready: string): string {
  if (unready !== SANDBOX_ROUTE_UNREADY_CONNECTOR_OFFLINE) return "unavailable";
  return grant.connectorName === null
    ? "connector offline"
    : `connector ${grant.connectorName} offline`;
}

function routeView(
  grant: SandboxGrant,
  route: SandboxGrant["routes"][number],
  readinessByRoute: ReadonlyMap<string, SandboxRouteReadiness>,
): SandboxGrantRouteView {
  const address = addressOf(route.destination, route.port);
  // What the broker knows comes first: a route it says cannot be used is not
  // ready, whatever the sandbox last reported for it.
  if (route.unready !== null) {
    return {
      route: route.route,
      address,
      readiness: "unavailable",
      readinessText: unreadyText(grant, route.unready),
    };
  }
  const reported = readinessByRoute.get(route.route) ?? null;
  if (reported === null) {
    return {
      route: route.route,
      address,
      readiness: null,
      readinessText: null,
    };
  }
  if (reported.state === "ready") {
    return {
      route: route.route,
      address,
      readiness: "ready",
      readinessText: "ready",
    };
  }
  if (reported.state === "pending") {
    return {
      route: route.route,
      address,
      readiness: "pending",
      readinessText: "not used yet",
    };
  }
  const copy =
    reported.code === null
      ? null
      : sandboxEgressRefusalCopyFor(reported.code, {
          secret: grant.secretName,
          host: route.destination,
          protocol: grant.protocol,
        });
  return {
    route: route.route,
    address,
    readiness: "unavailable",
    readinessText: copy === null ? "unavailable" : copy.headline,
  };
}

export function sandboxGrantViews(
  summary: SandboxGrantsSummary,
  routes: readonly SandboxRouteReadiness[] | null,
): readonly SandboxGrantView[] {
  const readinessByRoute = new Map(
    (routes ?? []).map((route) => [route.route, route]),
  );
  return summary.grants.map((grant) => ({
    secretName: grant.secretName,
    modeLine:
      grant.protocol.length === 0
        ? modeWords(grant.mode)
        : `${grant.protocol} · ${modeWords(grant.mode)}`,
    exposed: grant.mode === SANDBOX_GRANT_MODE_EXPOSED,
    via:
      grant.connectorName === null
        ? null
        : `through connector ${grant.connectorName}`,
    source: Object.hasOwn(SOURCE_WORDS, grant.source)
      ? SOURCE_WORDS[grant.source]
      : null,
    routes: grant.routes.map((route) =>
      routeView(grant, route, readinessByRoute),
    ),
    rotation: grantRotationLine(grant.rotation),
  }));
}

/**
 * Each route's destination, so a typed egress event - which names a route id -
 * can say where it was headed.
 */
export function sandboxRouteAddresses(
  summary: SandboxGrantsSummary | null,
): ReadonlyMap<string, string> {
  const addresses = new Map<string, string>();
  if (summary === null) return addresses;
  for (const grant of summary.grants) {
    for (const route of grant.routes) {
      addresses.set(route.route, addressOf(route.destination, route.port));
    }
  }
  return addresses;
}

/** What git on the sandbox reaches through the Traycer GitHub App, in a line. */
export function sandboxGitHubLine(github: SandboxGitHubAccess): string {
  if (!github.linked) {
    return "GitHub: not linked. Git on this sandbox can't reach your repositories.";
  }
  if (github.installations.length === 0) {
    return "GitHub: linked, with the Traycer App installed nowhere yet.";
  }
  const accounts = github.installations
    .map((installation) =>
      installation.repositorySelection === "selected"
        ? `${installation.account} (selected repositories)`
        : installation.account,
    )
    .join(", ");
  return `GitHub: ${accounts}`;
}
