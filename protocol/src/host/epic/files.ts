import { z } from "zod";

import { defineStreamRpcContract } from "@traycer/protocol/framework/versioned-stream-rpc";
import { epicLaneTextFrameFields } from "@traycer/protocol/host/epic/lane-cursor";
import {
  isEpicFilePath,
  SHA256_HEX,
} from "@traycer/protocol/persistence/epic/files";

/**
 * Host <-> client wire shapes for the EPIC FILE plane: reading one file's
 * bytes, tombstoning and restoring an entry, opening one in a browser tab,
 * capturing a tab, recording a tab, and the one stream that carries what the
 * manifest cannot.
 *
 * ## Why there is no list method
 *
 * The manifest is a sibling `Y.Map` on the epic root doc
 * (`persistence/epic/files.ts`), and every client that can render a file
 * already replicates that doc. A `listFiles` RPC would be a second, weaker
 * projection of a table the GUI holds locally - stale the moment a peer writes
 * an entry, and racing the doc's own observer for who renders first. Everything
 * here is therefore a VERB against one already-known entry, never a directory
 * read.
 *
 * ## Bytes are not on this wire
 *
 * `epic.readFile` answers with an ADDRESS, never a payload. Files run to
 * 512 MiB (`EPIC_FILE_MAX_BYTES`) and video needs `Range`; both are things the
 * RPC channel is the wrong shape for. The three success arms are the three
 * byte planes that already exist - the 20 MiB asset stream, the loopback static
 * server, and a signed cloud URL the GUI's own `<img>`/`<video>` fetches - and
 * choosing between them is the host's job because only the host knows where the
 * bytes actually are.
 *
 * ## Optional capability, every method
 *
 * Each method is registered `degrade: { kind: "unsupported" }` and NEVER on the
 * released floor - a new method NAME is handshake-fatal against a released
 * peer. A host that predates this plane answers `E_HOST_UNSUPPORTED`, and the
 * client's contract is to hide the surface: there is no file plane on such a
 * host, so there is no degraded rendering to show, only an absent one. In the
 * other direction a new host talking to an old GUI is simply never called.
 */

/** Lowercase hex sha256, the same pattern the manifest writer validates with. */
const sha256HexSchema = z.string().regex(SHA256_HEX);

/**
 * A manifest key, validated with the SAME predicate the manifest writer uses,
 * so a request can never address something the manifest could not hold - a
 * traversal, an absolute path, the `.file-staging/` sibling, or the host's own
 * `files/.index.md` projection. The host still re-derives its own on-disk path;
 * this is the wire's share of that containment, not a substitute for it.
 */
const epicFilePathSchema = z
  .string()
  .refine(isEpicFilePath, { message: "not an epic-file manifest path" });

/** The epic is the authorization subject; the path alone is never a capability. */
const epicFileTargetFields = {
  epicId: z.string().min(1),
  path: epicFilePathSchema,
} as const;

/**
 * `path` + `sha256` together, not `path` alone: objects are immutable and
 * content-addressed, so overwriting a path mints a new object and pushes the
 * old one into `versions[]`. Asking for a bare path would race that move and
 * hand back whichever object won; naming the sha is what makes a `path@sha`
 * link keep meaning after the path has moved on.
 *
 * `coLocatedHostId` is the caller's declared vantage, the same shape and the
 * same rule as `electronTabLifecycleReady.coLocatedHostId` on
 * `browser.sessions`: the GUI states which host it believes it shares a machine
 * with, `null` means "none I can name", and the answering host compares it
 * against its OWN id. It is a PLACEMENT FACT, never an authorization - a wrong
 * value costs the caller a signed URL instead of a loopback one, and can never
 * widen what it may read (the epic permission check is the whole gate, D06).
 */
export const readEpicFileRequestSchema = z.object({
  ...epicFileTargetFields,
  sha256: sha256HexSchema,
  coLocatedHostId: z.string().nullable(),
});
export type ReadEpicFileRequest = z.infer<typeof readEpicFileRequestSchema>;

/**
 * Why the bytes are not obtainable, as DATA rather than a throw - these are
 * settled states of a file, not failures of the call.
 *
 * Unlike `epic.readChatAttachment`, which collapses every miss into one
 * `missing` arm, these stay distinct: chat attachments answer across a privacy
 * boundary where a distinguishable refusal would be an existence oracle, while
 * epic files are task-scoped (D06) - anyone who may ask may already see the
 * manifest entry, including its `status` and `deletedAt`. Nothing is disclosed
 * by naming the state, and the GUI's copy differs per state ("uploading",
 * "no longer available", "kept on the device that made it").
 *
 * A transient failure is NOT one of these. A dropped socket, a cloud 5xx, an
 * unreadable disk ride the RPC error channel and throw, so a client retries
 * them instead of caching a permanent "unavailable" for bytes that are one good
 * request away.
 *
 * Closed on purpose: a client BRANCHES on this value, so an unknown one has no
 * rendering. Growing it is an additive MINOR on this method, not an edit.
 */
