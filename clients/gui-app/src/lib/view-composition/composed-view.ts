import { canonicalForMethodVersionLine } from "@traycer/protocol/framework/compat-helpers";
import type { ManifestRegistry } from "@traycer/protocol/framework/capability-manifest";
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";

/**
 * One source of a composed view: a serving tier's answer, or a host's local
 * arm, named by the RPC that delivers it.
 *
 * A contributor's rows reach a composer only as that RPC's CLIENT-CANONICAL
 * DTO: the transport upgrades every response and frame along the method's
 * registered upgrade chain (its bridges) before any caller sees it. That is
 * what lets two peers on different minors be composed with no lowest-minor
 * rule - and it holds only for a method the registry carries a line for.
 */
export interface ComposedViewContributor {
  readonly id: string;
  readonly kind: "unary" | "stream";
  readonly method: string;
}

export interface ComposedView {
  readonly view: string;
  readonly contributors: readonly ComposedViewContributor[];
}

const UNARY_LINES: ManifestRegistry = hostRpcRegistry;
const STREAM_LINES: ManifestRegistry = hostStreamRpcRegistry;

/**
 * Declares a composed view and asserts, at module load, that every
 * contributor is a registered bridge: its method has a version line in the
 * registry of its kind, so its answers arrive upgraded to this client's
 * canonical shape. A contributor outside the registry would hand the composer
 * bytes no bridge has normalized, so it fails here rather than at the first
 * page it mis-composes.
 */
export function defineComposedView(
  view: string,
  contributors: readonly ComposedViewContributor[],
): ComposedView {
  const ids = new Set<string>();
  for (const contributor of contributors) {
    if (ids.has(contributor.id)) {
      throw new Error(
        `${view}: contributor ${contributor.id} is declared twice`,
      );
    }
    ids.add(contributor.id);
    const lines = contributor.kind === "unary" ? UNARY_LINES : STREAM_LINES;
    if (!Object.hasOwn(lines, contributor.method)) {
      throw new Error(
        `${view}: contributor ${contributor.id} (${contributor.method}) is not a registered bridge`,
      );
    }
    // Throws for a line with no installed version, which no bridge can reach.
    canonicalForMethodVersionLine(
      lines[contributor.method],
      contributor.method,
    );
  }
  return Object.freeze({
    view,
    contributors: Object.freeze([...contributors]),
  });
}

const ROLE_RANK: Readonly<Record<PermissionRole, number>> = {
  viewer: 0,
  editor: 1,
  owner: 2,
};

/**
 * The affordance two contributors agree on: the lesser role. A row both
 * contributors describe is shown with what BOTH would allow, so neither
 * contributor's wider claim enables a control the other would refuse.
 */
export function intersectRole(
  left: PermissionRole,
  right: PermissionRole,
): PermissionRole {
  return ROLE_RANK[left] <= ROLE_RANK[right] ? left : right;
}
