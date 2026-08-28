import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeUpdateDispatchAck,
  updateDispatchAckPath,
} from "@traycer/protocol/config/host-update-ack";
import { stampUpdateDispatchAck } from "../update-dispatch-ack";

// Direct unit suite for the §5.2.8 child-side ACK writer.

const roots: string[] = [];

async function freshHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dispatch-ack-test-"));
  roots.push(root);
  const home = join(root, "host-home");
  await mkdir(home, { recursive: true });
  return home;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const IDENTITY = { attemptId: "attempt-1", generation: 2, sequence: 5 };

describe("stampUpdateDispatchAck", () => {
  it("writes an ACK the shared decoder accepts", async () => {
    const home = await freshHome();
    await stampUpdateDispatchAck({
      hostHomeDir: home,
      nonce: "nonce-abcdefgh",
      identity: IDENTITY,
      claimedAtIso: "2026-01-01T00:00:00.000Z",
    });

    // Read back through the DECODER the resolver uses, not through a local
    // JSON.parse: what matters is that the reader on the other side of this
    // contract accepts these exact bytes.
    const decoded = decodeUpdateDispatchAck(
      await readFile(updateDispatchAckPath(home), "utf8"),
    );
    expect(decoded).toEqual({
      kind: "valid",
      ack: {
        v: 1,
        nonce: "nonce-abcdefgh",
        attemptId: "attempt-1",
        generation: 2,
        sequence: 5,
        claimedAt: "2026-01-01T00:00:00.000Z",
      },
    });
  });

  it("leaves NO scratch file behind", async () => {
    const home = await freshHome();
    await stampUpdateDispatchAck({
      hostHomeDir: home,
      nonce: "nonce-abcdefgh",
      identity: IDENTITY,
      claimedAtIso: "2026-01-01T00:00:00.000Z",
    });

    // Enumerated, not a single-name absence check: an unexpected extra file
    // fails loudly here, where checking for one name would miss it. A leaked
    // temp accumulates in the host home silently and forever.
    expect((await readdir(home)).sort()).toEqual(["update-dispatch-ack.json"]);
  });

  it("REPLACES a previous dispatch's ACK rather than accumulating", async () => {
    const home = await freshHome();
    await stampUpdateDispatchAck({
      hostHomeDir: home,
      nonce: "nonce-oldrunabc",
      identity: { attemptId: "attempt-old", generation: 1, sequence: 1 },
      claimedAtIso: "2026-01-01T00:00:00.000Z",
    });
    await stampUpdateDispatchAck({
      hostHomeDir: home,
      nonce: "nonce-abcdefgh",
      identity: IDENTITY,
      claimedAtIso: "2026-01-02T00:00:00.000Z",
    });

    expect((await readdir(home)).sort()).toEqual(["update-dispatch-ack.json"]);
    const decoded = decodeUpdateDispatchAck(
      await readFile(updateDispatchAckPath(home), "utf8"),
    );
    expect(decoded.kind).toBe("valid");
    if (decoded.kind !== "valid") return;
    // The publish is a rename, so a reader sees the old ACK or the new one and
    // never a mix of the two.
    expect(decoded.ack.nonce).toBe("nonce-abcdefgh");
    expect(decoded.ack.attemptId).toBe("attempt-1");
  });

  it("cleans up its scratch file when the publish itself fails", async () => {
    // The throw path, which the success-path test above cannot reach. A
    // directory standing where the ACK belongs makes `rename` fail for a
    // reason the writer cannot anticipate - which is the point: the guarantee
    // is that ANY publish failure leaves no scratch behind, not that the
    // writer enumerated the failures.
    const home = await freshHome();
    await mkdir(updateDispatchAckPath(home), { recursive: true });

    await expect(
      stampUpdateDispatchAck({
        hostHomeDir: home,
        nonce: "nonce-abcdefgh",
        identity: IDENTITY,
        claimedAtIso: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow();

    // Only the obstructing directory remains - no `.update-dispatch-ack.*.tmp`.
    expect((await readdir(home)).sort()).toEqual(["update-dispatch-ack.json"]);
  });

  it("REFUSES an illegal nonce, and writes nothing at all", async () => {
    const home = await freshHome();
    await expect(
      stampUpdateDispatchAck({
        hostHomeDir: home,
        nonce: "../../etc/passwd",
        identity: IDENTITY,
        claimedAtIso: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow(/nonce/);

    // Both halves. Throwing while still having written a junk file would be
    // worse than not refusing at all: no wait would ever accept it, and it
    // would sit in the host home indefinitely.
    expect(await readdir(home)).toEqual([]);
  });

  it("does not disturb a pre-existing ACK when it refuses", async () => {
    const home = await freshHome();
    await writeFile(
      updateDispatchAckPath(home),
      `${JSON.stringify({
        v: 1,
        nonce: "nonce-priorrun1",
        attemptId: "attempt-prior",
        generation: 1,
        sequence: 1,
        claimedAt: "2026-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    await expect(
      stampUpdateDispatchAck({
        hostHomeDir: home,
        nonce: "bad nonce",
        identity: IDENTITY,
        claimedAtIso: "2026-01-02T00:00:00.000Z",
      }),
    ).rejects.toThrow(/nonce/);

    const decoded = decodeUpdateDispatchAck(
      await readFile(updateDispatchAckPath(home), "utf8"),
    );
    expect(decoded.kind).toBe("valid");
    if (decoded.kind !== "valid") return;
    // A refusal must not be destructive. The prior ACK belongs to a dispatch
    // that may still be waiting on it.
    expect(decoded.ack.nonce).toBe("nonce-priorrun1");
  });
});
