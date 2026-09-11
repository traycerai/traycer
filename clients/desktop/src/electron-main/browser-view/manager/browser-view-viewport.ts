import { randomUUID } from "node:crypto";
import {
  browserViewportGeometrySchema,
  type BrowserViewportGeometry,
} from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserViewElectronViewport,
  BrowserViewGuestViewportResult,
  BrowserViewGuestViewportRequested,
} from "@traycer-clients/shared/platform/browser-view";
import { RunnerHostEvent } from "../../../ipc-contracts/ipc-channels";
import type { BrowserViewEntry, BrowserViewSend } from "./browser-view-entry";
import type { BrowserViewEntryRegistry } from "./browser-view-entry-registry";
import type { BrowserViewAnnotationHost } from "./browser-view-annotation-host";
import type { BrowserViewDebugSessions } from "./debug-session-for";
import { applyEntryZoom } from "./browser-view-entry-factory";

interface ViewportEntry {
  latest: BrowserViewElectronViewport;
  confirmed: BrowserViewElectronViewport | null;
  confirmedZoom: number | null;
  work: Promise<void>;
}

class UnrepresentableViewportError extends Error {}

interface PendingPresentation {
  readonly entry: BrowserViewEntry;
  readonly revision: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** Orders native metrics with the persistent renderer guest's intrinsic size. */
export class BrowserViewViewport {
  private readonly states = new Map<BrowserViewEntry, ViewportEntry>();
  private readonly pending = new Map<string, PendingPresentation>();

  constructor(
    private readonly entries: BrowserViewEntryRegistry<BrowserViewEntry>,
    private readonly annotations: BrowserViewAnnotationHost,
    private readonly debugSessions: BrowserViewDebugSessions,
    private readonly send: BrowserViewSend,
  ) {}

  apply(
    entry: BrowserViewEntry,
    input: BrowserViewElectronViewport,
  ): Promise<BrowserViewportGeometry> {
    const state = this.states.get(entry) ?? {
      latest: input,
      confirmed: null,
      confirmedZoom: null,
      work: Promise.resolve(),
    };
    if (
      input.connectionId === state.latest.connectionId &&
      input.revision < state.latest.revision
    ) {
      return Promise.reject(
        new Error("A newer viewport request already exists."),
      );
    }
    state.latest = input;
    this.states.set(entry, state);
    const applied = state.work.then(async () => {
      this.requireCurrent(entry, state, input);
      await this.annotations.preserveBeforeViewportChange(entry);
      this.requireCurrent(entry, state, input);
      const before = state.confirmed ?? {
        ...input,
        intent: { mode: "fit" as const },
        geometry: await this.readGeometry(entry),
      };
      try {
        const geometry = await this.land(entry, input);
        this.requireCurrent(entry, state, input);
        state.confirmed = { ...input, geometry };
        state.confirmedZoom = entry.webContents.getZoomFactor();
        return geometry;
      } catch (error) {
        if (this.entries.isCurrent(entry)) {
          try {
            await this.land(entry, { ...before, revision: input.revision });
          } catch {
            state.confirmed = null;
            throw new Error(
              "The previous viewport could not be restored. Reset to Fit to recover.",
            );
          }
        }
        throw error;
      }
    });
    state.work = applied.then(
      () => undefined,
      () => undefined,
    );
    return applied;
  }

  setZoom(entry: BrowserViewEntry, factor: number): Promise<void> {
    const state = this.states.get(entry);
    if (state === undefined) {
      applyEntryZoom(entry, factor);
      return Promise.resolve();
    }
    const work = state.work.then(async () => {
      if (!this.entries.isCurrent(entry) || this.states.get(entry) !== state) {
        throw new Error("The browser tab is no longer available.");
      }
      const previous = entry.webContents.getZoomFactor();
      if (!applyEntryZoom(entry, factor)) return;
      try {
        await this.refreshConfirmed(entry, state);
      } catch (error) {
        applyEntryZoom(entry, previous);
        await this.refreshConfirmed(entry, state);
        throw error;
      }
    });
    state.work = work.catch(() => undefined);
    return work;
  }

