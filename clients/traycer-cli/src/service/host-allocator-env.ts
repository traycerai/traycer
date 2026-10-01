// The allocator setting the long-running host process is created with on
// macOS: `MallocLargeCache=0`, which turns off libmalloc's cache of freed
// large blocks.
//
// libmalloc keeps a freed LARGE block (one past its medium size classes)
// resident and dirty for reuse, and purges that cache only under system memory
// pressure. Freed memory held that way still counts in the process footprint -
// the number Activity Monitor shows - and the host frees large blocks all day
// (encode and snapshot buffers, search work, long transcript strings). On the
// staging host, after a forced full GC, `vmmap` showed 506 MB of
// "Malloc Large (empty)" regions against 22 MB of live large blocks, and the
// category swung between 13 and 846 MB within minutes. A local repro that frees
// 32 buffers of 16 MiB keeps 512 MB of footprint without the variable and
// 22 MB with it. The cost is the cache's purpose: the next allocation of a
// freed size pays fresh zero-fill page faults instead of reusing the block.
//
// Applied in `host-start.ts` to the host's spawn env, the one launch path every
// macOS host passes through: the CLI's LaunchAgent and the desktop app's both
// run `traycer host start`. It is a creation-time setting - libmalloc reads it
// once, while the process starts - so it cannot be applied later from inside
// the host. The host deletes it from its own `process.env` at its first line
// (`main-sea.ts`): the host keeps the effect, and no child it spawns - provider
// CLIs, shells, git, terminals - inherits it, the same boundary
// `host-node-options.ts` keeps for NODE_OPTIONS.
//
// A value already in the env wins, so an operator can turn the cache back on
// (`MallocLargeCache=1`) through the host env overrides without a rebuild.
// No other platform reads the variable, so nothing is set there.
export const MALLOC_LARGE_CACHE_ENV = "MallocLargeCache";

export function applyHostAllocatorEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): void {
  if (platform !== "darwin") return;
  if (env[MALLOC_LARGE_CACHE_ENV] !== undefined) return;
  env[MALLOC_LARGE_CACHE_ENV] = "0";
}
