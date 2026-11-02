import { z } from "zod";

const filedMissSchema = z.object({
  message: z.string(),
  options: z.object({
    level: z.string(),
    tags: z.record(z.string(), z.string()),
    fingerprint: z.array(z.string()),
    extra: z.record(z.string(), z.unknown()),
  }),
});

/** One `captureMessage` call, read back typed. */
export type FiledMiss = z.infer<typeof filedMissSchema>;

/** The events filed through a mocked `captureMessage`, from its recorded calls. */
export function filedMisses(
  calls: ReadonlyArray<ReadonlyArray<unknown>>,
): ReadonlyArray<FiledMiss> {
  return calls.map(([message, options]) =>
    filedMissSchema.parse({ message, options }),
  );
}