export const epicFileUnavailableReasonSchema = z.enum([
  /** No entry for that `(path, sha256)` - never written, or compacted away. */
  "missing",
  /** Tombstoned (D25). The cloud object may still exist; the entry says no. */
  "deleted",
  /** `status: "pending"` and the caller is not co-located with the bytes. */
  "upload-pending",
  /** `status: "failed"` or `"local-only"` - only the producing host has these. */
  "upload-unavailable",
]);
export type EpicFileUnavailableReason = z.infer<
  typeof epicFileUnavailableReasonSchema
>;

/**
 * Where to get the bytes, decided host-side (D10).
 *
 * - `loopback` - on the answering host's disk and the caller shares its
 *   machine, so the D32 static server serves it over `127.0.0.1` with `Range`
 *   and no size cap. Every size takes this arm, small files included: the
 *   client's only other byte channel is the asset stream, which is keyed by
 *   WORKSPACE PATH and nothing on this wire exposes the epic root, so a
 *   "it is on your disk, go fetch it yourself" answer is unresolvable.
 * - `url` - a short-lived signed cloud GET, generation-bound and read-only.
 *   `mediaType` is the SNIFFED value the server will send as `Content-Type`,
 *   handed over so the client can decide between an `<img>`/`<video>` src and a
 *   blob fetch WITHOUT trusting a file extension. `expiresAt` is absolute ms so
 *   a client re-reads rather than serving a dead url from a cache.
 * - `unavailable` - see the reason enum above.
 */
export const readEpicFileResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("loopback"), url: z.string().min(1) }),
  z.object({
    kind: z.literal("url"),
    url: z.string().min(1),
    expiresAt: z.number(),
    mediaType: z.string(),
  }),
  z.object({
    kind: z.literal("unavailable"),
    reason: epicFileUnavailableReasonSchema,
  }),
]);
export type ReadEpicFileResponse = z.infer<typeof readEpicFileResponseSchema>;

/**
 * Delete and restore share one request shape because they are one operation in
 * two directions: deletion is a TOMBSTONE (D25), so restoring is un-setting the
 * same field on the same entry. There is deliberately no cloud delete - a sha
 * may be named by another path, a `versions[]` entry or a `derivedFrom` link,
 * and neither the server (which stores no paths) nor a host (which sees
 * concurrent CRDT edits) can prove the object dead. The bytes go when the epic
 * goes.
 */
export const epicFileTombstoneRequestSchema = z.object({
  ...epicFileTargetFields,
});
export type EpicFileTombstoneRequest = z.infer<
  typeof epicFileTombstoneRequestSchema
>;

/**
 * The entry's tombstone AFTER the call: a timestamp when deleted, `null` when
 * live. Returning the resulting state rather than a boolean makes both methods
 * idempotent to a retry - a second delete answers with the first one's
 * timestamp instead of claiming a second deletion happened - and lets the GUI
 * settle its optimistic row on a value it can also read out of the manifest.
 * An entry that does not exist throws; there is no state to report.
 */
export const epicFileTombstoneResponseSchema = z.object({
  deletedAt: z.number().nullable(),
});
export type EpicFileTombstoneResponse = z.infer<
  typeof epicFileTombstoneResponseSchema
>;

/** One HTML file, opened in a real browser tab rather than previewed (D32). */
export const openEpicFileInBrowserRequestSchema = z.object({
  ...epicFileTargetFields,
});
export type OpenEpicFileInBrowserRequest = z.infer<
  typeof openEpicFileInBrowserRequestSchema
>;

/**
 * A `127.0.0.1` url on the epic's own token-scoped static server, which the
 * host starts lazily on first use. The client opens a browser tile at it and
 * nothing more - it must not fetch it, rewrite it, or hand it to another
 * origin. The tab always runs on the answering host's machine, which is what
 * makes loopback resolve at all.
 *
 * The bytes are never served from the cloud origin as `text/html`: a signed
 * url is a URL on a shared storage host, and an epic file is attacker-authored
 * content as far as any other epic is concerned.
 */
