import { describe, expect, it, vi } from "vitest";

import {
  PRECONDITION_SAMPLE_ATTEMPTS,
  samplePrecondition,
} from "../precondition-sample";

/**
 * Cross-platform pins for the retry loop itself, with an injected sampler -
 * no real Windows process table involved. The call-count assertions are the
 * point: they are what proves the loop stops retrying the moment it has a
 * result, and never retries a throw at all.
 */
describe("samplePrecondition", () => {
  it("resolves to the first non-null result, retrying through leading nulls", async () => {
    const table = { rows: ["a"] };
    const sample = vi
      .fn<() => Promise<{ rows: string[] } | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(table);

    await expect(
      samplePrecondition(
        "windows process table",
        PRECONDITION_SAMPLE_ATTEMPTS,
        sample,
      ),
    ).resolves.toBe(table);
    expect(sample).toHaveBeenCalledTimes(3);
  });

  it("rejects with the named precondition and the attempt count once every attempt returns null", async () => {
    const sample = vi.fn<() => Promise<null>>().mockResolvedValue(null);

    await expect(
      samplePrecondition(
        "windows process table",
        PRECONDITION_SAMPLE_ATTEMPTS,
        sample,
      ),
    ).rejects.toThrow(
      'precondition "windows process table" returned no result after 3 attempts',
    );
    expect(sample).toHaveBeenCalledTimes(3);
  });

  it("resolves on the first call and never retries when the sampler already has a result", async () => {
    const table = { rows: ["a"] };
    const sample = vi
      .fn<() => Promise<{ rows: string[] } | null>>()
      .mockResolvedValue(table);

    await expect(
      samplePrecondition(
        "windows process table",
        PRECONDITION_SAMPLE_ATTEMPTS,
        sample,
      ),
    ).resolves.toBe(table);
    expect(sample).toHaveBeenCalledTimes(1);
  });

  it("propagates a thrown error unretried - a throw is not the 'no result yet' case", async () => {
    const failure = new Error("powershell.exe exited 1");
    const sample = vi.fn<() => Promise<null>>().mockRejectedValue(failure);

    await expect(
      samplePrecondition(
        "windows process table",
        PRECONDITION_SAMPLE_ATTEMPTS,
        sample,
      ),
    ).rejects.toBe(failure);
    expect(sample).toHaveBeenCalledTimes(1);
  });
});
