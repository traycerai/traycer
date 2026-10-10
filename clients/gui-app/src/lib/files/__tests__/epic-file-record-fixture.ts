import type {
  EpicFileLocalState,
  EpicStateFileRecord,
} from "@traycer/protocol/host/epic/files";
import { formatEpicFileRef } from "@traycer/protocol/persistence/epic/files";

/** A sha that differs per path, so a version chain has distinct addresses. */
export function shaFor(path: string): string {
  const hex = Array.from(path, (char) => char.charCodeAt(0).toString(16))
    .join("")
    .padEnd(64, "0");
  return hex.slice(0, 64);
}

interface FileRecordFixture {
  readonly path: string;
  readonly createdAt: number;
  readonly byteLength: number;
  readonly localState: EpicFileLocalState;
  readonly deletedAt: number | null;
  /** The path of the file this one replaced, or `null`. */
  readonly replaces: string | null;
  /** The manifest title, or `null` for a file that has none. */
  readonly title: string | null;
}

const DEFAULTS: Omit<FileRecordFixture, "path"> = {
  createdAt: 1000,
  byteLength: 100,
  localState: { kind: "present" },
  deletedAt: null,
  replaces: null,
  title: null,
};

export function fileRecord(
  overrides: Pick<FileRecordFixture, "path"> & Partial<FileRecordFixture>,
): EpicStateFileRecord {
  const fixture = { ...DEFAULTS, ...overrides };
  return {
    path: fixture.path,
    entry: {
      v: 1,
      kind: "file",
      sha256: shaFor(fixture.path),
      byteLength: fixture.byteLength,
      mediaType: "text/plain",
      status: "ready",
      createdAt: fixture.createdAt,
      derivedFrom:
        fixture.replaces === null
          ? null
          : formatEpicFileRef({
              path: fixture.replaces,
              sha256: shaFor(fixture.replaces),
            }),
      deletedAt: fixture.deletedAt,
      title: fixture.title,
    },
    localState: fixture.localState,
  };
}