export const openEpicFileInBrowserResponseSchema = z.object({
  url: z.string().min(1),
});
export type OpenEpicFileInBrowserResponse = z.infer<
  typeof openEpicFileInBrowserResponseSchema
>;

/**
 * A user-initiated screenshot of one browser tab (D29).
 *
 * `tabId` without a `sessionId`: the owning host resolves the tab inside the
 * epic scope, which is the only authorization there is - the same rule
 * `captureTabPreview` follows on `browser.sessions`.
 *
 * `save` mirrors the REPL verb's own opt-in flag so both producers speak one
 * vocabulary. It is on the wire rather than assumed because an unsaved capture
 * is a real case - today's agent behavior, an image block to the model and
 * nothing on disk - and a caller that means it must be able to say it.
 */
export const captureTabScreenshotRequestSchema = z.object({
  epicId: z.string().min(1),
  tabId: z.string().min(1),
  save: z.boolean(),
});
export type CaptureTabScreenshotRequest = z.infer<
  typeof captureTabScreenshotRequestSchema
>;

/**
 * The address of the minted file, or `null` when `save` was false and there is
 * no file to name. Both halves of the address travel because that is exactly
 * what `epic.readFile` needs back, and the manifest entry the doc will carry
 * arrives on its own schedule - the toast must not have to wait for it.
 *
 * No failure arm: a tab that cannot be captured is an ordinary RPC error, the
 * same way `epic.deleteArtifact` throws rather than modelling a refusal, and
 * the caller has an error channel here that a stream frame would not have.
 */
export const captureTabScreenshotResponseSchema = z.object({
  saved: z
    .object({ path: epicFilePathSchema, sha256: sha256HexSchema })
    .nullable(),
});
export type CaptureTabScreenshotResponse = z.infer<
  typeof captureTabScreenshotResponseSchema
>;

/**
 * `null` keeps the tab's live size, which is what a user-started recording
 * wants: they are recording what they can see. An agent-started recording
 * passes an explicit viewport (1440x900 by default) so its output does not
 * depend on how wide someone happened to leave a tile (D22).
 */
export const tabRecordingViewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type TabRecordingViewport = z.infer<typeof tabRecordingViewportSchema>;

export const startTabRecordingRequestSchema = z.object({
  epicId: z.string().min(1),
  tabId: z.string().min(1),
  viewport: tabRecordingViewportSchema.nullable(),
});
export type StartTabRecordingRequest = z.infer<
  typeof startTabRecordingRequestSchema
>;

/**
 * A refused start, as data. Every one of these is a CAP or a placement fact the
 * host checked before doing any work (D21), which makes them answers rather
 * than errors: the user asked for something this tab or this host cannot give
 * right now, and the toolbar renders why instead of a generic failure.
 *
 * Closed for the same reason as the unavailable reasons above - the client
 * branches on it - so a new cap arrives as an additive minor.
 */
export const startTabRecordingRefusalSchema = z.enum([
  /** No such tab in this epic, or it is dormant and was not woken. */
  "tab-not-found",
  /** One active recording per tab. */
  "already-recording",
  /** At most two concurrent recordings per host. */
  "host-limit",
  /** The tab's runtime has no capture path (no helper document available). */
  "unsupported-runtime",
]);
export type StartTabRecordingRefusal = z.infer<
  typeof startTabRecordingRefusalSchema
>;

/**
 * `recordingId` links the three objects one recording produces - the clip, the
 * rrweb track and the poster - and is minted host-side so a client can neither
 * choose nor collide with one. It is the handle for `epic.stopTabRecording`,
 * for the tile's badge, and for every `epic.fileEvents` frame about this run.
 */
export const startTabRecordingResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), recordingId: z.string().min(1) }),
  z.object({ ok: z.literal(false), reason: startTabRecordingRefusalSchema }),
]);
export type StartTabRecordingResponse = z.infer<
  typeof startTabRecordingResponseSchema
>;

export const stopTabRecordingRequestSchema = z.object({
  epicId: z.string().min(1),
  recordingId: z.string().min(1),
});
export type StopTabRecordingRequest = z.infer<
  typeof stopTabRecordingRequestSchema
>;

/**
 * Acknowledges the STOP, not the save. Finalizing runs after the last chunk
 * lands - drain, hash, rename, manifest write - so the file appears in the doc
 * and the run's end appears on `epic.fileEvents`; neither can be awaited here
 * without holding an RPC open for the length of a flush. `false` means there
 * was no such active recording, which a double-click on the stop button makes
 * an ordinary answer rather than an error.
 */
