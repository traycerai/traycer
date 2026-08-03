/**
 * Ticket 21: the single centralized switch gating whether
 * `StableTileSurfaceHost` mounts inside `TopLevelTabHost` at all.
 *
 * Enabled since slice 6, after the full recorded dev-desktop gate cleared
 * (lifecycle matrix, geometry/stacking/hit-testing, focus/selection/IME
 * survival, DnD, the divider-drag re-drive, and the integrated operation
 * pass - see the wave-2 live-pass evidence in the epic artifacts). Selected
 * chat bodies render once in the fixed surface plane and never remount on
 * structural canvas operations; a tab switch remains the only intentional
 * remount (decision #17).
 *
 * This constant is also the ROLLBACK lever: setting it back to `false`
 * returns selected chats to the inline pane path in one line. The ticket-20
 * viewport handoff stays installed as the absorber for that one controlled
 * remount, per the design's rollback contract. Any surface-host code change
 * after enablement requires re-recording the live gate (decision #32).
 *
 * One export, one call site (`top-level-tab-host.tsx`). Do not gate any
 * other surface-host module on this - membership and the environment
 * registry (slice 2) are always live; only the host's own mount is gated.
 */
export const STABLE_TILE_SURFACE_HOST_ENABLED: boolean = true;
