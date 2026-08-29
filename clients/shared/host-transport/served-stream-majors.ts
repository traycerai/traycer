import type { ServedMajorsByMethod } from "@traycer/protocol/framework/capability-manifest";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";

/**
 * The stream majors THIS CLIENT can actually serve, per method.
 *
 * Both peers import the same `@traycer/protocol` registry, so without this a
 * client advertises every major the registry INSTALLS - including majors whose
 * client half has not been written. The handshake then selects the highest
 * shared major, the host serves it, and the client cannot read the frames.
 * Installing a contract would be, by itself, a breaking behaviour change.
 *
 * The host has the mirror-image concept one level coarser in
 * `ws-connection-handler.ts`'s `deriveHostManifest`, which advertises only the
 * methods it has a resolver for, and for exactly this reason.
 *
 * ## How to keep this honest
 *
 * An entry describes what the client CONSTRUCTS, not which majors the registry
 * installs. Deleting an entry is how a major becomes advertised, so the change
 * that wires an implementation up is the same change that removes its
 * restriction - there is no separate flag to remember, and no way to ship the
 * client half while still declaring it absent.
 *
 * A method omitted here advertises every installed major, which is the right
 * default: the overwhelmingly common case is one client implementation
 * covering the whole line.
 */
export const CLIENT_SERVED_STREAM_MAJORS: ServedMajorsByMethod = {
  /**
   * `@1` only, PERMANENTLY - this entry no longer holds anything back.
   *
   * It began as a temporary hold on an unimplemented client half: `@2` was
   * installed in the registry, host-served, and had a client wrapper that
   * nothing in the renderer constructed, so advertising it would have
   * negotiated a frame set the GUI dropped on the floor. `@2` has since been
   * RETIRED unreleased - its schemas, its host resolver and its client wrapper
   * are all deleted, and its planes were inherited by `epic.state.subscribe`,
   * `epic.status.subscribe` and `artifact.subscribe`, which are separate
   * METHODS on their own `@1` lines rather than a major of this one.
   *
   * So with one installed major left this pin has nothing to remove: it is the
   * ordinary shape of a method whose whole line the client serves. Keep it
   * anyway, because the alternative is an omitted method that would silently
   * advertise whatever major a future reader installs here - and this method's
   * frozen `@1.0`-`@1.3` line is exactly the one the host keeps serving
   * indefinitely for GUIs that have not updated.
   */
  "epic.subscribe": [1],
  // `satisfies` pins every key to a REGISTRY stream method name: a registry
  // rename would otherwise leave a stale key behind, `buildStreamManifest`
  // would look the renamed method up as absent, and the restriction this
  // file exists for would silently lift - every installed major advertised.
} satisfies Partial<
  Readonly<Record<keyof HostStreamRpcRegistry, readonly number[]>>
>;