  /** Whether recovery changed page zoom after navigation published status. */
  refreshAfterNavigation(entry: BrowserViewEntry): Promise<boolean> {
    const state = this.states.get(entry);
    if (state === undefined) return Promise.resolve(false);
    const work = state.work.then(async () => {
      const previousZoom = state.confirmedZoom;
      try {
        await this.refreshConfirmed(entry, state);
        return false;
      } catch (error) {
        if (
          !(error instanceof UnrepresentableViewportError) ||
          previousZoom === null
        ) {
          throw error;
        }
        // Electron can choose a saved origin zoom on navigation. Keep the
        // tab's last working zoom if that origin cannot represent its size.
        const originZoom = entry.webContents.getZoomFactor();
        entry.webContents.setZoomFactor(previousZoom);
        await this.refreshConfirmed(entry, state);
        return entry.webContents.getZoomFactor() !== originZoom;
      }
    });
    state.work = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  private async refreshConfirmed(
    entry: BrowserViewEntry,
    state: ViewportEntry,
  ): Promise<void> {
    const confirmed = state.confirmed;
    if (
      confirmed === null ||
      !this.entries.isCurrent(entry) ||
      this.states.get(entry) !== state
    )
      return;
    const geometry =
      confirmed.intent.mode === "fixed"
        ? await this.land(entry, {
            ...confirmed,
            revision: state.latest.revision,
          })
        : await this.readGeometry(entry);
    state.confirmed = { ...confirmed, geometry };
    state.confirmedZoom = entry.webContents.getZoomFactor();
  }

  reportPresentation(
    windowId: string,
    result: BrowserViewGuestViewportResult,
  ): void {
    const pending = this.pending.get(result.requestId);
    if (
      pending === undefined ||
      pending.entry.identity.lifecycleWindowId !== windowId ||
      pending.entry.identity.registrationId !== result.registrationId ||
      pending.revision !== result.revision
    )
      return;
    this.pending.delete(result.requestId);
    clearTimeout(pending.timer);
    if (result.applied && this.entries.isCurrent(pending.entry))
      pending.resolve();
    else
      pending.reject(
        new Error("The browser guest could not apply its viewport."),
      );
  }

  forget(entry: BrowserViewEntry): void {
    this.states.delete(entry);
    for (const [requestId, pending] of this.pending) {
      if (pending.entry !== entry) continue;
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(
        new Error("The browser guest closed during viewport resize."),
      );
    }
  }

  private requireCurrent(
    entry: BrowserViewEntry,
    state: ViewportEntry,
    input: BrowserViewElectronViewport,
  ): void {
    if (!this.entries.isCurrent(entry) || this.states.get(entry) !== state) {
      throw new Error("The browser tab is no longer available.");
    }
    if (state.latest !== input) {
      throw new Error("A newer viewport request superseded this resize.");
    }
  }

  private land(
    entry: BrowserViewEntry,
    input: BrowserViewElectronViewport,
  ): Promise<BrowserViewportGeometry> {
    return withinViewportDeadline((signal) =>
      this.applyNativeGeometry(entry, input, signal),
    );
  }

  private async applyNativeGeometry(
    entry: BrowserViewEntry,
    input: BrowserViewElectronViewport,
    signal: AbortSignal,
  ): Promise<BrowserViewportGeometry> {
    const zoom = entry.webContents.getZoomFactor();
    let width = Math.max(1, Math.round(input.geometry.width * zoom));
    let height = Math.max(1, Math.round(input.geometry.height * zoom));
    const debug = this.debugSessions.ensure(entry);
    await debug.enableAfterCommit();
    signal.throwIfAborted();
    // The guest's intrinsic CSS size is the native viewport authority. Clear
    // stale agent/device metrics before changing that size, so Chromium never
    // paints an old emulated layout into a differently scaled new surface.
    await debug.sendCommand(
      "Emulation.clearDeviceMetricsOverride",
      {},
      undefined,
    );
    signal.throwIfAborted();
    if (!this.entries.isCurrent(entry))
      throw new Error("The browser tab closed during resize.");
    // Chromium takes whole native pixels. Try the adjacent pixel if rounding
    // misses; below 100% some CSS widths have no exact native representation.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.present(entry, {
        revision: input.revision,
        intent: input.intent,
        zoom,
        width,
        height,
      });
      signal.throwIfAborted();
      const applied = await this.readGeometry(entry);
      signal.throwIfAborted();
      if (input.intent.mode === "fit") return applied;
      if (
        applied.width === input.intent.width &&
        applied.height === input.intent.height
      ) {
        return applied;
      }
      width += Math.sign(input.intent.width - applied.width);
      height += Math.sign(input.intent.height - applied.height);
    }
    throw new UnrepresentableViewportError(
      "This viewport cannot be represented exactly at the current page zoom. Change page zoom and try again.",
    );
  }

  private readGeometry(
    entry: BrowserViewEntry,
  ): Promise<BrowserViewportGeometry> {
    return withinViewportDeadline(async (signal) => {
      const value = await entry.webContents.executeJavaScript(
        "({width:innerWidth,height:innerHeight,dpr:Math.round(devicePixelRatio*1000000)/1000000})",
        false,
      );
      signal.throwIfAborted();
      const parsed = browserViewportGeometrySchema.safeParse(value);
      if (!parsed.success)
        throw new Error("The browser did not report a valid viewport.");
      return parsed.data;
    });
  }

  private present(
    entry: BrowserViewEntry,
    presentation: Omit<
      BrowserViewGuestViewportRequested,
      "requestId" | "registrationId"
    >,
  ): Promise<void> {
    const requestId = randomUUID();
    const { revision } = presentation;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("The browser did not confirm its viewport in time."));
      }, 4_000);
      this.pending.set(requestId, { entry, revision, resolve, reject, timer });
      if (
        !this.send(
          entry.identity.lifecycleWindowId,
          RunnerHostEvent.browserViewGuestViewportRequested,
          {
            requestId,
            registrationId: entry.identity.registrationId,
            ...presentation,
          },
        )
      ) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(
          new Error("The browser window is unavailable for viewport resize."),
        );
      }
    });
  }
}

function withinViewportDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        "The browser did not apply its viewport in time.",
      );
      controller.abort(error);
      reject(error);
    }, 4_000);
  });
  return Promise.race([work(controller.signal), timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}
