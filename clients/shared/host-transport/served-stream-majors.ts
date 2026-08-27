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
 * An entry describes what the client CONSTRUCTS, not which classes exist in
 * the package. `EpicV2StreamClient` is written and tested; it is not wired
 * into any production factory, so it is not served. Deleting an entry is how
 * a major becomes advertised, so the change that wires an implementation up
 * is the same change that removes its restriction - there is no separate flag
 * to remember, and no way to ship the client half while still declaring it
 * absent.
 *
 * A method omitted here advertises every installed major, which is the right
 * default: the overwhelmingly common case is one client implementation
 * covering the whole line.
 */
export const CLIENT_SERVED_STREAM_MAJORS: ServedMajorsByMethod = {
  /**
   * `@1` only. `epic-session-provider.tsx` constructs `EpicStreamClient`
   * unconditionally, and that client speaks the `@1` frame set - root Y.Doc
   * updates plus artifact-room fan-out.
   *
   * `@2` (typed metadata frames plus explicit per-artifact body attaches) has
   * a host resolver and an `EpicV2StreamClient`, but nothing in the renderer
   * constructs it: consuming `@2` means the store projects from typed rows
   * rather than from a doc replica, which is the GUI store rework. Until that
   * lands, a client that advertised `@2` would negotiate it and then receive
   * an `epicStateSnapshot` it drops on the floor, so an epic would never
   * seed.
   *
   * Remove this entry in the change that wires `EpicV2StreamClient` into the
   * session factory - not before, and not separately.
   */
  "epic.subscribe": [1],
  // `satisfies` pins every key to a REGISTRY stream method name: a registry
  // rename would otherwise leave a stale key behind, `buildStreamManifest`
  // would look the renamed method up as absent, and the restriction this
  // file exists for would silently lift - every installed major advertised.
} satisfies Partial<
  Readonly<Record<keyof HostStreamRpcRegistry, readonly number[]>>
>;
