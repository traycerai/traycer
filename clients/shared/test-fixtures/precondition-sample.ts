/**
 * How many times {@link samplePrecondition} calls its sampler before giving
 * up. Exported so call sites pass it explicitly rather than relying on a
 * default parameter.
 */
export const PRECONDITION_SAMPLE_ATTEMPTS = 3;

/**
 * Retries a PRECONDITION sample: a scaffolding read a real-Windows test takes
 * to set up or locate the thing it is about to watch (a "before" baseline
 * table, a just-spawned process's ground-truth creation time, a denied-read
 * candidate) - never the read whose result a test's own assertion is about.
 *
 * A cold `powershell.exe` invocation can occasionally exceed the production
 * sampler's own timeout on a loaded CI runner, well before the behaviour
 * under test has even started; one CI failure was exactly this, on the very
 * first sample of a test, before anything had been spawned. Retrying a
 * handful of times here is cheaper than a red suite over that noise.
 *
 * No delay between attempts: each attempt already carries its own bound (the
 * production sampler's own timeout). A sampler that THROWS is never
 * retried - that rejection propagates immediately, unretried, since a throw
 * is not the "no result yet" case this helper exists to absorb.
 */
export async function samplePrecondition<T>(
  precondition: string,
  attempts: number,
  sample: () => Promise<T | null>,
): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await sample();
    if (result !== null) return result;
  }
  throw new Error(
    `precondition "${precondition}" returned no result after ${String(attempts)} attempts`,
  );
}
