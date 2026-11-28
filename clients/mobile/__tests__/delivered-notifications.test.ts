/**
 * The phone's delivered-notification list. The plugin, the sign-in, the
 * foreground edges and the network edge are fakes. The recipient is the real
 * SHA-256 prefix, and the two route tests call the real entry-states helper
 * against a stubbed fetch. Every removal assertion is the list the plugin was
 * asked to remove.
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  utf8Bytes,
  webCryptoSha256Hex,
} from "@traycer-clients/shared/cloud-chat/bytes";
import { fetchNotificationEntryStatesViaHttp } from "@traycer-clients/shared/host-client/notification-entry-states";
import type {
  NotificationEntryState,
  NotificationEntryStatesFetchResult,
} from "@traycer-clients/shared/host-client/notification-entry-states";
import type {
  StoredCredentials,
  TokenStoreChange,
} from "@traycer-clients/shared/platform/runner-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";
import type { StoredSignInSource } from "../src/signed-in-user";
import {
  MobileDeliveredNotifications,
  type DeliveredNotification,
  type DeliveredNotificationList,
  type DeliveredNotificationsForeground,
  type DeliveredNotificationsPlatform,
  type DeliveredNotificationsPluginSlice,
} from "../src/delivered-notifications";

const USER_A = "user-a";
const USER_B = "user-b";
const SERVER = "https://notifications.example";
const ENTRY_STATES_URL = `${SERVER}/api/notification-feed/entry-states`;
const READ_AT = 1_700_000_000_000;
const CLEARED_AT = 1_700_000_100_000;
const FAILED: NotificationEntryStatesFetchResult = {
  kind: "network-error",
  detail: "the entry-states request did not complete",
};

let recipientA = "";
let recipientB = "";

beforeAll(async () => {
  recipientA = (await webCryptoSha256Hex(utf8Bytes(USER_A))).slice(0, 16);
  recipientB = (await webCryptoSha256Hex(utf8Bytes(USER_B))).slice(0, 16);
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function entryId(n: number): string {
  return `abcdefab-cdef-4abc-8def-${n.toString(16).padStart(12, "0")}`;
}

function credentials(userId: string): StoredCredentials {
  return {
    token: `bearer-${userId}`,
    refreshToken: `refresh-${userId}`,
    savedAt: "2026-08-05T00:00:00.000Z",
    user: { id: userId, email: `${userId}@example.com`, name: userId },
  };
}

function ios(id: string, recipient: string): DeliveredNotification {
  return { data: { entryId: id, recipient } };
}

function iosWithoutRecipient(id: string): DeliveredNotification {
  return { data: { entryId: id } };
}

function android(tag: string): DeliveredNotification {
  return { tag, data: null };
}

function traycerTag(recipient: string, id: string): string {
  return `trc1:${recipient}:${id}`;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function defer<T>(): Deferred<T> {
  let settle = (value: T): void => {
    throw new Error(
      `deferred resolved before its executor ran: ${String(value)}`,
    );
  };
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (value: T) => settle(value) };
}

interface HeldCall<A, T> {
  readonly arg: A;
  readonly response: Promise<T>;
  readonly resolve: (value: T) => void;
}

class HeldLog<A, T> {
  private readonly calls: HeldCall<A, T>[] = [];
  private readonly waiters = new Map<number, (call: HeldCall<A, T>) => void>();

  get count(): number {
    return this.calls.length;
  }

  hold(arg: A): Promise<T> {
    const deferred = defer<T>();
    const call: HeldCall<A, T> = {
      arg,
      response: deferred.promise,
      resolve: deferred.resolve,
    };
    const index = this.calls.length;
    this.calls.push(call);
    const waiter = this.waiters.get(index);
    if (waiter !== undefined) {
      this.waiters.delete(index);
      waiter(call);
    }
    return deferred.promise;
  }

  finish(arg: A, value: T): Promise<T> {
    const pending = this.hold(arg);
    const call = this.calls[this.calls.length - 1];
    if (call === undefined) throw new Error("a held call was not recorded");
    call.resolve(value);
    return pending;
  }

  at(index: number): Promise<HeldCall<A, T>> {
    const existing = this.calls[index];
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve) => {
      this.waiters.set(index, resolve);
    });
  }

  recorded(): readonly A[] {
    return this.calls.map((call) => call.arg);
  }
}

async function settled<A, T>(
  log: HeldLog<A, T>,
  index: number,
): Promise<HeldCall<A, T>> {
  const call = await log.at(index);
  await call.response;
  return call;
}

class SignInDouble implements StoredSignInSource {
  private stored: StoredCredentials | null;
  private revision = 0;
  private readonly listeners = new Set<(change: TokenStoreChange) => void>();

  constructor(stored: StoredCredentials | null) {
    this.stored = stored;
  }

  get(): Promise<StoredCredentials | null> {
    return Promise.resolve(this.stored);
  }

  subscribe(listener: (change: TokenStoreChange) => void): Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  replace(stored: StoredCredentials | null): void {
    this.stored = stored;
    this.revision += 1;
    const change: TokenStoreChange = {
      present: stored !== null,
      userId: stored === null ? null : stored.user.id,
      revision: this.revision,
    };
    for (const listener of [...this.listeners]) listener(change);
  }
}

class ForegroundDouble implements DeliveredNotificationsForeground {
  private backgrounded: boolean;
  private readonly resumes = new Set<() => void>();
  private readonly backgrounds = new Set<() => void>();

  constructor(backgrounded: boolean) {
    this.backgrounded = backgrounded;
  }

  isBackgrounded(): boolean {
    return this.backgrounded;
  }

  subscribe(handler: () => void): Disposable {
    this.resumes.add(handler);
    return {
      dispose: () => {
        this.resumes.delete(handler);
      },
    };
  }

  subscribeBackground(handler: () => void): Disposable {
    this.backgrounds.add(handler);
    return {
      dispose: () => {
        this.backgrounds.delete(handler);
      },
    };
  }

  resume(): void {
    this.backgrounded = false;
    for (const handler of [...this.resumes]) handler();
  }

  background(): void {
    this.backgrounded = true;
    for (const handler of [...this.backgrounds]) handler();
  }
}

class NetworkDouble {
  private readonly handlers = new Set<() => void>();

  subscribe(handler: () => void): Disposable {
    this.handlers.add(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }

  recover(): void {
    for (const handler of [...this.handlers]) handler();
  }
}

class DeliveredPlugin implements DeliveredNotificationsPluginSlice {
  listed: DeliveredNotification[];
  readonly removed: DeliveredNotification[][] = [];
  readonly gets = new HeldLog<null, DeliveredNotificationList>();
  readonly removes = new HeldLog<readonly DeliveredNotification[], undefined>();
  holdRemoves = false;

  constructor(listed: readonly DeliveredNotification[]) {
    this.listed = [...listed];
  }

  getDeliveredNotifications(): Promise<DeliveredNotificationList> {
    return this.gets.finish(null, { notifications: this.listed.slice() });
  }

  removeDeliveredNotifications(
    delivered: DeliveredNotificationList,
  ): Promise<void> {
    const notifications = delivered.notifications.slice();
    this.removed.push(notifications);
    this.listed = this.listed.filter((item) => !notifications.includes(item));
    if (this.holdRemoves) return this.removes.hold(notifications);
    return this.removes.finish(notifications, undefined);
  }
}

type Lookup = (
  bearerToken: string,
  entryIds: readonly string[],
) => Promise<NotificationEntryStatesFetchResult>;

interface LookupAsk {
  readonly bearer: string;
  readonly entryIds: readonly string[];
}

interface Harness {
  readonly list: MobileDeliveredNotifications;
  readonly signIn: SignInDouble;
  readonly foreground: ForegroundDouble;
  readonly network: NetworkDouble;
  readonly plugin: DeliveredPlugin;
  readonly lookups: HeldLog<LookupAsk, NotificationEntryStatesFetchResult>;
}

function mount(input: {
  readonly platform: DeliveredNotificationsPlatform;
  readonly userId: string | null;
  readonly listed: readonly DeliveredNotification[];
  readonly backgrounded: boolean;
  readonly lookup: Lookup;
  readonly lookups: HeldLog<LookupAsk, NotificationEntryStatesFetchResult>;
}): Harness {
  const signIn = new SignInDouble(
    input.userId === null ? null : credentials(input.userId),
  );
  const foreground = new ForegroundDouble(input.backgrounded);
  const network = new NetworkDouble();
  const plugin = new DeliveredPlugin(input.listed);
  const list = new MobileDeliveredNotifications({
    plugin,
    platform: input.platform,
    signIn,
    lookup: input.lookup,
    foreground,
    networkRecovered: network,
    sha256Hex: webCryptoSha256Hex,
  });
  list.start();
  return {
    list,
    signIn,
    foreground,
    network,
    plugin,
    lookups: input.lookups,
  };
}

interface FakeLookup {
  readonly lookups: HeldLog<LookupAsk, NotificationEntryStatesFetchResult>;
  readonly lookup: Lookup;
  hold: boolean;
}

function fakeLookup(
  answer: (ask: LookupAsk) => NotificationEntryStatesFetchResult,
): FakeLookup {
  const lookups = new HeldLog<LookupAsk, NotificationEntryStatesFetchResult>();
  const fake: FakeLookup = {
    lookups,
    hold: false,
    lookup: (bearerToken, entryIds) => {
      const ask: LookupAsk = { bearer: bearerToken, entryIds: [...entryIds] };
      if (fake.hold) return lookups.hold(ask);
      return lookups.finish(ask, answer(ask));
    },
  };
  return fake;
}

function found(
  id: string,
  readAt: number | null,
  clearedAt: number | null,
): NotificationEntryState {
  return { entryId: id, state: "found", readAt, clearedAt };
}

function foundResult(
  entryIds: readonly string[],
  readAt: number | null,
  clearedAt: number | null,
): NotificationEntryStatesFetchResult {
  return {
    kind: "ok",
    entries: entryIds.map((id) => found(id, readAt, clearedAt)),
  };
}

function answersFor(
  specs: readonly NotificationEntryState[],
): (ask: LookupAsk) => NotificationEntryStatesFetchResult {
  const byId = new Map(specs.map((spec) => [spec.entryId, spec]));
  return (ask) => ({
    kind: "ok",
    entries: ask.entryIds.map((id) => {
      const spec = byId.get(id);
      if (spec !== undefined) return spec;
      return { entryId: id, state: "notFound" as const };
    }),
  });
}

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly authorization: string;
  readonly entryIds: readonly string[];
}

let fetches = new HeldLog<FetchCall, Response>();

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function readEntryIds(body: string): readonly string[] {
  const parsed: unknown = JSON.parse(body);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("entryIds" in parsed)
  ) {
    throw new Error("entry-states body has no entryIds");
  }
  const raw = parsed.entryIds;
  if (!Array.isArray(raw)) throw new Error("entryIds is not an array");
  const ids: string[] = [];
  for (const id of raw) {
    if (typeof id !== "string") throw new Error("an entry id was not a string");
    ids.push(id);
  }
  return ids;
}

function readFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): FetchCall {
  if (init === undefined) throw new Error("entry-states request has no init");
  if (init.method !== "POST") {
    throw new Error(`entry-states method was ${String(init.method)}`);
  }
  if (typeof init.body !== "string") {
    throw new Error("entry-states body was not a string");
  }
  const authorization = new Headers(init.headers).get("authorization");
  if (authorization === null) {
    throw new Error("entry-states request has no authorization");
  }
  return {
    url: requestUrl(input),
    method: init.method,
    authorization,
    entryIds: readEntryIds(init.body),
  };
}

function stubFetch(respond: ((call: FetchCall) => Response) | null): void {
  fetches = new HeldLog<FetchCall, Response>();
  vi.stubGlobal(
    "fetch",
    (
      input: RequestInfo | URL,
      init: RequestInit | undefined,
    ): Promise<Response> => {
      const call = readFetch(input, init);
      if (respond === null) return fetches.hold(call);
      return fetches.finish(call, respond(call));
    },
  );
}

function httpLookup(
  bearerToken: string,
  entryIds: readonly string[],
): Promise<NotificationEntryStatesFetchResult> {
  return fetchNotificationEntryStatesViaHttp(SERVER, bearerToken, entryIds);
}

function idsFrom(start: number, end: number): string[] {
  const ids: string[] = [];
  for (let n = start; n < end; n += 1) ids.push(entryId(n));
  return ids;
}

describe("MobileDeliveredNotifications", () => {
  it("removes a read or cleared iOS notification, including one with no recipient, and keeps the rest", async () => {
    const read = ios(entryId(1), recipientA);
    const cleared = ios(entryId(2), recipientA);
    const unread = ios(entryId(3), recipientA);
    const missing = ios(entryId(4), recipientA);
    const someoneElse = ios(entryId(5), recipientB);
    const legacyRead = iosWithoutRecipient(entryId(6));
    const legacyUnread = iosWithoutRecipient(entryId(7));
    const legacyCleared = iosWithoutRecipient(entryId(8));
    const upperRead = ios(entryId(9).toUpperCase(), recipientA);
    const fake = fakeLookup(
      answersFor([
        found(entryId(1), READ_AT, null),
        found(entryId(2), null, CLEARED_AT),
        found(entryId(3), null, null),
        { entryId: entryId(4), state: "notFound" },
        found(entryId(6), READ_AT, null),
        found(entryId(7), null, null),
        found(entryId(8), null, CLEARED_AT),
        found(entryId(9), READ_AT, null),
      ]),
    );
    const harness = mount({
      platform: "ios",
      userId: USER_A,
      backgrounded: false,
      listed: [
        read,
        cleared,
        unread,
        missing,
        someoneElse,
        legacyRead,
        legacyUnread,
        legacyCleared,
        upperRead,
      ],
      lookup: fake.lookup,
      lookups: fake.lookups,
    });

    const ask = await settled(harness.lookups, 0);
    expect(ask.arg.bearer).toBe("bearer-user-a");
    expect(ask.arg.entryIds).toEqual([
      entryId(1),
      entryId(2),
      entryId(3),
      entryId(4),
      entryId(6),
      entryId(7),
      entryId(8),
      entryId(9),
    ]);
    await settled(harness.plugin.removes, 4);
    expect(harness.plugin.removed).toEqual([
      [read],
      [cleared],
      [legacyRead],
      [legacyCleared],
      [upperRead],
    ]);
  });

  it("removes a read or cleared Android notification and keeps another recipient, a bad tag, and an uppercase id", async () => {
    const read = android(traycerTag(recipientA, entryId(1)));
    const cleared = android(traycerTag(recipientA, entryId(2)));
    const unread = android(traycerTag(recipientA, entryId(3)));
    const missing = android(traycerTag(recipientA, entryId(4)));
    const someoneElse = android(traycerTag(recipientB, entryId(5)));
    const badTag = android("not-a-traycer-tag");
    const upperId = android(traycerTag(recipientA, entryId(6).toUpperCase()));
    const fake = fakeLookup(
      answersFor([
        found(entryId(1), READ_AT, null),
        found(entryId(2), null, CLEARED_AT),
        found(entryId(3), null, null),
        { entryId: entryId(4), state: "notFound" },
      ]),
    );
    const harness = mount({
      platform: "android",
      userId: USER_A,
      backgrounded: false,
      listed: [read, cleared, unread, missing, someoneElse, badTag, upperId],
      lookup: fake.lookup,
      lookups: fake.lookups,
    });

    const ask = await settled(harness.lookups, 0);
    expect(ask.arg.bearer).toBe("bearer-user-a");
    expect(ask.arg.entryIds).toEqual([
      entryId(1),
      entryId(2),
      entryId(3),
      entryId(4),
    ]);
    await settled(harness.plugin.removes, 1);
    expect(harness.plugin.removed).toEqual([[read], [cleared]]);
  });

  it("removes nothing when the entry-states route is missing, and does not retry", async () => {
    stubFetch(null);
    const notification = ios(entryId(1), recipientA);
    const lookups = new HeldLog<
      LookupAsk,
      NotificationEntryStatesFetchResult
    >();
    const harness = mount({
      platform: "ios",
      userId: USER_A,
      listed: [notification],
      backgrounded: false,
      lookup: httpLookup,
      lookups,
    });

    const first = await fetches.at(0);
    harness.list.noteCloudFeedFrame(USER_A);
    first.resolve(new Response("", { status: 404 }));
    const second = await fetches.at(1);
    expect(harness.plugin.removed).toEqual([]);
    second.resolve(new Response("", { status: 404 }));
    await second.response;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetches.count).toBe(2);
    expect(harness.plugin.removed).toEqual([]);
    expect(first.arg.url).toBe(ENTRY_STATES_URL);
    expect(first.arg.authorization).toBe("Bearer bearer-user-a");
  });

  it("removes nothing when the account signs out while the lookup is in flight", async () => {
    const notification = ios(entryId(1), recipientA);
    const fake = fakeLookup((ask) => foundResult(ask.entryIds, READ_AT, null));
    fake.hold = true;
    const harness = mount({
      platform: "ios",
      userId: USER_A,
      listed: [notification],
      backgrounded: false,
      lookup: fake.lookup,
      lookups: fake.lookups,
    });

    const call = await harness.lookups.at(0);
    harness.signIn.replace(null);
    call.resolve(foundResult(call.arg.entryIds, READ_AT, null));
    await call.response;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.plugin.removed).toEqual([]);
    expect(harness.lookups.count).toBe(1);
    expect(harness.plugin.gets.count).toBe(1);
  });

  it("removes nothing for the account that left when the signed-in user changes during the lookup", async () => {
    const notification = ios(entryId(1), recipientA);
    const fake = fakeLookup((ask) => foundResult(ask.entryIds, READ_AT, null));
    fake.hold = true;
    const harness = mount({
      platform: "ios",
      userId: USER_A,
      listed: [notification],
      backgrounded: false,
      lookup: fake.lookup,
      lookups: fake.lookups,
    });

    const call = await harness.lookups.at(0);
    harness.signIn.replace(credentials(USER_B));
    call.resolve(foundResult(call.arg.entryIds, READ_AT, null));
    await call.response;
    await settled(harness.plugin.gets, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.plugin.removed).toEqual([]);
    expect(harness.lookups.count).toBe(1);
  });

  it("stops before the next removal when the account signs out during a removal", async () => {
    const first = ios(entryId(1), recipientA);
    const second = ios(entryId(2), recipientA);
    const fake = fakeLookup((ask) => foundResult(ask.entryIds, READ_AT, null));
    const harness = mount({
      platform: "ios",
      userId: USER_A,
      listed: [first, second],
      backgrounded: false,
      lookup: fake.lookup,
      lookups: fake.lookups,
    });
    harness.plugin.holdRemoves = true;

    const removal = await harness.plugin.removes.at(0);
    expect(harness.plugin.removed).toEqual([[first]]);
    harness.signIn.replace(null);
    removal.resolve(undefined);
    await removal.response;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.plugin.removed).toEqual([[first]]);
    expect(harness.plugin.gets.count).toBe(1);
  });

  it("runs one reconciliation at a time and keeps a single follow-up", async () => {
    const notification = ios(entryId(1), recipientA);
    const fake = fakeLookup((ask) => foundResult(ask.entryIds, null, null));
    fake.hold = true;
    const harness = mount({
      platform: "ios",
      userId: USER_A,
      listed: [notification],
      backgrounded: false,
      lookup: fake.lookup,
      lookups: fake.lookups,
    });

    const first = await harness.lookups.at(0);
    harness.foreground.resume();
    harness.network.recover();
    harness.list.noteCloudFeedFrame(USER_A);
    harness.list.noteCloudFeedFrame(USER_A);
    expect(harness.lookups.count).toBe(1);
    first.resolve(foundResult(first.arg.entryIds, null, null));
    const second = await harness.lookups.at(1);
    expect(harness.lookups.count).toBe(2);
    second.resolve(foundResult(second.arg.entryIds, null, null));
    await second.response;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.lookups.count).toBe(2);
    expect(harness.plugin.removed).toEqual([]);
  });

  it("asks the entry-states route in two requests when 150 notifications are listed", async () => {
    const ids = idsFrom(0, 150);
    const firstId = itemAt(ids, 0);
    const listed = ids.map((id) => ios(id, recipientA));
    const firstNotification = itemAt(listed, 0);
    stubFetch(
      (call) =>
        new Response(
          JSON.stringify({
            entries: call.entryIds.map((id) => ({
              entryId: id,
              state: "found",
              readAt: id === firstId ? READ_AT : null,
              clearedAt: null,
            })),
          }),
          { status: 200 },
        ),
    );
    const harness = mount({
      platform: "ios",
      userId: USER_A,
      listed,
      backgrounded: true,
      lookup: httpLookup,
      lookups: new HeldLog<LookupAsk, NotificationEntryStatesFetchResult>(),
    });

    await fetches.at(1);
    const firstCall = itemAt(fetches.recorded(), 0);
    const secondCall = itemAt(fetches.recorded(), 1);
    expect(firstCall).toEqual({
      url: ENTRY_STATES_URL,
      method: "POST",
      authorization: "Bearer bearer-user-a",
      entryIds: idsFrom(0, 100),
    });
    expect(secondCall).toEqual({
      url: ENTRY_STATES_URL,
      method: "POST",
      authorization: "Bearer bearer-user-a",
      entryIds: idsFrom(100, 150),
    });
    await settled(harness.plugin.removes, 0);
    expect(harness.plugin.removed).toEqual([[firstNotification]]);
    expect(fetches.count).toBe(2);
  });

  it("removes a read notification when a cloud frame arrives after a resume lookup failed", async () => {
    const notification = ios(entryId(1), recipientA);
    let phase: "unread" | "fail" | "read" = "unread";
    const fake = fakeLookup((ask) => {
      if (phase === "fail") return FAILED;
      return foundResult(ask.entryIds, phase === "read" ? READ_AT : null, null);
    });
    const harness = mount({
      platform: "ios",
      userId: USER_A,
      listed: [notification],
      backgrounded: false,
      lookup: fake.lookup,
      lookups: fake.lookups,
    });

    await settled(harness.lookups, 0);
    phase = "fail";
    harness.foreground.resume();
    await settled(harness.lookups, 1);
    expect(harness.plugin.removed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    phase = "read";
    harness.list.noteCloudFeedFrame(USER_A);
    await settled(harness.plugin.removes, 0);
    expect(harness.plugin.removed).toEqual([[notification]]);
    expect(harness.lookups.count).toBe(3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.lookups.count).toBe(3);
  });

  it("retries a failed lookup at 2s, 5s and 15s, then waits for the next trigger", async () => {
    const fake = fakeLookup((ask) => {
      if (ask.entryIds.length === 0) {
        throw new Error("a retry lookup named no entry");
      }
      return FAILED;
    });
    const harness = mount({
      platform: "ios",
      userId: USER_A,
      listed: [ios(entryId(1), recipientA)],
      backgrounded: true,
      lookup: fake.lookup,
      lookups: fake.lookups,
    });

    await settled(harness.lookups, 0);
    expect(harness.lookups.count).toBe(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(harness.lookups.count).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await settled(harness.lookups, 1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(harness.lookups.count).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await settled(harness.lookups, 2);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(harness.lookups.count).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    await settled(harness.lookups, 3);
    expect(harness.lookups.count).toBe(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.lookups.count).toBe(4);
    expect(harness.plugin.removed).toEqual([]);
    harness.list.noteCloudFeedFrame(USER_A);
    await settled(harness.lookups, 4);
    expect(harness.lookups.count).toBe(5);
  });

  it("polls every 30s while a Traycer notification is listed in the foreground", async () => {
    const fake = fakeLookup((ask) => foundResult(ask.entryIds, null, null));
    const harness = mount({
      platform: "ios",
      userId: USER_A,
      listed: [ios(entryId(1), recipientA)],
      backgrounded: false,
      lookup: fake.lookup,
      lookups: fake.lookups,
    });

    await settled(harness.lookups, 0);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(harness.lookups.count).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await settled(harness.lookups, 1);
    expect(harness.lookups.count).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    await settled(harness.lookups, 2);
    expect(harness.lookups.count).toBe(3);
    expect(harness.plugin.removed).toEqual([]);
  });

  it("stops the poll when the app backgrounds", async () => {
    const fake = fakeLookup((ask) => foundResult(ask.entryIds, null, null));
    const harness = mount({
      platform: "ios",
      userId: USER_A,
      listed: [ios(entryId(1), recipientA)],
      backgrounded: false,
      lookup: fake.lookup,
      lookups: fake.lookups,
    });

    await settled(harness.lookups, 0);
    harness.foreground.background();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.lookups.count).toBe(1);
  });

  it("stops the poll when the account signs out", async () => {
    const fake = fakeLookup((ask) => foundResult(ask.entryIds, null, null));
    const harness = mount({
      platform: "ios",
      userId: USER_A,
      listed: [ios(entryId(1), recipientA)],
      backgrounded: false,
      lookup: fake.lookup,
      lookups: fake.lookups,
    });

    await settled(harness.lookups, 0);
    harness.signIn.replace(null);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.lookups.count).toBe(1);
    expect(harness.plugin.removed).toEqual([]);
  });

  it("stops the poll once the last Traycer notification is removed", async () => {
    const notification = ios(entryId(1), recipientA);
    const fake = fakeLookup((ask) => foundResult(ask.entryIds, READ_AT, null));
    const harness = mount({
      platform: "ios",
      userId: USER_A,
      listed: [notification],
      backgrounded: false,
      lookup: fake.lookup,
      lookups: fake.lookups,
    });

    await settled(harness.plugin.removes, 0);
    expect(harness.plugin.removed).toEqual([[notification]]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.lookups.count).toBe(1);
  });

  it("does not poll when every listed notification belongs to someone else", async () => {
    const fake = fakeLookup((ask) => foundResult(ask.entryIds, READ_AT, null));
    const harness = mount({
      platform: "ios",
      userId: USER_A,
      listed: [ios(entryId(1), recipientB)],
      backgrounded: false,
      lookup: fake.lookup,
      lookups: fake.lookups,
    });

    await settled(harness.plugin.gets, 0);
    expect(harness.lookups.count).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.plugin.gets.count).toBe(1);
    expect(harness.lookups.count).toBe(0);
    expect(harness.plugin.removed).toEqual([]);
  });

  it("ignores a cloud frame for a user who is not signed in", async () => {
    const fake = fakeLookup((ask) => foundResult(ask.entryIds, null, null));
    const harness = mount({
      platform: "ios",
      userId: USER_A,
      listed: [ios(entryId(1), recipientA)],
      backgrounded: true,
      lookup: fake.lookup,
      lookups: fake.lookups,
    });

    await settled(harness.lookups, 0);
    harness.list.noteCloudFeedFrame(USER_B);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.lookups.count).toBe(1);
    harness.list.noteCloudFeedFrame(USER_A);
    await settled(harness.lookups, 1);
    expect(harness.lookups.count).toBe(2);
  });
});

function itemAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`missing item ${index}`);
  return item;
}
