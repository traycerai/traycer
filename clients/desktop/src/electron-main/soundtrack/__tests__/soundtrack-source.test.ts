import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createSoundtrackSource,
  type SoundtrackSourceOptions,
} from "../soundtrack-source";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MANIFEST_URL =
  "https://storage.googleapis.com/traycerai-dev-soundtrack/sets/team/v1.json";
const READ_ONLY_SCOPE = "https://www.googleapis.com/auth/devstorage.read_only";
const CLIENT_EMAIL = "signer@fixture.iam.example";
const ACCESS_TOKEN = "access-token-fixture";
const NOW_MS = 1_800_000_000_000;

let keyDir: string;
let keyFilePath: string;

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  keyDir = mkdtempSync(join(tmpdir(), "traycer-soundtrack-key-test-"));
  keyFilePath = join(keyDir, "key.json");
  writeFileSync(
    keyFilePath,
    JSON.stringify({
      client_email: CLIENT_EMAIL,
      private_key: privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
      private_key_id: "key-id-fixture",
    }),
  );
});

afterAll(() => {
  rmSync(keyDir, { recursive: true, force: true });
});

const TRACKS = [{ name: "marker-track" }];
const VIEWS = { home: ["marker-track"], task: [], bot: [], settings: [] };

function publishedManifest(stems: unknown) {
  return { version: 1, tracks: TRACKS, views: VIEWS, stems };
}

const POOLED_AND_GROUPED = publishedManifest({
  tracks: [
    {
      name: "marker-track",
      layers: [
        {
          name: "A",
          files: ["marker-track/a/1.opus", "marker-track/a/2.opus"],
        },
        {
          name: "G",
          groups: [
            { name: "x", files: ["marker-track/x/1.opus"] },
            { name: "y", files: ["marker-track/y/1.opus"] },
          ],
        },
      ],
    },
  ],
});

function manifestWithFile(path: string) {
  return publishedManifest({
    tracks: [{ name: "marker-track", layers: [{ name: "A", files: [path] }] }],
  });
}

type Route = (url: string) => Promise<Response>;

const warn = vi.fn<(message: string) => void>();
const fetchMock = vi.fn<typeof fetch>();

function routes(options: { token: Route; manifest: Route }): void {
  fetchMock.mockImplementation((input) => {
    const url = String(input);
    if (url === TOKEN_URL) return options.token(url);
    if (url === MANIFEST_URL) return options.manifest(url);
    return Promise.reject(new Error(`unexpected request ${url}`));
  });
}

const grantsToken: Route = () =>
  Promise.resolve(Response.json({ access_token: ACCESS_TOKEN }));

function answers(body: unknown): Route {
  return () => Promise.resolve(Response.json(body));
}

function source(overrides: Partial<SoundtrackSourceOptions>) {
  return createSoundtrackSource({
    keyFilePath,
    audience: "audience-fixture",
    set: "team",
    manifestVersion: 1,
    fetch: fetchMock,
    now: () => NOW_MS,
    warn,
    ...overrides,
  });
}

function readerOf(overrides: Partial<SoundtrackSourceOptions>) {
  const created = source(overrides);
  if (created === null) throw new Error("expected a soundtrack source");
  return created;
}

