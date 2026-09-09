import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// `holder.json` is read by PATH rather than through the store's path helpers -
// its whole point is answering for a data root this process did not launch -
// so this suite writes real files into a scratch directory and never touches
// the developer's `~/.traycer`.
import {
  hostHolderRecordPathIn,
  readHostHolderEvidenceAt,
} from "../holder-record";

describe("readHostHolderEvidenceAt", () => {
  let dir = "";
  let path = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "traycer-holder-record-"));
    path = hostHolderRecordPathIn(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("names the record inside the data root it protects", () => {
    expect(hostHolderRecordPathIn("/tmp/root-a")).toBe(
      join("/tmp/root-a", "holder.json"),
    );
  });

  it("reads a missing record as absent - nothing holds this root", async () => {
    await expect(readHostHolderEvidenceAt(path, "dev")).resolves.toEqual({
      kind: "absent",
    });
  });

  it("keeps a torn record apart from an absent one", async () => {
    await writeFile(path, '{"pid": 42', "utf8");
    await expect(readHostHolderEvidenceAt(path, "dev")).resolves.toEqual({
      kind: "unreadable",
      cause: "not valid JSON",
    });
    await writeFile(path, "42", "utf8");
    await expect(readHostHolderEvidenceAt(path, "dev")).resolves.toEqual({
      kind: "unreadable",
      cause: "not a JSON object",
    });
  });

  // The pid guard, one case per way a record can name something that is not a
  // process. `0` and `-1` are the load-bearing ones: `process.kill` reads a
  // non-positive first argument as a process GROUP, so a liveness check on
  // either answers "alive" about the CALLER, and a corrupt record would read
  // as a live writer holding the root forever.
  it.each([
    ["absent", {}],
    ["a string", { pid: "4242" }],
    ["null", { pid: null }],
    ["zero - the caller's own process group", { pid: 0 }],
    ["negative - another process group", { pid: -4242 }],
    ["fractional", { pid: 42.5 }],
  ])("reads a record whose pid is %s as unreadable", async (_name, record) => {
    await writeFile(path, JSON.stringify(record), "utf8");
    await expect(readHostHolderEvidenceAt(path, "dev")).resolves.toEqual({
      kind: "unreadable",
      cause: "malformed record (pid unusable)",
    });
  });

  it("reads a well-formed record, keeping the start stamp when it is one", async () => {
    await writeFile(
      path,
      JSON.stringify({ pid: 4242, processStartIdentity: "start:1:2" }),
      "utf8",
    );
    const evidence = await readHostHolderEvidenceAt(path, "dev");
    expect(evidence.kind).toBe("read");
    expect(evidence.kind === "read" ? evidence.holder.pid : null).toBe(4242);
  });

  it("keeps the record when the start stamp is unusable, rather than dropping the holder", async () => {
    // A stamp this CLI cannot parse costs the identity comparison, not the
    // record: the pid still names a process that may be writing this root.
    await writeFile(
      path,
      JSON.stringify({ pid: 4242, processStartIdentity: 17 }),
      "utf8",
    );
    const evidence = await readHostHolderEvidenceAt(path, "dev");
    expect(evidence).toEqual({
      kind: "read",
      holder: { pid: 4242, processStartIdentity: null },
    });
  });
});
