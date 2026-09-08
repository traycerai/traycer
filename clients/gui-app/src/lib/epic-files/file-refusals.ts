/**
 * What a drop-zone refusal (D12) looks like to a rendering surface. Its own
 * module so the shape does not live inside the hook that streams it - see
 * `hooks/epic/use-epic-file-refusals.ts` and
 * `lib/epic-files/file-events-store.ts`.
 */
import type { EpicFileRefusalReason } from "@traycer/protocol/host/epic/files";

export interface EpicFileRefusal {
  /** Stable key for the row, minted per received frame. */
  readonly id: string;
  /** The name the user dropped, epic-root-relative or bare. Never a user id. */
  readonly name: string;
  /** Why it was refused, phrased for display. */
  readonly reason: string;
}

/**
 * The wire reason as a sentence that reads after the file name, both in the
 * panel's list (`<name> <reason>`) and in the toast's body.
 *
 * The copy lives here rather than on the host: the reason set is a CLOSED wire
 * enum the client branches on, so the words are the client's to choose - and
 * an older GUI against a newer host would otherwise render a sentence it has
 * no layout for. No user id in any of it (D31): a refusal names the file,
 * never who dropped it.
 */
export const EPIC_FILE_REFUSAL_COPY: Readonly<
  Record<EpicFileRefusalReason, string>
> = {
  "secret-shaped": "wasn't added - the name looks like a secret.",
  "too-large": "wasn't added - it is over the per-file size limit.",
  "rate-limited": "wasn't added - this epic hit its hourly drop-zone limit.",
  "not-a-regular-file": "wasn't added - only real files are stored, not links.",
};

/** One shared "nothing refused" reference, so the quiet case never re-renders. */
export const EMPTY_FILE_REFUSALS: readonly EpicFileRefusal[] = Object.freeze(
  [],
);