function signedFilesOf(manifest: unknown): string[] {
  const text = JSON.stringify(manifest);
  return [...text.matchAll(/https:\/\/[^"]+/g)].map((match) => match[0]);
}

beforeEach(() => {
  fetchMock.mockReset();
  warn.mockReset();
});

describe("createSoundtrackSource", () => {
  it("is null with no key", () => {
    expect(source({ keyFilePath: null })).toBeNull();
  });

  it("is null with no audience", () => {
    expect(source({ audience: "" })).toBeNull();
  });
});

describe("read", () => {
  it("answers every stem file, pooled and grouped, as a signed url and leaves tracks and views alone", async () => {
    routes({ token: grantsToken, manifest: answers(POOLED_AND_GROUPED) });

    const result = await readerOf({}).read();

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.manifest).toMatchObject({
      version: 1,
      tracks: TRACKS,
      views: VIEWS,
    });
    const urls = signedFilesOf(result.manifest);
    expect(urls.map((url) => new URL(url).pathname)).toEqual([
      "/traycerai-dev-soundtrack/sets/team/marker-track/a/1.opus",
      "/traycerai-dev-soundtrack/sets/team/marker-track/a/2.opus",
      "/traycerai-dev-soundtrack/sets/team/marker-track/x/1.opus",
      "/traycerai-dev-soundtrack/sets/team/marker-track/y/1.opus",
    ]);
    for (const url of urls) {
      const query = new URL(url).searchParams;
      expect(query.get("X-Goog-Credential")).toContain(`${CLIENT_EMAIL}/`);
      expect(query.get("X-Goog-Signature")).toMatch(/^[0-9a-f]+$/);
    }
  });

  it("reads v2 when requested and signs its complete recording", async () => {
    const v2Url = MANIFEST_URL.replace("v1.json", "v2.json");
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url === TOKEN_URL) return grantsToken(url);
      if (url === v2Url)
        return Promise.resolve(
          Response.json({
            version: 2,
            tracks: [
              {
                kind: "composed",
                name: "piece",
                title: "Piece",
                recording: "master",
              },
            ],
            views: { home: ["piece"], task: [], bot: [], settings: [] },
            stems: {
              tracks: [],
              recordings: [{ name: "master", file: "piece/master.opus" }],
            },
          }),
        );
      return Promise.reject(new Error("unexpected request"));
    });
    const result = await readerOf({ manifestVersion: 2 }).read();
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const urls = signedFilesOf(result.manifest);
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]).pathname).toBe(
      "/traycerai-dev-soundtrack/sets/team/piece/master.opus",
    );
    expect(new URL(urls[0]).searchParams.get("X-Goog-Signature")).toMatch(
      /^[0-9a-f]+$/,
    );
  });

  it("rejects a recording path escaping the set without exposing a URL", async () => {
    const v2Url = MANIFEST_URL.replace("v1.json", "v2.json");
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url === TOKEN_URL) return grantsToken(url);
      if (url === v2Url)
        return Promise.resolve(
          Response.json({
            version: 2,
            tracks: [],
            views: VIEWS,
            stems: {
              tracks: [],
              recordings: [{ name: "master", file: "../outside.opus" }],
            },
          }),
        );
      return Promise.reject(new Error("unexpected request"));
    });
    await expect(readerOf({ manifestVersion: 2 }).read()).resolves.toEqual({
      kind: "unavailable",
    });
    expect(warn).toHaveBeenCalled();
    expect(
      warn.mock.calls.every(([message]) => !message.includes("https://")),
    ).toBe(true);
  });

  it("asks for a read-only storage token with no target audience", async () => {
    routes({ token: grantsToken, manifest: answers(POOLED_AND_GROUPED) });

    await readerOf({}).read();

    const tokenCall = fetchMock.mock.calls.find(
      ([input]) => String(input) === TOKEN_URL,
    );
    const form = new URLSearchParams(String(tokenCall?.[1]?.body));
    const claims: unknown = JSON.parse(
      Buffer.from(
        (form.get("assertion") ?? "").split(".")[1],
        "base64url",
      ).toString("utf8"),
    );
    expect(claims).toMatchObject({ iss: CLIENT_EMAIL, scope: READ_ONLY_SCOPE });
    expect(claims).not.toHaveProperty("target_audience");
  });

  it("fetches the manifest with the bearer, and never from the browser cache", async () => {
    routes({ token: grantsToken, manifest: answers(POOLED_AND_GROUPED) });

    await readerOf({}).read();

    const manifestCall = fetchMock.mock.calls.find(
      ([input]) => String(input) === MANIFEST_URL,
    );
    expect(manifestCall?.[1]?.headers).toEqual({
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    });
    expect(manifestCall?.[1]?.cache).toBe("no-store");
  });

  it("mints one token for two reads", async () => {
    routes({ token: grantsToken, manifest: answers(POOLED_AND_GROUPED) });
    const reader = readerOf({});

    await reader.read();
    await reader.read();

    const tokenRequests = fetchMock.mock.calls.filter(
      ([input]) => String(input) === TOKEN_URL,
    );
    expect(tokenRequests).toHaveLength(1);
  });

  const unavailable: readonly (readonly [string, () => void])[] = [
    [
      "a bucket 404",
      () =>
        routes({
          token: grantsToken,
          manifest: () => Promise.resolve(new Response("", { status: 404 })),
        }),
    ],
    [
      "a malformed manifest",
      () => routes({ token: grantsToken, manifest: answers({ version: 1 }) }),
    ],
    [
      "a stem path leaving its set",
      () =>
        routes({
          token: grantsToken,
          manifest: answers(manifestWithFile("../x.opus")),
        }),
    ],
    [
      "an absolute stem path",
      () =>
        routes({
          token: grantsToken,
          manifest: answers(manifestWithFile("/x.opus")),
        }),
    ],
    [
      "a failed token exchange",
      () =>
        routes({
          token: () => Promise.resolve(new Response("{}", { status: 400 })),
          manifest: answers(POOLED_AND_GROUPED),
        }),
    ],
    [
      "a rejected fetch",
      () =>
        routes({
          token: grantsToken,
          manifest: () =>
            Promise.reject(new Error(`reset while holding ${ACCESS_TOKEN}`)),
        }),
    ],
  ];

  it.each(unavailable)(
    "answers unavailable on %s, logging neither a token nor a signed url",
    async (_label, arrange) => {
      arrange();

      await expect(readerOf({}).read()).resolves.toEqual({
        kind: "unavailable",
      });

      expect(warn).toHaveBeenCalled();
      for (const [message] of warn.mock.calls) {
        expect(message).not.toContain(ACCESS_TOKEN);
        expect(message).not.toContain("X-Goog-Signature");
        expect(message).not.toContain("https://");
      }
    },
  );
});
