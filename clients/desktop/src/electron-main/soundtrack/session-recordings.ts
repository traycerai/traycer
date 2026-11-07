import { mkdir, open, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type {
  SoundtrackRecordingFile,
  SoundtrackRecordingOpenResult,
  SoundtrackRecordingQuality,
  SoundtrackRecordingWriteResult,
} from "../../ipc-contracts/soundtrack-recording-types";

/**
 * Recordings of the music, each an audio file and a log beside it, in one
 * folder of main's choosing under userData, which needs no macOS folder
 * permission. The renderer opens a recording, appends bytes to it by the id it
 * was answered with, and closes it; it never names a folder, a file or a path.
 *
 * Each recording's writes run one after another in the order they arrived, so
 * the renderer can send without waiting. A write the disk refuses fails that
 * recording: it takes no more bytes, and the renderer is told so it can stop.
 * So does a disk that falls so far behind that the waiting writes pass a
 * window's budget, which bounds what a renderer can make main hold.
 *
 * A recording belongs to the window that opened it, and to the document that
 * window showed then. A window that goes away, or loads a new document, has its
 * recordings closed as they stand; an open still on its way then closes what it
 * made. A WAV left that way still opens, because its header carries the
 * streaming placeholder until the renderer's close writes the sizes.
 */

/** The renderer's whole say in a new recording. */
const openInput = z.strictObject({
  quality: z.enum(["compressed", "lossless"]),
});

const recordingFile = z.enum(["audio", "log"]);

// Far above a second of any audio the renderer sends, so a runaway is refused.
const MAX_APPEND_BYTES = 16 * 1024 * 1024;
/**
 * Bytes a window's writes may hold in main while the disk catches up. The
 * renderer sends a second of audio at a time without waiting: this is about
 * 170 s of 48 kHz lossless (192,000 bytes a second), or half an hour of
 * compressed (16,000), before a disk that slow is taken as failing. It is
 * twice the largest single append, so one always fits.
 */
const MAX_PENDING_BYTES_PER_WINDOW = 32 * 1024 * 1024;
/**
 * Writes a window may have waiting, whatever their size: the renderer sends
 * two a second, audio and log, so about four minutes of a stalled disk. It
 * bounds the work a flood of small appends could queue.
 */
const MAX_PENDING_WRITES_PER_WINDOW = 512;
// A window records one session at a time.
const MAX_RECORDINGS_PER_DOCUMENT = 1;
const WAV_HEADER_BYTES = 44;
// Two recordings started in the same minute are told apart by a suffix.
const MAX_NAME_ATTEMPTS = 100;

const OK: SoundtrackRecordingWriteResult = { kind: "ok" };
const WRITE_FAILED: SoundtrackRecordingWriteResult = { kind: "write-failed" };
const REFUSED: SoundtrackRecordingWriteResult = { kind: "refused" };

const AUDIO_EXTENSIONS: Readonly<Record<SoundtrackRecordingQuality, string>> = {
  compressed: ".webm",
  lossless: ".wav",
};

interface WritableFile {
  readonly handle: FileHandle;
  readonly path: string;
  /** Where the next append goes. */
  offset: number;
}

type FilePair = Readonly<Record<SoundtrackRecordingFile, WritableFile>>;

interface OpenRecording {
  readonly ownerId: number;
  /** The owner's document when it was opened. */
  readonly document: number;
  readonly quality: SoundtrackRecordingQuality;
  readonly files: FilePair;
  /** The last write queued, which the next waits for. */
  queue: Promise<unknown>;
  failed: boolean;
  /** Settles once both files are closed, by the renderer or by main. */
  readonly finished: Promise<void>;
  readonly finish: () => void;
}

/** An open on its way, which owner cleanup can no longer reach by id. */
interface PendingOpen {
  readonly ownerId: number;
  readonly document: number;
  /** Set when its owner or document went away: what it makes is closed. */
  abandoned: boolean;
}

interface Owner {
  /** Bumped each time the window loads a new document. */
  document: number;
  pendingBytes: number;
  pendingWrites: number;
}

export interface SessionRecordingsOptions {
  /** Asked at each open, so nothing is resolved before a recording starts. */
  readonly folder: () => string;
  readonly now: () => Date;
  readonly newId: () => string;
  /** Shows a file selected in the system's file manager. */
  readonly reveal: (path: string) => void;
  /** Told why a write failed, never with the bytes. */
  readonly warn: (message: string) => void;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/** `session-2026-11-06-1042`, in local time. */
function sessionName(at: Date): string {
  return `session-${String(at.getFullYear())}-${twoDigits(at.getMonth() + 1)}-${twoDigits(at.getDate())}-${twoDigits(at.getHours())}${twoDigits(at.getMinutes())}`;
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code: unknown = Reflect.get(error, "code");
    if (typeof code === "string") return code;
  }
  return "unknown";
}

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.length <= MAX_APPEND_BYTES;
}

