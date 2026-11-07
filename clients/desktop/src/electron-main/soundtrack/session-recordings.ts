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
 * A window that goes away has its recordings closed as they stand, and a WAV
 * left that way still opens, because its header carries the streaming
 * placeholder until the renderer's close writes the sizes.
 */

/** The renderer's whole say in a new recording. */
const openInput = z.strictObject({
  quality: z.enum(["compressed", "lossless"]),
});

const recordingFile = z.enum(["audio", "log"]);

// Far above a second of any audio the renderer sends, so a runaway is refused.
const MAX_APPEND_BYTES = 16 * 1024 * 1024;
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
  /** Where the next append goes. */
  offset: number;
}

interface OpenRecording {
  readonly ownerId: number;
  readonly quality: SoundtrackRecordingQuality;
  readonly audioPath: string;
  readonly files: Readonly<Record<SoundtrackRecordingFile, WritableFile>>;
  /** The last write queued, which the next waits for. */
  queue: Promise<unknown>;
  failed: boolean;
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
  /** Closed recordings, by id, for `reveal`. */
  private readonly closed = new Map<string, string>();

  constructor(options: SessionRecordingsOptions) {
    this.options = options;
  }

  async openRecording(
    ownerId: number,
    input: unknown,
  ): Promise<SoundtrackRecordingOpenResult> {
    const parsed = openInput.safeParse(input);
    if (!parsed.success) return { kind: "refused" };
    const { quality } = parsed.data;
    const { now, newId, warn } = this.options;
    try {
      const folder = this.options.folder();
      await mkdir(folder, { recursive: true });
      const base = sessionName(now());
      for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
        const name = attempt === 1 ? base : `${base}-${String(attempt)}`;
        const audioPath = join(folder, `${name}${AUDIO_EXTENSIONS[quality]}`);
        const logPath = join(folder, `${name}.jsonl`);
        const files = await this.createPair(audioPath, logPath);
        if (files === null) continue;
        const recordingId = newId();
        this.recordings.set(recordingId, {
          ownerId,
          quality,
          audioPath,
          files,
          queue: Promise.resolve(),
          failed: false,
        });
        return { kind: "opened", recordingId, name };
      }
      warn("Soundtrack recording not opened: no free name");
    } catch (error) {
      warn(`Soundtrack recording not opened: ${errorCode(error)}`);
    }
    return { kind: "refused" };
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
    const target = recording.files[parsedFile.data];
    return this.enqueue(recording, async () => {
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
   * write answers.
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
    this.recordings.delete(recordingId);
    this.closed.set(recordingId, recording.audioPath);
    return this.enqueue(recording, async () => {
      let result = OK;
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
      return (await this.closeFiles(recording)) ? result : WRITE_FAILED;
    });
  }

  /** Whether there was such a recording to show. */
  reveal(recordingId: unknown): boolean {
    if (typeof recordingId !== "string") return false;
    const path =
      this.recordings.get(recordingId)?.audioPath ??
      this.closed.get(recordingId);
    if (path === undefined) return false;
    this.options.reveal(path);
    return true;
  }

  /** A window gone: its recordings stop where they stand. */
  async closeAllOf(ownerId: number): Promise<void> {
    const owned = [...this.recordings].filter(
      ([, recording]) => recording.ownerId === ownerId,
    );
    await Promise.all(
      owned.map(([recordingId, recording]) => {
        this.recordings.delete(recordingId);
        this.closed.set(recordingId, recording.audioPath);
        return this.enqueue(recording, () => this.closeFiles(recording));
      }),
    );
  }

  async closeAll(): Promise<void> {
    const owners = new Set(
      [...this.recordings.values()].map((recording) => recording.ownerId),
    );
    await Promise.all([...owners].map((ownerId) => this.closeAllOf(ownerId)));
  }

  /** Null when either name is taken; neither file is left behind then. */
  private async createPair(
    audioPath: string,
    logPath: string,
  ): Promise<Readonly<Record<SoundtrackRecordingFile, WritableFile>> | null> {
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
      audio: { handle: audio, offset: 0 },
      log: { handle: log, offset: 0 },
    };
  }

  private recordingOf(
    ownerId: number,
    recordingId: unknown,
  ): OpenRecording | null {
    if (typeof recordingId !== "string") return null;
    const recording = this.recordings.get(recordingId);
    return recording?.ownerId === ownerId ? recording : null;
  }

  private enqueue<T>(
    recording: OpenRecording,
    work: () => Promise<T>,
  ): Promise<T> {
    const next = recording.queue.then(work, work);
    recording.queue = next;
    return next;
  }

  /** Whether both closed cleanly; both are tried either way. */
  private async closeFiles(recording: OpenRecording): Promise<boolean> {
    const results = await Promise.allSettled([
      recording.files.audio.handle.close(),
      recording.files.log.handle.close(),
    ]);
    const failure = results.find(isRejected);
    if (failure === undefined) return true;
    this.options.warn(
      `Soundtrack recording not closed cleanly: ${errorCode(failure.reason)}`,
    );
    return false;
  }
}
