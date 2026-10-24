// The allocator settings the long-running host process is created with, one
// per platform's allocator: `MallocLargeCache=0` on macOS, which turns off
// libmalloc's cache of freed large blocks, and `MALLOC_ARENA_MAX=2` on Linux,
// which stops glibc opening an arena per contending thread.
//
// ## macOS: `MallocLargeCache=0`
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
// ## Linux: `MALLOC_ARENA_MAX=2`
//
// glibc gives a contending thread its own arena and keeps the chunks it frees
// resident. Behind the host's 96-thread libuv pool that is 12 arena heaps: an
// idle host on the shipped 1 vCPU / 1 GiB sandbox shape held 97.7 MB of glibc
// mappings inside a 367 MB floor, and with the maximum at 2 it holds 63.6 MB
// in 5 heaps - idle `VmRSS` 34 MB lower and `VmHWM` 36 MB lower, with the V8
// pages and all 107 threads unchanged (measured on two guests). What it costs
// is the arenas' purpose, the mirror of the macOS trade above: threads that
// would each have taken an arena now contend for two. It is not a cap on the
// pool, which keeps all 96 threads, and nothing is budgeted or paced.
//
// A host the sandbox image launches gets this from the image instead - its
// systemd unit and its entrypoint supervisor, which execs the host under
// `env -i` - because neither goes through `traycer host start`. This is the
// branch for the Linux hosts that DO: a personal host under the CLI's systemd
// user unit. The host deletes this variable from its own `process.env` at the
// same first line, so the boundary is identical.
//
// A value already in the env wins on both platforms, so an operator can turn
// the cache back on (`MallocLargeCache=1`) or choose another arena maximum
// through the host env overrides without a rebuild. Each allocator reads only
// its own variable, so neither is set on a platform that would ignore it.
export const MALLOC_LARGE_CACHE_ENV = "MallocLargeCache";
export const MALLOC_ARENA_MAX_ENV = "MALLOC_ARENA_MAX";

export function applyHostAllocatorEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): void {
  if (platform === "darwin") {
    if (env[MALLOC_LARGE_CACHE_ENV] !== undefined) return;
    env[MALLOC_LARGE_CACHE_ENV] = "0";
    return;
  }
  if (platform === "linux") {
    if (env[MALLOC_ARENA_MAX_ENV] !== undefined) return;
    env[MALLOC_ARENA_MAX_ENV] = "2";
  }
}