async function writeAll(
  file: WritableFile,
  bytes: Uint8Array,
  position: number,
): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const { bytesWritten } = await file.handle.write(
      bytes,
      written,
      bytes.length - written,
      position + written,
    );
    written += bytesWritten;
  }
}

function isRejected(
  result: PromiseSettledResult<void>,
): result is PromiseRejectedResult {
  return result.status === "rejected";
}

export class SessionRecordings {
  private readonly options: SessionRecordingsOptions;
  private readonly recordings = new Map<string, OpenRecording>();
  /** Every recording whose files are not closed yet, open or closing. */
  private readonly unfinished = new Set<OpenRecording>();
  private readonly opening = new Map<PendingOpen, Promise<unknown>>();
  private readonly owners = new Map<number, Owner>();
  /** Closed recordings, by id, for `reveal`. */
  private readonly closed = new Map<string, string>();

  constructor(options: SessionRecordingsOptions) {
    this.options = options;
  }

  openRecording(
    ownerId: number,
    input: unknown,
  ): Promise<SoundtrackRecordingOpenResult> {
    const parsed = openInput.safeParse(input);
    if (!parsed.success) return Promise.resolve({ kind: "refused" });
    const owner = this.ownerOf(ownerId);
    if (
      this.recordingsOf(ownerId, owner.document) >= MAX_RECORDINGS_PER_DOCUMENT
    ) {
      this.options.warn("Soundtrack recording not opened: one is open already");
      return Promise.resolve({ kind: "refused" });
    }
    // Known before the first wait, so a window that goes during it is seen.
    const pending: PendingOpen = {
      ownerId,
      document: owner.document,
      abandoned: false,
    };
    const opened = this.openFor(pending, parsed.data.quality).finally(() => {
      this.opening.delete(pending);
    });
    this.opening.set(pending, opened);
    return opened;
  }

  append(
    ownerId: number,
    recordingId: unknown,
    file: unknown,
    bytes: unknown,
  ): Promise<SoundtrackRecordingWriteResult> {
    const recording = this.recordingOf(ownerId, recordingId);
    const parsedFile = recordingFile.safeParse(file);
    if (recording === null || !parsedFile.success || !isBytes(bytes)) {
      return Promise.resolve(REFUSED);
    }
    if (recording.failed) return Promise.resolve(WRITE_FAILED);
    const owner = this.ownerOf(ownerId);
    if (
      owner.pendingBytes + bytes.length > MAX_PENDING_BYTES_PER_WINDOW ||
      owner.pendingWrites >= MAX_PENDING_WRITES_PER_WINDOW
    ) {
      recording.failed = true;
      this.options.warn(
        `Soundtrack recording fell behind the disk: ${String(owner.pendingBytes)} bytes in ${String(owner.pendingWrites)} writes waiting`,
      );
      return Promise.resolve(WRITE_FAILED);
    }
    const target = recording.files[parsedFile.data];
    return this.enqueue(recording, bytes.length, async () => {
      if (recording.failed) return WRITE_FAILED;
      const position = target.offset;
      target.offset += bytes.length;
      try {
        await writeAll(target, bytes, position);
        return OK;
      } catch (error) {
        recording.failed = true;
        this.options.warn(
          `Soundtrack recording write failed: ${errorCode(error)}`,
        );
        return WRITE_FAILED;
      }
    });
  }

  /**
   * Writes `audioHeader` over a WAV's placeholder, behind every append before
   * it, then closes both files. The files are closed whatever the header's
   * write answers, and a recording a write already failed answers that.
   */
  close(
    ownerId: number,
    recordingId: unknown,
    audioHeader: unknown,
  ): Promise<SoundtrackRecordingWriteResult> {
    const recording = this.recordingOf(ownerId, recordingId);
    const header =
      audioHeader === null
        ? null
        : audioHeader instanceof Uint8Array &&
            audioHeader.length === WAV_HEADER_BYTES
          ? audioHeader
          : undefined;
    if (
      recording === null ||
      typeof recordingId !== "string" ||
      header === undefined ||
      (header !== null && recording.quality !== "lossless")
    ) {
      return Promise.resolve(REFUSED);
    }
    this.retire(recordingId, recording);
    return this.enqueue(recording, header?.length ?? 0, async () => {
      let result = recording.failed ? WRITE_FAILED : OK;
      if (header !== null) {
        try {
          await writeAll(recording.files.audio, header, 0);
        } catch (error) {
          this.options.warn(
            `Soundtrack recording header not written: ${errorCode(error)}`,
          );
          result = WRITE_FAILED;
        }
      }
      return (await this.closeFiles(recordingId, recording))
        ? result
        : WRITE_FAILED;
    });
  }

