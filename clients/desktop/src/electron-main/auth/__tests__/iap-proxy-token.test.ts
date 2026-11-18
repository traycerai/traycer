import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createCachedIapTokenProvider,
  resolveIapKeyFilePath,
} from "../iap-proxy-token";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUDIENCE = "audience-fixture.apps.googleusercontent.example";
const CLIENT_EMAIL = "signer@fixture.iam.example";
const ID_TOKEN = "id-token-fixture";
const MINUTE_MS = 60 * 1000;

const dirs: string[] = [];
let keyDir: string;
let keyFilePath: string;
let publicKeyPem: string;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "traycer-iap-token-test-"));
  dirs.push(dir);
  return dir;
}

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  keyDir = mkdtempSync(join(tmpdir(), "traycer-iap-key-test-"));
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

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function tokenResponse(): Response {
  return new Response(JSON.stringify({ id_token: ID_TOKEN }), { status: 200 });
}

function decodePart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function provider(
  fetchMock: typeof fetch,
  options: { now?: () => number; warn?: (message: string) => void },
) {
  return createCachedIapTokenProvider({
    keyFilePath,
    audience: AUDIENCE,
    fetch: fetchMock,
    now: options.now ?? (() => 1_800_000_000_000),
    warn: options.warn ?? (() => {}),
  });
}

describe("createCachedIapTokenProvider", () => {
  it("answers null and makes no request without a key file", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const get = createCachedIapTokenProvider({
      keyFilePath: null,
      audience: AUDIENCE,
      fetch: fetchMock,
      now: Date.now,
      warn: () => {},
    });

    expect(await get()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers null and makes no request with an empty audience", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const get = createCachedIapTokenProvider({
      keyFilePath,
      audience: "",
      fetch: fetchMock,
      now: Date.now,
      warn: () => {},
    });

    expect(await get()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exchanges a signed assertion for the id-token", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => tokenResponse());

    expect(await provider(fetchMock, {})()).toBe(ID_TOKEN);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(TOKEN_URL);
    expect(init?.method).toBe("POST");
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
    const [header, claims, signature] = (form.get("assertion") ?? "").split(
      ".",
    );
    expect(decodePart(header)).toMatchObject({
      alg: "RS256",
      kid: "key-id-fixture",
    });
    expect(decodePart(claims)).toMatchObject({
      iss: CLIENT_EMAIL,
      aud: TOKEN_URL,
      target_audience: AUDIENCE,
    });
    const verifier = createVerify("RSA-SHA256").update(`${header}.${claims}`);
    expect(verifier.verify(publicKeyPem, signature, "base64url")).toBe(true);
  });

  it("reuses the token until five minutes before it expires", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => tokenResponse());
    let now = 1_800_000_000_000;
    const get = provider(fetchMock, { now: () => now });

    await get();
    now += 49 * MINUTE_MS;
    expect(await get()).toBe(ID_TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now += 2 * MINUTE_MS;
    expect(await get()).toBe(ID_TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("answers null on a refused exchange, says why, and tries again next time", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(tokenResponse());
    const warn = vi.fn<(message: string) => void>();
    const get = provider(fetchMock, { warn });

    expect(await get()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("HTTP 400");

    expect(await get()).toBe(ID_TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("answers null when the key file is unreadable", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const warn = vi.fn<(message: string) => void>();
    const get = createCachedIapTokenProvider({
      keyFilePath: join(tempDir(), "absent.json"),
      audience: AUDIENCE,
      fetch: fetchMock,
      now: Date.now,
      warn,
    });

    expect(await get()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("shares one request between concurrent callers", async () => {
    let release: (response: Response) => void = () => {};
    const fetchMock = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const get = provider(fetchMock, {});

    const pending = Promise.all([get(), get(), get()]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    release(tokenResponse());

    expect(await pending).toEqual([ID_TOKEN, ID_TOKEN, ID_TOKEN]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("resolveIapKeyFilePath", () => {
  it("answers null without a resources path", () => {
    expect(resolveIapKeyFilePath(undefined)).toBeNull();
    expect(resolveIapKeyFilePath("")).toBeNull();
  });

  it("answers null when the packaged key is absent", () => {
    expect(resolveIapKeyFilePath(tempDir())).toBeNull();
  });

  it("answers the packaged key's path when it is present", () => {
    const resources = tempDir();
    mkdirSync(join(resources, "keys"));
    const key = join(resources, "keys", "iap-service-account.json");
    writeFileSync(key, "{}");

    expect(resolveIapKeyFilePath(resources)).toBe(key);
  });
});
