import { describe, expect, it } from "vitest";
import {
  applyHostAllocatorEnv,
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

  it("adds no key on linux", () => {
    const env: NodeJS.ProcessEnv = {};
    applyHostAllocatorEnv(env, "linux");
    expect(MALLOC_LARGE_CACHE_ENV in env).toBe(false);
  });

  it("adds no key on win32", () => {
    const env: NodeJS.ProcessEnv = {};
    applyHostAllocatorEnv(env, "win32");
    expect(MALLOC_LARGE_CACHE_ENV in env).toBe(false);
  });

  it("leaves other keys untouched", () => {
    const env: NodeJS.ProcessEnv = { OTHER_KEY: "kept" };
    applyHostAllocatorEnv(env, "darwin");
    expect(env.OTHER_KEY).toBe("kept");
  });
});
