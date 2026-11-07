import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRecordings } from "../session-recordings";

// `full`: a disk that is full from the first write to each audio file opened
// while it is set. `partial`: a disk that takes at most 3 bytes per write.
// `writeGate`: audio writes wait for it, as a disk that has stopped answering
// does. `openGate`: every file open waits for it.
const disk = vi.hoisted(() => ({
  full: false,
  partial: false,
  writeGate: null as Promise<void> | null,
  /** Audio writes that have reached the gate. */
  writesAtGate: 0,
  openGate: null as Promise<void> | null,
}));
const PARTIAL_WRITE_BYTES = 3;

type WriteBytes = (
  buffer: Uint8Array,
  offset: number,
  length: number,
  position: number,
) => Promise<unknown>;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      await disk.openGate;
      const handle = await actual.open(...args);
      const audio = !String(args[0]).endsWith(".jsonl");
      let write: WriteBytes = handle.write.bind(handle);
      if (disk.partial) {
        const whole = write;
        write = (buffer, offset, length, position) =>
          whole(
            buffer,
            offset,
            Math.min(length, PARTIAL_WRITE_BYTES),
            position,
          );
      }
      if (audio && disk.writeGate !== null) {
        const ungated = write;
        write = async (buffer, offset, length, position) => {
          disk.writesAtGate += 1;
          await disk.writeGate;
          return ungated(buffer, offset, length, position);
        };
      }
      // Set, not spied: a spy types `write` by its last overload, the
      // string one, and main only ever calls the bytes one.
      Reflect.set(handle, "write", write);
      if (disk.full && audio) {
        vi.spyOn(handle, "write").mockRejectedValueOnce(
          Object.assign(new Error("no space left on device"), {
            code: "ENOSPC",
          }),
        );
      }
      return handle;
    },
  };
});

const OWNER = 1;
// Local time, as the names are.
const NOW = new Date(2026, 10, 6, 17, 22, 40);

let root: string;
let folder: string;
let revealed: string[];
let warnings: string[];
let ids: number;
// Every store a test made, closed after it so no handle is left to the GC.
let stores: SessionRecordings[];

function recordings(): SessionRecordings {
  const store = new SessionRecordings({
    folder: () => folder,
    now: () => NOW,
    newId: () => {
      ids += 1;
      return `rec-${String(ids)}`;
    },
    reveal: (path) => {
      revealed.push(path);
    },
    warn: (message) => {
      warnings.push(message);
    },
  });
  stores.push(store);
  return store;
}

/** Bytes of this realm, which main checks with `instanceof`. */
function bytesOf(text: string): Uint8Array {
  return Uint8Array.from(Buffer.from(text));
}

async function names(): Promise<string[]> {
  return (await readdir(folder)).toSorted();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "traycer-session-recordings-"));
  folder = join(root, "soundtrack-sessions");
  revealed = [];
  warnings = [];
  ids = 0;
  stores = [];
  disk.full = false;
  disk.partial = false;
  disk.writeGate = null;
  disk.writesAtGate = 0;
  disk.openGate = null;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.map((store) => store.closeAll()));
  await rm(root, { recursive: true, force: true });
});

