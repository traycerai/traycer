import { scrubSentryEventInPlace } from "@traycer-clients/shared/platform/sentry-scrub";
import { z } from "zod";
import type { OfferedIds } from "../../miss-report";

const filedMissSchema = z.object({
  message: z.string(),
  options: z.object({
    level: z.string(),
    tags: z.record(z.string(), z.string()),
    fingerprint: z.array(z.string()),
    extra: z.record(z.string(), z.unknown()),
  }),
});

/** No id offered: every id an answer names is the model's own. */
export const NO_OFFERED_IDS: OfferedIds = {
  environmentIds: new Set(),
  botIds: new Set(),
  threadIds: new Set(),
  itemIds: new Set(),
  agentIds: new Set(),
};

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

/** The one event filed through a mocked `captureMessage`; a test fails if there was not exactly one. */
export function onlyMiss(
  calls: ReadonlyArray<ReadonlyArray<unknown>>,
): FiledMiss {
  const filed = filedMisses(calls);
  if (filed.length !== 1) {
    throw new Error(`expected one event to be filed, got ${filed.length}`);
  }
  return filed[0];
}

/**
 * The events as they leave the app: each one through the real Sentry scrubber,
 * serialized, so a test can look for anything that should not be in it.
 */
export function scrubbedMisses(
  calls: ReadonlyArray<ReadonlyArray<unknown>>,
): ReadonlyArray<string> {
  return filedMisses(calls).map((miss) => {
    const event = structuredClone({
      message: miss.message,
      tags: miss.options.tags,
      extra: miss.options.extra,
    });
    scrubSentryEventInPlace(event);
    return JSON.stringify(event);
  });
}
