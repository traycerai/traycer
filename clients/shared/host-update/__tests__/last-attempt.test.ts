import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearHostDownloadFailure,
  readHostDownloadFailure,
  readHostUpdateLastAttempt,
  removeHostUpdateLastAttempt,
  writeHostUpdateLastAttempt,
} from "../last-attempt";

const valid = {
  command: "host apply",
  initiator: "desktop",
  outcome: "complete",
  targetVersion: "1.5.2",
  attemptId: null,
  code: null,
  message: null,
  recordedAt: "2026-11-01T07:05:10.795Z",
};

describe("readHostUpdateLastAttempt", () => {
  let home = "";

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "update-last-attempt-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function read(text: string): Promise<unknown> {
    await writeFile(join(home, "update-last-attempt.json"), text);
    return readHostUpdateLastAttempt(home);
  }

  it("reads what the writer wrote", async () => {
    expect(await read(JSON.stringify(valid))).toEqual(valid);
  });

  it("no file is no last attempt", async () => {
    expect(await readHostUpdateLastAttempt(home)).toBeNull();
  });

  it.each([
    ["torn bytes", '{"command":'],
    ["not an object", "null"],
    ["an unknown command", JSON.stringify({ ...valid, command: "host stop" })],
    ["an unknown initiator", JSON.stringify({ ...valid, initiator: "x" })],
    ["an unknown outcome", JSON.stringify({ ...valid, outcome: "x" })],
    ["a missing timestamp", JSON.stringify({ ...valid, recordedAt: 1 })],
    ["a non-string version", JSON.stringify({ ...valid, targetVersion: 1 })],
    ["a non-string attempt", JSON.stringify({ ...valid, attemptId: 1 })],
    ["a non-string code", JSON.stringify({ ...valid, code: 1 })],
    ["a non-string message", JSON.stringify({ ...valid, message: 1 })],
  ])("%s reads as none, never as a wrong answer", async (_name, text) => {
    expect(await read(text)).toBeNull();
  });
});

