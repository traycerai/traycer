import type {
  BrowserViewNativeTabKey,
  BrowserViewTileKey,
} from "../../ipc-contracts/browser-view-types";

export interface BrowserViewEntryKey extends BrowserViewTileKey {
  readonly windowId: string;
}

export interface RegisteredBrowserViewEntry {
  surface: BrowserViewEntryKey | null;
  readonly guestKey: string;
}

/** Owns the atomic relationship between a browser guest and its optional UI surface. */
export class BrowserViewEntryRegistry<
  Entry extends RegisteredBrowserViewEntry,
> {
  private readonly entriesByGuestKey = new Map<string, Entry>();
  private readonly entriesBySurfaceKey = new Map<string, Entry>();

  register(entry: Entry): void {
    const existingGuest = this.entriesByGuestKey.get(entry.guestKey);
    if (existingGuest !== undefined && existingGuest !== entry) {
      throw new Error(
        `Browser guest key is already registered: ${entry.guestKey}`,
      );
    }
    if (entry.surface !== null)
      this.assertSurfaceAvailable(entry.surface, entry);
    this.entriesByGuestKey.set(entry.guestKey, entry);
    if (entry.surface !== null) {
      this.entriesBySurfaceKey.set(browserViewSurfaceKey(entry.surface), entry);
    }
  }

  getGuest(guestKey: string): Entry | undefined {
    return this.entriesByGuestKey.get(guestKey);
  }

  getSurface(surface: BrowserViewEntryKey): Entry | undefined {
    return this.getSurfaceByKey(browserViewSurfaceKey(surface));
  }

  getSurfaceByKey(surfaceKey: string): Entry | undefined {
    return this.entriesBySurfaceKey.get(surfaceKey);
  }

  hasSurfaceKey(surfaceKey: string): boolean {
    return this.entriesBySurfaceKey.has(surfaceKey);
  }

  bindSurface(entry: Entry, surface: BrowserViewEntryKey): void {
    this.assertRegistered(entry);
    this.assertSurfaceAvailable(surface, entry);
    this.detachSurface(entry);
    entry.surface = surface;
    this.entriesBySurfaceKey.set(browserViewSurfaceKey(surface), entry);
  }

  detachSurface(entry: Entry): BrowserViewEntryKey | null {
    const surface = entry.surface;
    if (surface === null) return null;
    const surfaceKey = browserViewSurfaceKey(surface);
    if (this.entriesBySurfaceKey.get(surfaceKey) === entry) {
      this.entriesBySurfaceKey.delete(surfaceKey);
    }
    entry.surface = null;
    return surface;
  }

  remove(entry: Entry): void {
    this.detachSurface(entry);
    if (this.entriesByGuestKey.get(entry.guestKey) === entry) {
      this.entriesByGuestKey.delete(entry.guestKey);
    }
  }

  isCurrent(entry: Entry): boolean {
    return this.entriesByGuestKey.get(entry.guestKey) === entry;
  }

  guestValues(): IterableIterator<Entry> {
    return this.entriesByGuestKey.values();
  }

  surfaceValues(): IterableIterator<Entry> {
    return this.entriesBySurfaceKey.values();
  }

  surfaceEntries(): IterableIterator<[string, Entry]> {
    return this.entriesBySurfaceKey.entries();
  }

  private assertRegistered(entry: Entry): void {
    if (!this.isCurrent(entry)) {
      throw new Error(`Browser guest is not registered: ${entry.guestKey}`);
    }
  }

  private assertSurfaceAvailable(
    surface: BrowserViewEntryKey,
    entry: Entry,
  ): void {
    const surfaceKey = browserViewSurfaceKey(surface);
    const occupant = this.entriesBySurfaceKey.get(surfaceKey);
    if (occupant !== undefined && occupant !== entry) {
      throw new Error(`Browser surface is already occupied: ${surfaceKey}`);
    }
  }
}

export function browserViewSurfaceKey(key: BrowserViewEntryKey): string {
  return [key.windowId, key.viewTabId, key.paneId, key.tileInstanceId].join(
    "\u001f",
  );
}

export function nativeBrowserViewGuestKey(
  key: BrowserViewNativeTabKey,
): string {
  return ["native", key.hostId, key.sessionId, key.tabId].join("\u001f");
}

export function unmanagedBrowserViewGuestKey(pageSessionId: string): string {
  return ["unmanaged", pageSessionId].join("\u001f");
}