export const stopTabRecordingResponseSchema = z.object({
  stopped: z.boolean(),
});
export type StopTabRecordingResponse = z.infer<
  typeof stopTabRecordingResponseSchema
>;

/**
 * `epic.fileEvents@1.0` - the per-epic stream for the two things the manifest
 * structurally cannot say.
 *
 * The manifest is the file plane's source of truth and it replicates to every
 * participant, so nothing that IS an entry belongs here: a saved recording, its
 * upload status, its poster, a rename, a tombstone - a client learns all of
 * those by observing the doc it already holds. Duplicating them onto a stream
 * would give the GUI two arrival orders for one fact and no way to reconcile
 * them.
 *
 * What the doc cannot carry is exactly two things:
 *
 *   1. A REFUSAL. A drop-zone file the watcher declined never becomes an entry
 *      by definition (D12), so the only record of it is this frame, and without
 *      it a user who copied `.env` into `files/` sees silence.
 *   2. A recording's IN-FLIGHT lifecycle. Between start and finalize there is
 *      no entry to observe, and the tile's badge has to be lit for that whole
 *      window (D20).
 *
 * Optional like every method here: a host that predates the plane never
 * advertises it, the subscription degrades to `unsupported`, and a client that
 * has no file plane on that host has nothing to badge or toast anyway.
 */
export const epicFileEventsOpenRequestSchema = z.object({
  epicId: z.string().min(1),
});
export type EpicFileEventsOpenRequest = z.infer<
  typeof epicFileEventsOpenRequestSchema
>;

/**
 * Why the watcher declined a dropped file (D12). Hidden files are NOT here:
 * they are ignored silently by design, because a dot-file in a watched
 * directory is ordinary and a toast per editor swap-file would be noise.
 */
export const epicFileRefusalReasonSchema = z.enum([
  /** `.env*`, `*.pem`, `*.key`, `id_rsa*`, `*.p12`, `*credentials*`. */
  "secret-shaped",
  /** Over `EPIC_FILE_MAX_BYTES`. */
  "too-large",
  /** The per-epic hourly size/count bound for watcher-originated files. */
  "rate-limited",
  /** A symlink or hard link; the plane stores real bytes only. */
  "not-a-regular-file",
]);
export type EpicFileRefusalReason = z.infer<typeof epicFileRefusalReasonSchema>;

/** How a recording run ended, for the badge that has been lit since it began. */
export const tabRecordingOutcomeSchema = z.enum([
  /** Finalized; the entries are in the doc (or about to be). */
  "saved",
  /** Finalize failed; the staging partial is recoverable, the entry is not. */
  "failed",
  /** Ended before anything was worth keeping (immediate stop, tab closed). */
  "discarded",
]);
export type TabRecordingOutcome = z.infer<typeof tabRecordingOutcomeSchema>;

export const epicFileEventsServerFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("refused"),
    /**
     * The rejected path as the watcher saw it, epic-root-relative. Bounded but
     * NOT validated against `isEpicFilePath`: the whole point of a refusal is
     * that the path was not admissible, so validating it here would drop the
     * frames the user most needs to see.
     */
    path: z.string().max(1024),
    reason: epicFileRefusalReasonSchema,
    ...epicLaneTextFrameFields,
  }),
  z.object({
    kind: z.literal("recordingStarted"),
    recordingId: z.string().min(1),
    tabId: z.string().min(1),
    ...epicLaneTextFrameFields,
  }),
  z.object({
    kind: z.literal("recordingEnded"),
    recordingId: z.string().min(1),
    tabId: z.string().min(1),
    outcome: tabRecordingOutcomeSchema,
    ...epicLaneTextFrameFields,
  }),
  z.object({
    kind: z.literal("pong"),
    ...epicLaneTextFrameFields,
  }),
]);
export type EpicFileEventsServerFrame = z.infer<
  typeof epicFileEventsServerFrameSchema
>;

/** `ping` and nothing else - every file-plane command is a unary above. */
export const epicFileEventsClientFrameSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ping"),
    ...epicLaneTextFrameFields,
  }),
]);
export type EpicFileEventsClientFrame = z.infer<
  typeof epicFileEventsClientFrameSchema
>;

export const epicFileEventsV10 = defineStreamRpcContract({
  method: "epic.fileEvents",
  schemaVersion: { major: 1, minor: 0 } as const,
  openRequestSchema: epicFileEventsOpenRequestSchema,
  serverFrameSchema: epicFileEventsServerFrameSchema,
  clientFrameSchema: epicFileEventsClientFrameSchema,
});