describe("SessionRecordings: names and folder are main's", () => {
  it("makes the audio and the log side by side, named for the local minute, with a suffix for a second in the same minute", async () => {
    const store = recordings();

    const first = await store.openRecording(OWNER, { quality: "compressed" });
    const second = await store.openRecording(OWNER + 1, {
      quality: "compressed",
    });

    expect(first).toEqual({
      kind: "opened",
      recordingId: "rec-1",
      name: "session-2026-11-06-1722",
    });
    expect(second).toMatchObject({ name: "session-2026-11-06-1722-2" });
    expect(await names()).toEqual([
      "session-2026-11-06-1722-2.jsonl",
      "session-2026-11-06-1722-2.webm",
      "session-2026-11-06-1722.jsonl",
      "session-2026-11-06-1722.webm",
    ]);
  });

  it("names a lossless recording's audio .wav", async () => {
    await recordings().openRecording(OWNER, { quality: "lossless" });

    expect(await names()).toEqual([
      "session-2026-11-06-1722.jsonl",
      "session-2026-11-06-1722.wav",
    ]);
  });

  it.each([
    ["a path beside the quality", { quality: "lossless", path: "/tmp/x" }],
    ["a folder beside the quality", { quality: "lossless", folder: "/tmp" }],
    ["a bare quality", "lossless"],
    ["no quality", {}],
    ["a quality it does not know", { quality: "flac" }],
    ["nothing", null],
  ])("refuses an open input with %s and creates nothing", async (_, input) => {
    const answer = await recordings().openRecording(OWNER, input);

    expect(answer).toEqual({ kind: "refused" });
    await expect(readdir(folder)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("SessionRecordings: names that are taken", () => {
  it("leaves no audio file behind when only the log's name is taken, and takes the next name", async () => {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "session-2026-11-06-1722.jsonl"), "");

    const answer = await recordings().openRecording(OWNER, {
      quality: "compressed",
    });

    expect(answer).toMatchObject({ name: "session-2026-11-06-1722-2" });
    expect(await names()).toEqual([
      "session-2026-11-06-1722-2.jsonl",
      "session-2026-11-06-1722-2.webm",
      "session-2026-11-06-1722.jsonl",
    ]);
  });
});

describe("SessionRecordings: what a recording id may do", () => {
  it.each([
    ["an id nothing opened", "rec-99"],
    ["a path-like id", "../../etc/passwd"],
  ])("refuses an append and a close on %s", async (_, id) => {
    const store = recordings();
    await store.openRecording(OWNER, { quality: "compressed" });

    await expect(
      store.append(OWNER, id, "audio", new Uint8Array(4)),
    ).resolves.toEqual({ kind: "refused" });
    await expect(store.close(OWNER, id, null)).resolves.toEqual({
      kind: "refused",
    });
  });

  it("refuses an append after the close, and takes no bytes into the files", async () => {
    const store = recordings();
    await store.openRecording(OWNER, { quality: "compressed" });
    await store.append(OWNER, "rec-1", "audio", new Uint8Array([1, 2]));
    await expect(store.close(OWNER, "rec-1", null)).resolves.toEqual({
      kind: "ok",
    });

    await expect(
      store.append(OWNER, "rec-1", "audio", new Uint8Array([3])),
    ).resolves.toEqual({ kind: "refused" });
    await expect(store.close(OWNER, "rec-1", null)).resolves.toEqual({
      kind: "refused",
    });
    expect(
      Array.from(await readFile(join(folder, "session-2026-11-06-1722.webm"))),
    ).toEqual([1, 2]);
  });

  it("refuses an append of more than 16 MiB and writes nothing of it", async () => {
    const store = recordings();
    await store.openRecording(OWNER, { quality: "compressed" });

    await expect(
      store.append(
        OWNER,
        "rec-1",
        "audio",
        new Uint8Array(16 * 1024 * 1024 + 1),
      ),
    ).resolves.toEqual({ kind: "refused" });
    await store.close(OWNER, "rec-1", null);

    // Nothing was written, so nothing is kept.
    expect(await names()).toEqual([]);
  });

  it("writes appends that are sent without waiting in the order they were sent", async () => {
    const store = recordings();
    await store.openRecording(OWNER, { quality: "compressed" });

    await Promise.all([
      store.append(OWNER, "rec-1", "audio", new Uint8Array([1, 2])),
      store.append(OWNER, "rec-1", "log", bytesOf("a\n")),
      store.append(OWNER, "rec-1", "audio", new Uint8Array([3])),
      store.append(OWNER, "rec-1", "log", bytesOf("b\n")),
    ]);
    await store.close(OWNER, "rec-1", null);

    expect(
      Array.from(await readFile(join(folder, "session-2026-11-06-1722.webm"))),
    ).toEqual([1, 2, 3]);
    expect(
      await readFile(join(folder, "session-2026-11-06-1722.jsonl"), "utf8"),
    ).toBe("a\nb\n");
  });
});

describe("SessionRecordings: a write the disk refuses", () => {
  it("answers write-failed to every append sent behind the failed one, writes none of them, and does not put the bytes in the warning", async () => {
    disk.full = true;
    const store = recordings();
    await store.openRecording(OWNER, { quality: "compressed" });

    // Sent as the recorder sends them: the second does not wait for the first.
    const answers = await Promise.all([
      store.append(OWNER, "rec-1", "audio", new Uint8Array([9, 9, 9])),
      store.append(OWNER, "rec-1", "log", bytesOf("later\n")),
    ]);

    expect(answers).toEqual([
      { kind: "write-failed" },
      { kind: "write-failed" },
    ]);
    expect(warnings).toEqual(["Soundtrack recording write failed: ENOSPC"]);
    // The close still finishes the files, and says the recording lost writes.
    await expect(store.close(OWNER, "rec-1", null)).resolves.toEqual({
      kind: "write-failed",
    });
    expect(
      await readFile(join(folder, "session-2026-11-06-1722.jsonl"), "utf8"),
    ).toBe("");
  });

  it("writes all of an append that the disk takes in parts", async () => {
    disk.partial = true;
    const store = recordings();
    await store.openRecording(OWNER, { quality: "compressed" });

    await expect(
      store.append(
        OWNER,
        "rec-1",
        "audio",
        Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      ),
    ).resolves.toEqual({ kind: "ok" });
    await store.close(OWNER, "rec-1", null);

    expect(
      Array.from(await readFile(join(folder, "session-2026-11-06-1722.webm"))),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe("SessionRecordings: close", () => {
  it("writes the 44-byte header at offset 0 of a WAV, over its placeholder", async () => {
    const store = recordings();
    await store.openRecording(OWNER, { quality: "lossless" });
    await store.append(OWNER, "rec-1", "audio", new Uint8Array(44).fill(1));
    await store.append(OWNER, "rec-1", "audio", new Uint8Array(10).fill(2));

    const closed = await store.close(
      OWNER,
      "rec-1",
      new Uint8Array(44).fill(7),
    );

    expect(closed).toEqual({ kind: "ok" });
    const bytes = await readFile(join(folder, "session-2026-11-06-1722.wav"));
    expect(bytes).toHaveLength(54);
    expect(Array.from(bytes.subarray(0, 44))).toEqual(Array(44).fill(7));
    expect(Array.from(bytes.subarray(44))).toEqual(Array(10).fill(2));
  });

  it("holds a close sent without waiting behind the appends before it", async () => {
    const store = recordings();
    await store.openRecording(OWNER, { quality: "lossless" });

    const answers = await Promise.all([
      store.append(OWNER, "rec-1", "audio", new Uint8Array(44).fill(1)),
      store.append(OWNER, "rec-1", "audio", new Uint8Array(10).fill(2)),
      store.close(OWNER, "rec-1", new Uint8Array(44).fill(7)),
    ]);

    expect(answers).toEqual([{ kind: "ok" }, { kind: "ok" }, { kind: "ok" }]);
    const bytes = await readFile(join(folder, "session-2026-11-06-1722.wav"));
    expect(Array.from(bytes)).toEqual([
      ...Array(44).fill(7),
      ...Array(10).fill(2),
    ]);
  });

  it("refuses a header for a compressed recording and leaves it open", async () => {
    const store = recordings();
    await store.openRecording(OWNER, { quality: "compressed" });

    await expect(
      store.close(OWNER, "rec-1", new Uint8Array(44)),
    ).resolves.toEqual({ kind: "refused" });

    await expect(
      store.append(OWNER, "rec-1", "audio", new Uint8Array([1])),
    ).resolves.toEqual({ kind: "ok" });
  });

  it("reveals a recording's audio file, open or closed, and nothing else", async () => {
    const store = recordings();
    await store.openRecording(OWNER, { quality: "compressed" });
    await store.append(OWNER, "rec-1", "audio", new Uint8Array([1]));
    await store.close(OWNER, "rec-1", null);

    expect(store.reveal("rec-1")).toBe(true);
    expect(store.reveal("../../etc/passwd")).toBe(false);
    expect(revealed).toEqual([join(folder, "session-2026-11-06-1722.webm")]);
  });
});

describe("SessionRecordings: a disk that falls behind", () => {
  const MIB = 1024 * 1024;

  it("fails the recording at once when the waiting bytes pass the window's budget, writes none of what waited, and takes appends again once the disk catches up", async () => {
    const gate = Promise.withResolvers<void>();
    disk.writeGate = gate.promise;
    const store = recordings();
    await store.openRecording(OWNER, { quality: "compressed" });

    // One byte is in the disk's hands; the two big appends behind it would
    // hold 32 MiB + 1 B.
    const inFlight = store.append(OWNER, "rec-1", "audio", new Uint8Array(1));
    await vi.waitFor(() => {
      expect(disk.writesAtGate).toBe(1);
    });
    const queued = store.append(
      OWNER,
      "rec-1",
      "audio",
      new Uint8Array(16 * MIB),
    );
    const over = await store.append(
      OWNER,
      "rec-1",
      "audio",
      new Uint8Array(16 * MIB),
    );
    const after = await store.append(
      OWNER,
      "rec-1",
      "audio",
      new Uint8Array(1),
    );

    expect(over).toEqual({ kind: "write-failed" });
    expect(after).toEqual({ kind: "write-failed" });
    expect(warnings).toEqual([
      expect.stringMatching(/^Soundtrack recording fell behind the disk: /),
    ]);

    gate.resolve();
    await expect(inFlight).resolves.toEqual({ kind: "ok" });
    await expect(queued).resolves.toEqual({ kind: "write-failed" });
    await expect(store.close(OWNER, "rec-1", null)).resolves.toEqual({
      kind: "write-failed",
    });
    // Only the byte the disk had in hand reached it.
    expect(
      await readFile(join(folder, "session-2026-11-06-1722.webm")),
    ).toHaveLength(1);
    // The budget came back down: a new recording is not held to the old
    // one's, which would leave no room for another 16 MiB.
    await store.openRecording(OWNER, { quality: "compressed" });
    await expect(
      store.append(OWNER, "rec-2", "audio", new Uint8Array(16 * MIB)),
    ).resolves.toEqual({ kind: "ok" });
  });

  it("fails the recording at once when 512 writes are waiting and a 513th arrives, and takes appends again once the disk catches up", async () => {
    const gate = Promise.withResolvers<void>();
    disk.writeGate = gate.promise;
    const store = recordings();
    await store.openRecording(OWNER, { quality: "compressed" });

    const first = store.append(OWNER, "rec-1", "audio", new Uint8Array(1));
    await vi.waitFor(() => {
      expect(disk.writesAtGate).toBe(1);
    });
    const waiting = [
      first,
      ...Array.from({ length: 511 }, () =>
        store.append(OWNER, "rec-1", "audio", new Uint8Array(1)),
      ),
    ];
    const over = await store.append(OWNER, "rec-1", "audio", new Uint8Array(1));

    expect(over).toEqual({ kind: "write-failed" });
    expect(warnings).toEqual([
      expect.stringMatching(/^Soundtrack recording fell behind the disk: /),
    ]);

    gate.resolve();
    const answers = await Promise.all(waiting);
    expect(answers[0]).toEqual({ kind: "ok" });
    expect(answers.slice(1)).toEqual(Array(511).fill({ kind: "write-failed" }));
    await store.close(OWNER, "rec-1", null);
    await store.openRecording(OWNER, { quality: "compressed" });
    await expect(
      store.append(OWNER, "rec-2", "audio", new Uint8Array(1)),
    ).resolves.toEqual({ kind: "ok" });
  });
});

describe("SessionRecordings: one recording per document", () => {
  it("refuses a second open while the first is open, and takes one after it closes", async () => {
    const store = recordings();
    await store.openRecording(OWNER, { quality: "compressed" });

    await expect(
      store.openRecording(OWNER, { quality: "compressed" }),
    ).resolves.toEqual({ kind: "refused" });

    await store.append(OWNER, "rec-1", "audio", new Uint8Array(1));
    await store.close(OWNER, "rec-1", null);
    await expect(
      store.openRecording(OWNER, { quality: "compressed" }),
    ).resolves.toMatchObject({ kind: "opened" });
  });

  it("refuses a second open while the first is still opening", async () => {
    const store = recordings();

    const first = store.openRecording(OWNER, { quality: "compressed" });
    const second = store.openRecording(OWNER, { quality: "compressed" });

    await expect(second).resolves.toEqual({ kind: "refused" });
    await expect(first).resolves.toMatchObject({ kind: "opened" });
  });
});

describe("SessionRecordings: an open that is abandoned on its way", () => {
  it.each([
    [
      "the window going away",
      (store: SessionRecordings) => store.closeAllOf(OWNER),
    ],
    ["the store closing", (store: SessionRecordings) => store.closeAll()],
  ])(
    "answers refused and leaves no file when %s while it opens",
    async (_, teardown) => {
      const gate = Promise.withResolvers<void>();
      disk.openGate = gate.promise;
      const store = recordings();

      const opening = store.openRecording(OWNER, { quality: "lossless" });
      const tearingDown = teardown(store);
      gate.resolve();

      await expect(opening).resolves.toEqual({ kind: "refused" });
      await tearingDown;
      expect(await names()).toEqual([]);
    },
  );

  it("answers refused and leaves no file when the window loads a new document while it opens, and the new document can open its own", async () => {
    const gate = Promise.withResolvers<void>();
    disk.openGate = gate.promise;
    const store = recordings();

    const opening = store.openRecording(OWNER, { quality: "lossless" });
    store.beginDocument(OWNER);
    gate.resolve();

    await expect(opening).resolves.toEqual({ kind: "refused" });
    expect(await names()).toEqual([]);
    await expect(
      store.openRecording(OWNER, { quality: "lossless" }),
    ).resolves.toMatchObject({ kind: "opened" });
  });
});

describe("SessionRecordings: documents", () => {
  it("closes the recordings of earlier documents and leaves the current document's open", async () => {
    const store = recordings();
    await store.openRecording(OWNER, { quality: "compressed" });
    await store.append(OWNER, "rec-1", "audio", new Uint8Array(1));
    const document = store.beginDocument(OWNER);
    await store.openRecording(OWNER, { quality: "compressed" });

    await store.closeDocumentsBefore(OWNER, document);

    await expect(
      store.append(OWNER, "rec-1", "audio", new Uint8Array(1)),
    ).resolves.toEqual({ kind: "refused" });
    await expect(
      store.append(OWNER, "rec-2", "audio", new Uint8Array(1)),
    ).resolves.toEqual({ kind: "ok" });
  });
});

describe("SessionRecordings: who is recording", () => {
  it("lists a window with a recording open, opening or closing, and settles only once its close has finished", async () => {
    const store = recordings();
    expect(store.ownersRecording()).toEqual([]);

    const openGate = Promise.withResolvers<void>();
    disk.openGate = openGate.promise;
    const opening = store.openRecording(OWNER, { quality: "compressed" });
    expect(store.ownersRecording()).toEqual([OWNER]);
    const order: string[] = [];
    void opening.then(() => {
      order.push("opened");
    });
    const settledAfterOpen = store.settled([OWNER]).then(() => {
      order.push("settled");
    });
    openGate.resolve();
    await settledAfterOpen;
    // The wait for a window's recordings takes in an open still on its way.
    expect(order).toEqual(["opened", "settled"]);
    expect(store.ownersRecording()).toEqual([OWNER]);

    const writeGate = Promise.withResolvers<void>();
    disk.writeGate = writeGate.promise;
    const written = store.append(OWNER, "rec-1", "audio", new Uint8Array(1));
    const closing = store.close(OWNER, "rec-1", null);
    expect(store.ownersRecording()).toEqual([OWNER]);
    let settled = false;
    const settling = store.settled([OWNER]).then(() => {
      settled = true;
    });
    // Another window's wait does not wait on this one's disk.
    await store.settled([OWNER + 1]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    writeGate.resolve();
    await written;
    await closing;
    await settling;

    expect(settled).toBe(true);
    expect(store.ownersRecording()).toEqual([]);
  });
});