  /** Whether there was such a recording to show. */
  reveal(recordingId: unknown): boolean {
    if (typeof recordingId !== "string") return false;
    const path =
      this.recordings.get(recordingId)?.files.audio.path ??
      this.closed.get(recordingId);
    if (path === undefined) return false;
    this.options.reveal(path);
    return true;
  }

  /**
   * The owner's window now shows a new document, which cannot reach what the
   * last one opened: an open still on its way closes what it makes. Answers
   * the new document's number, for `closeDocumentsBefore`.
   */
  beginDocument(ownerId: number): number {
    const owner = this.ownerOf(ownerId);
    owner.document += 1;
    for (const pending of this.opening.keys()) {
      if (pending.ownerId === ownerId && pending.document < owner.document) {
        pending.abandoned = true;
      }
    }
    return owner.document;
  }

  /**
   * Closes, as they stand, the owner's recordings from documents before
   * `document`. Called a little after the new one loads, so the last one's own
   * close, sent as it unloaded, lands first.
   */
  async closeDocumentsBefore(ownerId: number, document: number): Promise<void> {
    await this.closeWhere(
      (recording) =>
        recording.ownerId === ownerId && recording.document < document,
    );
  }

  /** A window gone: its recordings stop where they stand. */
  async closeAllOf(ownerId: number): Promise<void> {
    const opens = [...this.opening].filter(([pending]) => {
      if (pending.ownerId !== ownerId) return false;
      pending.abandoned = true;
      return true;
    });
    await Promise.all([
      this.closeWhere((recording) => recording.ownerId === ownerId),
      ...opens.map(([, opened]) => opened),
    ]);
    this.owners.delete(ownerId);
  }

  async closeAll(): Promise<void> {
    const owners = new Set([
      ...[...this.recordings.values()].map((recording) => recording.ownerId),
      ...[...this.opening.keys()].map((pending) => pending.ownerId),
    ]);
    await Promise.all([...owners].map((ownerId) => this.closeAllOf(ownerId)));
    await this.settled(null);
  }

  /** The windows with a recording open, opening or still closing. */
  ownersRecording(): readonly number[] {
    return [
      ...new Set([
        ...[...this.unfinished].map((recording) => recording.ownerId),
        ...[...this.opening.keys()].map((pending) => pending.ownerId),
      ]),
    ];
  }

  /**
   * Settles once `ownerIds`' recordings (every window's, for null) have closed
   * their files and their opens have settled, however long that takes: the
   * caller bounds the wait.
   */
  async settled(ownerIds: readonly number[] | null): Promise<void> {
    const ours = (ownerId: number): boolean =>
      ownerIds === null || ownerIds.includes(ownerId);
    await Promise.all([
      ...[...this.unfinished]
        .filter((recording) => ours(recording.ownerId))
        .map((recording) => recording.finished),
      ...[...this.opening]
        .filter(([pending]) => ours(pending.ownerId))
        .map(([, opened]) => opened),
    ]);
  }