describe("writeHostUpdateLastAttempt", () => {
  let home = "";

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "update-last-attempt-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const attempt = {
    command: "host update",
    initiator: "desktop",
    outcome: "failed",
    targetVersion: "1.5.2",
    attemptId: null,
    code: null,
    message: null,
  } as const;

  async function recorded(message: string): Promise<string | null> {
    await writeHostUpdateLastAttempt(
      home,
      { ...attempt, message },
      { info: vi.fn() },
    );
    return (await readHostUpdateLastAttempt(home))?.message ?? null;
  }

  it.each([
    [
      "this account's home",
      `EACCES: open '${join(homedir(), ".traycer", "lock")}'`,
      `EACCES: open '${join("~", ".traycer", "lock")}'`,
    ],
    [
      "another account's macOS home",
      "EPERM: /Users/alice/.traycer/lock",
      "EPERM: /Users/<redacted>/.traycer/lock",
    ],
    [
      "another account's Linux home",
      "held from /home/alice/.traycer",
      "held from /home/<redacted>/.traycer",
    ],
    [
      "a Windows home, spaces and all",
      "EBUSY: C:\\Users\\Jo Bloggs\\.traycer\\lock",
      "EBUSY: C:\\Users\\<redacted>\\.traycer\\lock",
    ],
    [
      "an email",
      "signed in as jo.bloggs@example.com, refused",
      "signed in as <redacted>, refused",
    ],
    [
      "a signed URL",
      "GET https://cdn.example.com/a?X-Amz-Signature=abc123 returned 503",
      "GET https://cdn.example.com/a?X-Amz-Signature=<redacted> returned 503",
    ],
    [
      "URL credentials",
      "GET https://jo:hunter2@mirror.example.com/a failed",
      "GET https://<redacted>@mirror.example.com/a failed",
    ],
    ["a bearer token", "sent Bearer abc.def.ghi", "sent Bearer <redacted>"],
    [
      "a token behind another scheme",
      "authorization: token ghs_abcdefghijklmnopqrstuvwxyz0123456789",
      "authorization: token <redacted>",
    ],
    [
      "a token in a JSON body",
      '{"accessToken":"sekret123"}',
      '{"accessToken":<redacted>}',
    ],
  ])("keeps %s out of the record", async (_name, message, expected) => {
    expect(await recorded(message)).toBe(expected);
  });

  it.each([
    ["any case", "c:\\users\\alice\\x", "c:\\users\\<redacted>\\x"],
    [
      "a JSON-escaped path",
      "C:\\\\Users\\\\alice",
      "C:\\\\Users\\\\<redacted>",
    ],
    ["a plural mount", "/homes/alice/x", "/homes/<redacted>/x"],
  ])("keeps a home out of %s", async (_name, message, expected) => {
    expect(await recorded(message)).toBe(expected);
  });

  it.each([
    [
      "after a path that ends at a home",
      "cannot read /Users/bob as it is locked; run 'traycer host status' next",
      "cannot read /Users/<redacted> as it is locked; run 'traycer host status' next",
    ],
    [
      "after a sentence that ends at a home",
      "EPERM /Users/alice. Run traycer host status",
      "EPERM /Users/<redacted> Run traycer host status",
    ],
    [
      "in a URL that merely has a home segment",
      "GET https://example.com/home/page.html returned 500",
      "GET https://example.com/home/page.html returned 500",
    ],
  ])("keeps the sentence %s", async (_name, message, expected) => {
    expect(await recorded(message)).toBe(expected);
  });

  it("leaves a version whole", async () => {
    await writeHostUpdateLastAttempt(
      home,
      { ...attempt, targetVersion: "1.5.2-staging.181.g0e77910" },
      { info: vi.fn() },
    );
    expect(await readHostUpdateLastAttempt(home)).toMatchObject({
      targetVersion: "1.5.2-staging.181.g0e77910",
    });
  });

  describe("with this account's home somewhere unusual", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    function homeIs(path: string): void {
      vi.stubEnv("HOME", path);
      vi.stubEnv("USERPROFILE", path);
    }

    it.each([
      ["outside the usual roots", "/var/lib/ali", "/var/lib/ali/x", "~/x"],
      ["named by one letter", "/data/a", "open /data/a/lock", "open ~/lock"],
      [
        "a sibling sharing its prefix",
        "/data/ali",
        "/data/alicia/x",
        "/data/alicia/x",
      ],
      ["behind a domain", "/data/alice", "CORP\\alice", "CORP\\<redacted>"],
      ["on another path", "/data/alice", "/mnt/alice/x", "/mnt/<redacted>/x"],
      ["at a sentence end", "/data/alice", "/srv/alice.", "/srv/<redacted>."],
      [
        "as a mailbox",
        "/data/alice",
        "from alice@example.com, refused",
        "from <redacted>, refused",
      ],
      [
        "as a mail domain too",
        "/data/alice",
        "from alice@alice-consulting.com",
        "from <redacted>",
      ],
      [
        "and a home named like a root",
        "/data/home",
        "/home/bob/.traycer",
        "/<redacted>/<redacted>/.traycer",
      ],
      [
        "as a word a message needs",
        "/data/traycer",
        "run 'traycer host install' first",
        "run 'traycer host install' first",
      ],
    ])("%s", async (_name, path, message, expected) => {
      homeIs(path);
      expect(await recorded(message)).toBe(expected);
    });

    it.each([
      ["an empty", ""],
      ["the root", "/"],
    ])("%s home leaves the other rules working", async (_name, path) => {
      homeIs(path);
      expect(await recorded("sent Bearer abc at /Users/bob/x")).toBe(
        "sent Bearer <redacted> at /Users/<redacted>/x",
      );
    });

    it("a root home does not read a bare root as a home", async () => {
      homeIs("/");
      expect(await recorded("cannot write to / now")).toBe(
        "cannot write to / now",
      );
    });
  });

  it("does not spend seconds on one enormous token", async () => {
    const startedAt = Date.now();
    await recorded("x".repeat(200_000));
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("keeps a home out of a target typed on the command line", async () => {
    await writeHostUpdateLastAttempt(
      home,
      { ...attempt, targetVersion: "/Users/alice/build/host" },
      { info: vi.fn() },
    );
    expect(await readHostUpdateLastAttempt(home)).toMatchObject({
      targetVersion: "/Users/<redacted>/build/host",
    });
  });

  it("keeps a home out of the log when the write itself fails", async () => {
    await mkdir(join(home, "update-last-attempt.json"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    const info = vi.fn();
    try {
      await writeHostUpdateLastAttempt(home, attempt, { info });
    } finally {
      vi.unstubAllEnvs();
    }
    const [, fields] = info.mock.calls[0] ?? [];
    expect(fields.error).toContain("~");
    expect(fields.error).not.toContain(home);
  });

  it("bounds what a long stderr can put on disk", async () => {
    expect((await recorded("x".repeat(5_000)))?.length).toBe(2_003);
  });
});

describe("a download's failure", () => {
  let home = "";

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "update-last-attempt-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const failure = {
    command: "host download",
    initiator: "desktop",
    outcome: "failed",
    targetVersion: "1.5.2",
    attemptId: null,
    code: null,
    message: null,
  } as const;
  const parked = {
    ...failure,
    command: "host update",
    outcome: "parked",
    attemptId: "attempt-1",
  } as const;

  it("leaves the update it ran beside standing", async () => {
    await writeHostUpdateLastAttempt(home, parked, { info: vi.fn() });
    await writeHostUpdateLastAttempt(home, failure, { info: vi.fn() });

    expect(await readHostUpdateLastAttempt(home)).toMatchObject(parked);
    expect(await readHostDownloadFailure(home)).toMatchObject(failure);
  });

  it("is cleared alone when a download gets through", async () => {
    await writeHostUpdateLastAttempt(home, parked, { info: vi.fn() });
    await writeHostUpdateLastAttempt(home, failure, { info: vi.fn() });

    await clearHostDownloadFailure(home);

    expect(await readHostDownloadFailure(home)).toBeNull();
    expect(await readHostUpdateLastAttempt(home)).toMatchObject(parked);
  });

  it.each(["complete", "applied"] as const)(
    "goes when an update ends %s, leaving that update's record",
    async (outcome) => {
      await writeHostUpdateLastAttempt(home, failure, { info: vi.fn() });
      await writeHostUpdateLastAttempt(
        home,
        { ...parked, outcome },
        { info: vi.fn() },
      );

      expect(await readHostDownloadFailure(home)).toBeNull();
      expect(await readHostUpdateLastAttempt(home)).toMatchObject({ outcome });
    },
  );

  it.each(["no-op", "parked", "refused", "failed"] as const)(
    "stays when an update ends %s",
    async (outcome) => {
      await writeHostUpdateLastAttempt(home, failure, { info: vi.fn() });
      await writeHostUpdateLastAttempt(
        home,
        { ...parked, outcome },
        { info: vi.fn() },
      );

      expect(await readHostDownloadFailure(home)).not.toBeNull();
    },
  );

  it("goes with the install", async () => {
    await writeHostUpdateLastAttempt(home, parked, { info: vi.fn() });
    await writeHostUpdateLastAttempt(home, failure, { info: vi.fn() });

    await removeHostUpdateLastAttempt(home);

    expect(await readHostDownloadFailure(home)).toBeNull();
    expect(await readHostUpdateLastAttempt(home)).toBeNull();
  });
});
