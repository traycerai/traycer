/**
 * The number on the phone's app icon. The native plugin, the stored sign-in
 * and the resume edge are fakes. A null plugin is the Android shell, which
 * stores the count and writes nothing.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  StoredCredentials,
  SystemResumeEvent,
  TokenStoreChange,
} from "@traycer-clients/shared/platform/runner-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";
import {
  MobileAppIconBadge,
  type AppBadgeForegroundSource,
  type AppBadgePluginSlice,
} from "../src/app-badge";
import type { StoredSignInSource } from "../src/signed-in-user";

vi.mock("@capacitor/core", () => ({
  registerPlugin: () => ({
    setCount: () =>
      Promise.reject(new Error("the module plugin is not under test")),
  }),
}));

const COUNT_ERROR = "The app icon count must be a non-negative integer.";
const USER_A = "user-a";
const USER_B = "user-b";

function credentials(userId: string): StoredCredentials {
  return {
    token: `bearer-${userId}`,
    refreshToken: `refresh-${userId}`,
    savedAt: "2026-08-05T00:00:00.000Z",
    user: { id: userId, email: `${userId}@example.com`, name: userId },
  };
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

class ForegroundDouble implements AppBadgeForegroundSource {
  private readonly handlers = new Set<(event: SystemResumeEvent) => void>();

  subscribe(handler: (event: SystemResumeEvent) => void): Disposable {
    this.handlers.add(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }

  resume(): void {
    const event: SystemResumeEvent = {
      backgroundedForMs: 1,
      screenLocked: false,
    };
    for (const handler of [...this.handlers]) handler(event);
  }
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function defer(): Deferred {
  let settle = (): void => {
    throw new Error("deferred resolved before its executor ran");
  };
  const promise = new Promise<void>((resolve) => {
    settle = () => resolve();
  });
  return { promise, resolve: () => settle() };
}

class RecordingBadge implements AppBadgePluginSlice {
  readonly counts: number[] = [];
  private current: Deferred | null = null;

  setCount(options: { readonly count: number }): Promise<void> {
    this.counts.push(options.count);
    const deferred = defer();
    this.current = deferred;
    return deferred.promise;
  }

  pendingWrite(): Promise<void> {
    if (this.current === null) throw new Error("no badge write is in flight");
    return this.current.promise;
  }

  release(): void {
    if (this.current === null) throw new Error("no badge write is in flight");
    const resolve = this.current.resolve;
    this.current = null;
    resolve();
  }
}

async function whenSignedInIsKnown(signIn: SignInDouble): Promise<void> {
  await signIn.get();
}

async function settleWrite(plugin: RecordingBadge): Promise<void> {
  const pending = plugin.pendingWrite();
  plugin.release();
  await pending;
}

describe("MobileAppIconBadge", () => {
  it("names the attention count and writes it again on every resume", async () => {
    const plugin = new RecordingBadge();
    const signIn = new SignInDouble(credentials(USER_A));
    const foreground = new ForegroundDouble();
    const badge = new MobileAppIconBadge(plugin, signIn, foreground);
    await whenSignedInIsKnown(signIn);

    expect(badge.countSource).toBe("attention");
    const written = badge.setCount(4);
    expect(plugin.counts).toEqual([4]);
    await settleWrite(plugin);
    await written;

    foreground.resume();
    expect(plugin.counts).toEqual([4, 4]);
    await settleWrite(plugin);

    foreground.resume();
    expect(plugin.counts).toEqual([4, 4, 4]);
    await settleWrite(plugin);
  });

  it("writes nothing when the shell has no badge plugin", async () => {
    const signIn = new SignInDouble(credentials(USER_A));
    const foreground = new ForegroundDouble();
    const badge = new MobileAppIconBadge(null, signIn, foreground);
    await whenSignedInIsKnown(signIn);

    await expect(badge.setCount(3)).resolves.toBeUndefined();
    foreground.resume();
  });

  it("keeps a single native write in flight and folds later counts into the latest", async () => {
    const plugin = new RecordingBadge();
    const signIn = new SignInDouble(credentials(USER_A));
    const foreground = new ForegroundDouble();
    const badge = new MobileAppIconBadge(plugin, signIn, foreground);
    await whenSignedInIsKnown(signIn);

    const first = badge.setCount(1);
    const second = badge.setCount(2);
    const third = badge.setCount(5);
    expect(plugin.counts).toEqual([1]);
    await settleWrite(plugin);
    expect(plugin.counts).toEqual([1, 5]);
    await settleWrite(plugin);
    await first;
    await second;
    await third;
  });

  it("drops pending counts on sign-out and writes 0", async () => {
    const plugin = new RecordingBadge();
    const signIn = new SignInDouble(credentials(USER_A));
    const foreground = new ForegroundDouble();
    const badge = new MobileAppIconBadge(plugin, signIn, foreground);
    await whenSignedInIsKnown(signIn);

    const written = badge.setCount(1);
    void badge.setCount(4);
    void badge.setCount(9);
    signIn.replace(null);
    expect(plugin.counts).toEqual([1]);
    await settleWrite(plugin);
    expect(plugin.counts).toEqual([1, 0]);
    await settleWrite(plugin);
    expect(plugin.counts).toEqual([1, 0]);
    await written;
  });

  it("writes 0 when the account changes, then the new account's count", async () => {
    const plugin = new RecordingBadge();
    const signIn = new SignInDouble(credentials(USER_A));
    const foreground = new ForegroundDouble();
    const badge = new MobileAppIconBadge(plugin, signIn, foreground);
    await whenSignedInIsKnown(signIn);

    const written = badge.setCount(4);
    await settleWrite(plugin);
    await written;
    signIn.replace(credentials(USER_B));
    expect(plugin.counts).toEqual([4, 0]);
    await settleWrite(plugin);
    const next = badge.setCount(2);
    expect(plugin.counts).toEqual([4, 0, 2]);
    await settleWrite(plugin);
    await next;
  });

  it("writes 0 for a count handed over while signed out", async () => {
    const plugin = new RecordingBadge();
    const signIn = new SignInDouble(null);
    const foreground = new ForegroundDouble();
    const badge = new MobileAppIconBadge(plugin, signIn, foreground);
    await whenSignedInIsKnown(signIn);

    const written = badge.setCount(6);
    expect(plugin.counts).toEqual([0]);
    await settleWrite(plugin);
    await written;
    foreground.resume();
    expect(plugin.counts).toEqual([0, 0]);
    await settleWrite(plugin);
  });

  it("writes 0 when a count handed over before the sign-in is read turns out signed out", async () => {
    const plugin = new RecordingBadge();
    const signIn = new SignInDouble(null);
    const foreground = new ForegroundDouble();
    const badge = new MobileAppIconBadge(plugin, signIn, foreground);

    const written = badge.setCount(6);
    expect(plugin.counts).toEqual([6]);
    await whenSignedInIsKnown(signIn);
    await settleWrite(plugin);
    expect(plugin.counts).toEqual([6, 0]);
    await settleWrite(plugin);
    await written;
    foreground.resume();
    expect(plugin.counts).toEqual([6, 0, 0]);
    await settleWrite(plugin);
  });

  it("rejects a count that is negative or not an integer", async () => {
    const plugin = new RecordingBadge();
    const signIn = new SignInDouble(credentials(USER_A));
    const foreground = new ForegroundDouble();
    const badge = new MobileAppIconBadge(plugin, signIn, foreground);
    await whenSignedInIsKnown(signIn);

    await expect(badge.setCount(-1)).rejects.toThrow(COUNT_ERROR);
    await expect(badge.setCount(1.5)).rejects.toThrow(COUNT_ERROR);
    expect(plugin.counts).toEqual([]);
  });
});