  private async openFor(
    pending: PendingOpen,
    quality: SoundtrackRecordingQuality,
  ): Promise<SoundtrackRecordingOpenResult> {
    const { now, newId, warn } = this.options;
    try {
      const folder = this.options.folder();
      await mkdir(folder, { recursive: true });
      const base = sessionName(now());
      for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
        const name = attempt === 1 ? base : `${base}-${String(attempt)}`;
        const files = await this.createPair(
          join(folder, `${name}${AUDIO_EXTENSIONS[quality]}`),
          join(folder, `${name}.jsonl`),
        );
        if (files === null) continue;
        if (pending.abandoned) {
          await this.discard(files);
          return { kind: "refused" };
        }
        const recordingId = newId();
        let finish: () => void = () => undefined;
        const finished = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const recording: OpenRecording = {
          ownerId: pending.ownerId,
          document: pending.document,
          quality,
          files,
          queue: Promise.resolve(),
          failed: false,
          finished,
          finish,
        };
        this.recordings.set(recordingId, recording);
        this.unfinished.add(recording);
        return { kind: "opened", recordingId, name };
      }
      warn("Soundtrack recording not opened: no free name");
    } catch (error) {
      warn(`Soundtrack recording not opened: ${errorCode(error)}`);
    }
    return { kind: "refused" };
  }

  /** Null when either name is taken; neither file is left behind then. */
  private async createPair(
    audioPath: string,
    logPath: string,
  ): Promise<FilePair | null> {
    let audio: FileHandle;
    try {
      audio = await open(audioPath, "wx");
    } catch (error) {
      if (errorCode(error) === "EEXIST") return null;
      throw error;
    }
    let log: FileHandle;
    try {
      log = await open(logPath, "wx");
    } catch (error) {
      await audio.close();
      // The audio name was free and the log's was not: try the next name,
      // and leave no empty audio file under this one.
      await rm(audioPath, { force: true });
      if (errorCode(error) === "EEXIST") return null;
      throw error;
    }
    return {
      audio: { handle: audio, path: audioPath, offset: 0 },
      log: { handle: log, path: logPath, offset: 0 },
    };
  }

  /** A pair made for an open nobody can use any more: closed and removed. */
  private async discard(files: FilePair): Promise<void> {
    await Promise.allSettled([
      files.audio.handle.close(),
      files.log.handle.close(),
    ]);
    await Promise.allSettled([
      rm(files.audio.path, { force: true }),
      rm(files.log.path, { force: true }),
    ]);
  }

  private ownerOf(ownerId: number): Owner {
    let owner = this.owners.get(ownerId);
    if (owner === undefined) {
      owner = { document: 0, pendingBytes: 0, pendingWrites: 0 };
      this.owners.set(ownerId, owner);
    }
    return owner;
  }

  /** The owner's recordings in `document`, open or on their way. */
  private recordingsOf(ownerId: number, document: number): number {
    const mine = (entry: { ownerId: number; document: number }): boolean =>
      entry.ownerId === ownerId && entry.document === document;
    return (
      [...this.recordings.values()].filter(mine).length +
      [...this.opening.keys()].filter(
        (pending) => mine(pending) && !pending.abandoned,
      ).length
    );
  }

  private recordingOf(
    ownerId: number,
    recordingId: unknown,
  ): OpenRecording | null {
    if (typeof recordingId !== "string") return null;
    const recording = this.recordings.get(recordingId);
    return recording?.ownerId === ownerId ? recording : null;
  }

  /** No longer reachable by its id: it is closing. */
  private retire(recordingId: string, recording: OpenRecording): void {
    this.recordings.delete(recordingId);
    this.closed.set(recordingId, recording.files.audio.path);
  }

  private async closeWhere(
    matches: (recording: OpenRecording) => boolean,
  ): Promise<void> {
    const closing = [...this.recordings].filter(([, recording]) =>
      matches(recording),
    );
    await Promise.all(
      closing.map(([recordingId, recording]) => {
        this.retire(recordingId, recording);
        return this.enqueue(recording, 0, () =>
          this.closeFiles(recordingId, recording),
        );
      }),
    );
  }

  /** Counts `bytes` against the owner's budget until the work settles. */
  private enqueue<T>(
    recording: OpenRecording,
    bytes: number,
    work: () => Promise<T>,
  ): Promise<T> {
    const owner = this.ownerOf(recording.ownerId);
    owner.pendingBytes += bytes;
    owner.pendingWrites += 1;
    const next = recording.queue.then(work, work).finally(() => {
      owner.pendingBytes -= bytes;
      owner.pendingWrites -= 1;
    });
    recording.queue = next;
    return next;
  }

  /**
   * Whether both closed cleanly; both are tried either way. A recording that
   * never took a byte is removed, so a start that got no further leaves
   * nothing behind.
   */
  private async closeFiles(
    recordingId: string,
    recording: OpenRecording,
  ): Promise<boolean> {
    const { audio, log } = recording.files;
    const results = await Promise.allSettled([
      audio.handle.close(),
      log.handle.close(),
    ]);
    if (audio.offset === 0 && log.offset === 0) {
      this.closed.delete(recordingId);
      await Promise.allSettled([
        rm(audio.path, { force: true }),
        rm(log.path, { force: true }),
      ]);
    }
    this.unfinished.delete(recording);
    recording.finish();
    const failure = results.find(isRejected);
    if (failure === undefined) return true;
    this.options.warn(
      `Soundtrack recording not closed cleanly: ${errorCode(failure.reason)}`,
    );
    return false;
  }
}
