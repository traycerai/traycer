/**
 * Ticket 21 slice 3: the single centralized switch gating whether
 * `StableTileSurfaceHost` mounts inside `TopLevelTabHost` at all.
 *
 * Off by construction until slice 6 flips it: nothing publishes a real
 * `ReadyTileSurfaceEnvironment` in production yet (chat routing is slice 4),
 * so the plane would stay empty either way, but the switch keeps its DOM
 * subtree - the plane div, the shared `ResizeObserver`, the membership
 * subscription - entirely absent from the render tree until rollout, rather
 * than relying on "nothing publishes to it" as the only safeguard.
 *
 * One export, one call site (`top-level-tab-host.tsx`). Do not gate any
 * other surface-host module on this - membership and the environment
 * registry (slice 2) are always live; only the host's own mount is gated.
 */
export const STABLE_TILE_SURFACE_HOST_ENABLED: boolean = false;
