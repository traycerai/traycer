import { describe, expect, it } from "vitest";
import {
  applyHostAllocatorEnv,
  MALLOC_ARENA_MAX_ENV,
  MALLOC_LARGE_CACHE_ENV,
} from "../host-allocator-env";

describe("applyHostAllocatorEnv", () => {
  it("sets MallocLargeCache=0 on darwin when the key is absent", () => {
    const env: NodeJS.ProcessEnv = {};
    applyHostAllocatorEnv(env, "darwin");
    expect(env[MALLOC_LARGE_CACHE_ENV]).toBe("0");
  });

  it('keeps an existing darwin value of "1"', () => {
    const env: NodeJS.ProcessEnv = { [MALLOC_LARGE_CACHE_ENV]: "1" };
    applyHostAllocatorEnv(env, "darwin");
    expect(env[MALLOC_LARGE_CACHE_ENV]).toBe("1");
  });

  it('keeps an existing darwin value of ""', () => {
    const env: NodeJS.ProcessEnv = { [MALLOC_LARGE_CACHE_ENV]: "" };
    applyHostAllocatorEnv(env, "darwin");
    expect(env[MALLOC_LARGE_CACHE_ENV]).toBe("");
  });

  it("sets MALLOC_ARENA_MAX=2 on linux when the key is absent", () => {
    const env: NodeJS.ProcessEnv = {};
    applyHostAllocatorEnv(env, "linux");
    expect(env[MALLOC_ARENA_MAX_ENV]).toBe("2");
  });

  it('keeps an existing linux value of "8"', () => {
    const env: NodeJS.ProcessEnv = { [MALLOC_ARENA_MAX_ENV]: "8" };
    applyHostAllocatorEnv(env, "linux");
    expect(env[MALLOC_ARENA_MAX_ENV]).toBe("8");
  });

  it('keeps an existing linux value of ""', () => {
    const env: NodeJS.ProcessEnv = { [MALLOC_ARENA_MAX_ENV]: "" };
    applyHostAllocatorEnv(env, "linux");
    expect(env[MALLOC_ARENA_MAX_ENV]).toBe("");
  });

  // Each allocator reads only its own platform's variable, and the host
  // deletes both unconditionally, so setting the other platform's on a host
  // would be a variable nothing reads travelling to every child until the
  // host dropped it.
  it("sets each platform's own variable and never the other's", () => {
    const darwin: NodeJS.ProcessEnv = {};
    applyHostAllocatorEnv(darwin, "darwin");
    expect(MALLOC_ARENA_MAX_ENV in darwin).toBe(false);

    const linux: NodeJS.ProcessEnv = {};
    applyHostAllocatorEnv(linux, "linux");
    expect(MALLOC_LARGE_CACHE_ENV in linux).toBe(false);
  });

  it("adds neither key on win32", () => {
    const env: NodeJS.ProcessEnv = {};
    applyHostAllocatorEnv(env, "win32");
    expect(MALLOC_LARGE_CACHE_ENV in env).toBe(false);
    expect(MALLOC_ARENA_MAX_ENV in env).toBe(false);
  });

  it("leaves other keys untouched", () => {
    const env: NodeJS.ProcessEnv = { OTHER_KEY: "kept" };
    applyHostAllocatorEnv(env, "darwin");
    expect(env.OTHER_KEY).toBe("kept");
  });
});
