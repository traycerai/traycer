/**
 * The number on the phone's app icon while the app runs: the red attention
 * count its Notifications row shows. While the app is closed the server's
 * count pushes set the iPhone's icon, so the app writes its count again each
 * time it comes back to the front, even when the number did not change.
 *
 * iOS only: `ios/App/App/AppBadgePlugin.swift`. Android has no badge call; its
 * launcher shows what it shows for the notifications in the list, and the
 * shell stores the count without writing it.
 */
import { registerPlugin } from "@capacitor/core";
import type {
  IAppIconBadgeHost,
  StoredCredentials,
  SystemResumeEvent,
  TokenStoreChange,
} from "@traycer-clients/shared/platform/runner-host";
import type { Disposable } from "@traycer-clients/shared/platform/uri-callback";

/** The native plugin's surface. Tests fake this boundary. */
export interface AppBadgePluginSlice {
  setCount(options: { readonly count: number }): Promise<void>;
}

export const AppBadge = registerPlugin<AppBadgePluginSlice>("AppBadge");

/** The stored sign-in and its change feed (`ITokenStore` satisfies this). */
export interface AppBadgeSignInSource {
  get(): Promise<StoredCredentials | null>;
  subscribe(listener: (change: TokenStoreChange) => void): Disposable;
}

/** The app coming back to the front. */
export interface AppBadgeForegroundSource {
  subscribe(handler: (event: SystemResumeEvent) => void): Disposable;
}

export class MobileAppIconBadge implements IAppIconBadgeHost {
  readonly countSource = "attention";
  private count = 0;
  /** The signed-in user; `undefined` until the stored sign-in is first read. */
  private userId: string | null | undefined = undefined;
  private writeWanted = false;
  private drain: Promise<void> | null = null;
  private lastWriteError: unknown = null;

  /** `plugin` is `null` where nothing is written (Android, the web entry). */
  constructor(
    private readonly plugin: AppBadgePluginSlice | null,
    signIn: AppBadgeSignInSource,
    foreground: AppBadgeForegroundSource,
  ) {
    signIn.subscribe((change) => this.noteSignedInUser(change.userId));
    void signIn.get().then(
      (stored) => {
        if (this.userId === undefined) this.userId = stored?.user.id ?? null;
      },
      () => undefined,
    );
    foreground.subscribe(() => {
      void this.write();
    });
  }

  async setCount(count: number): Promise<void> {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error("The app icon count must be a non-negative integer.");
    }
    // Signed out there is nothing to count; a count still on its way from
    // the account that left is not shown.
    this.count = this.userId === null ? 0 : count;
    await this.write();
    if (this.lastWriteError !== null) throw this.lastWriteError;
  }

  /**
   * A sign-out or a different account: the count the GUI had is the old
   * account's, so 0 replaces it, and a write still waiting writes 0 instead.
   */
  private noteSignedInUser(userId: string | null): void {
    if (userId === this.userId) return;
    const known = this.userId !== undefined;
    this.userId = userId;
    if (!known) return;
    this.count = 0;
    void this.write();
  }

  /**
   * One native write at a time, always of the latest count: a write asked for
   * while one is running is folded into the next.
   */
  private write(): Promise<void> {
    if (this.plugin === null) return Promise.resolve();
    this.writeWanted = true;
    this.drain ??= this.runWrites(this.plugin);
    return this.drain;
  }

  private async runWrites(plugin: AppBadgePluginSlice): Promise<void> {
    try {
      while (this.writeWanted) {
        this.writeWanted = false;
        try {
          await plugin.setCount({ count: this.count });
          this.lastWriteError = null;
        } catch (error) {
          this.lastWriteError = error;
        }
      }
    } finally {
      this.drain = null;
    }
  }
}
