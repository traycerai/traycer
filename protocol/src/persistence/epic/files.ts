/**
 * The epic instance of the file plane: the `files` sibling map on the epic
 * root doc, keyed by `files/`-prefixed paths (drop-zone files, screenshots,
 * recordings, artifact-image bytes).
 *
 * The generic schemas live in `persistence/file-plane/files.ts`; this module
 * adds the three things that are an EPIC's choice - the map name, the allowed
 * path prefixes and the per-file byte cap - and re-exports the generic surface
 * under the epic-prefixed names the epic integration on
 * `feat/epic-media-pipeline` was written against, so that branch rebases onto
 * the shared core without renaming its call sites.
 */
import {
  filePlaneEntrySchema,
  filePlaneKinds,
  filePlaneObjectSchema,
  filePlaneProducerSchema,
  filePlaneStatuses,
  isFilePlanePath,
  normalizeFilePlaneStatus,
  parseFilePlaneRef,
  type FilePlaneRef,
} from "../file-plane/files";

export {
  filePlaneEntrySchema as epicFileEntrySchema,
  filePlaneKinds as epicFileKinds,
  filePlaneObjectSchema as epicFileObjectSchema,
  filePlaneProducerSchema as epicFileProducerSchema,
  filePlaneStatuses as epicFileStatuses,
  formatFilePlaneRef as formatEpicFileRef,
  normalizeFilePlaneStatus as normalizeEpicFileStatus,
  FILE_PLANE_MIRROR_EAGER_MAX_BYTES as EPIC_FILE_MIRROR_EAGER_MAX_BYTES,
  FILE_PLANE_TOMBSTONE_COMPACT_MS as EPIC_FILE_TOMBSTONE_COMPACT_MS,
  FILE_PLANE_VERSIONS_CAP as EPIC_FILE_VERSIONS_CAP,
  SHA256_HEX,
} from "../file-plane/files";
export type {
  FilePlaneEntry as EpicFileEntry,
  FilePlaneKind as EpicFileKind,
  FilePlaneObject as EpicFileObject,
  FilePlaneProducer as EpicFileProducer,
  FilePlaneRef as EpicFileRef,
  FilePlaneStatus as EpicFileStatus,
  FilePlaneStatusOrUnknown as EpicFileStatusOrUnknown,
} from "../file-plane/files";

export const EPIC_FILES_MAP_NAME = "files";

/** Per-file byte cap (D21) - sized for recordings. */
export const EPIC_FILE_MAX_BYTES = 512 * 1024 * 1024;

/**
 * Epic-root-relative prefixes the manifest addresses. `files/` is the only one:
 * every object's bytes, migrated artifact images included
 * (`files/artifact-images/<sha>.<ext>`, D04), live under it. The per-artifact
 * `artifacts/<id>/images/` folder is a PROJECTION the artifact mirror writes and
 * prunes, never a manifest key. `.file-staging/` is a sibling of `files/` by
 * construction and is therefore rejected here - staging files are never
 * manifest entries.
 */
export const EPIC_FILE_PATH_PREFIXES: readonly string[] = ["files/"];

/** {@link isFilePlanePath} under {@link EPIC_FILE_PATH_PREFIXES}. */
export function isEpicFilePath(path: string): boolean {
  return isFilePlanePath(path, EPIC_FILE_PATH_PREFIXES);
}

/** {@link parseFilePlaneRef} under {@link EPIC_FILE_PATH_PREFIXES}. */
export function parseEpicFileRef(ref: string): FilePlaneRef | null {
  return parseFilePlaneRef(ref, EPIC_FILE_PATH_PREFIXES);
}
