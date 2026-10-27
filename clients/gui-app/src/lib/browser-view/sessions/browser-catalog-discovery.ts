import { backoffFor } from "@traycer-clients/shared/host-transport/backoff";
import { classifyHostRequestFailure } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  BROWSER_CATALOG_MAX_PROBES,
  type BrowserCatalogIdentity,
  type BrowserCatalogReadRequest,
} from "@traycer/protocol/host/browser/catalog-contracts";
import type { BrowserCatalogReadResponse } from "@traycer/protocol/host/browser/discovery-contracts";
import {
  browserCatalogInventory,
  type BrowserCatalogInventoryStore,
  type BrowserCatalogScope,
} from "./browser-catalog-inventory";

export interface BrowserCatalogReader {
  read(
    request: BrowserCatalogReadRequest,
    signal: AbortSignal,
  ): Promise<BrowserCatalogReadResponse>;
}

const REPAIR_MS = 30_000;
const MIN_REFRESH_MS = 5_000;
const MAX_BATCHES_PER_REPAIR = 5;

/** Single active-view repair loop per caller/task, even with several canvases. */
export class BrowserCatalogDiscovery {
  private readonly readers = new Map<symbol, BrowserCatalogReader>();
  private timer: number | null = null;
  private running: AbortController | null = null;
  private requested = false;
  private lastAttempt = Number.NEGATIVE_INFINITY;
  private attempt = 0;
  private probeOffset = 0;
  private readonly tileProbes = new Map<symbol, BrowserCatalogIdentity>();

  constructor(
    private readonly scope: BrowserCatalogScope,
    private readonly inventory: BrowserCatalogInventoryStore,
  ) {}

  acquire(reader: BrowserCatalogReader): () => void {
    const id = Symbol("browser-catalog-reader");
    this.readers.set(id, reader);
    this.refresh();
    return () => {
      this.readers.delete(id);
      if (this.readers.size !== 0) return;
      if (this.timer !== null) window.clearTimeout(this.timer);
      this.timer = null;
      this.running?.abort();
      this.requested = false;
    };
  }

  retainProbe(identity: BrowserCatalogIdentity): () => void {
    if (identity.epicId !== this.scope.epicId)
      throw new Error("Browser tab task does not match.");
    const id = Symbol("browser-tile-probe");
    this.tileProbes.set(id, identity);
    this.refresh();
    return () => {
      this.tileProbes.delete(id);
    };
  }

  refresh = (): void => {
    if (this.readers.size === 0) return;
    this.requested = true;
    if (this.running !== null) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(
      () => {
        this.timer = null;
        void this.repair();
      },
      Math.max(0, this.lastAttempt + MIN_REFRESH_MS - Date.now()),
    );
  };

  private startAttempt(): AbortController {
    const controller = new AbortController();
    this.running = controller;
    this.requested = false;
    this.lastAttempt = Date.now();
    return controller;
  }

  private async readBatch(
    reader: BrowserCatalogReader,
    request: BrowserCatalogReadRequest,
    controller: AbortController,
    epoch: number,
  ): Promise<BrowserCatalogReadResponse> {
    let response = await reader.read(request, controller.signal);
    controller.signal.throwIfAborted();
    if (
      response.kind === "unavailable" &&
      response.reason === "inventory-limit"
    ) {
      await this.inventory.accept(this.scope, response, epoch);
      response = await reader.read(
        { ...request, evidenceOnly: true },
        controller.signal,
      );
      controller.signal.throwIfAborted();
    }
    await this.inventory.accept(this.scope, response, epoch);
    return response;
  }

  private async repair(): Promise<void> {
    const reader = [...this.readers.values()].at(-1);
    if (reader === undefined || this.running !== null) return;
    const controller = this.startAttempt();
    let delay = REPAIR_MS;
    let epoch = this.inventory.epoch(this.scope);
    try {
      await this.inventory.load(this.scope);
      epoch = this.inventory.epoch(this.scope);
      const probes = [
        ...new Map(
          [
            ...this.inventory.probes(this.scope),
            ...this.tileProbes.values(),
          ].map((identity) => [
            JSON.stringify([identity.hostId, identity.sessionId]),
            identity,
          ]),
        ).values(),
      ];
      const batches = Math.max(
        1,
        Math.ceil(probes.length / BROWSER_CATALOG_MAX_PROBES),
      );
      for (
        let index = 0;
        index < Math.min(batches, MAX_BATCHES_PER_REPAIR);
        index += 1
      ) {
        controller.signal.throwIfAborted();
        const offset =
          ((this.probeOffset + index) % batches) * BROWSER_CATALOG_MAX_PROBES;
        const response = await this.readBatch(
          reader,
          {
            epicId: this.scope.epicId,
            ifVersion: this.inventory.read(this.scope).version ?? undefined,
            fenceProbes: probes.slice(
              offset,
              offset + BROWSER_CATALOG_MAX_PROBES,
            ),
            evidenceOnly: index === 0 ? undefined : true,
          },
          controller,
          epoch,
        );
        if (response.kind !== "available") {
          if (response.kind === "unavailable")
            delay = backoffFor(this.attempt++, 2_000, REPAIR_MS);
          break;
        }
        if (
          response.snapshot.kind === "evidence" &&
          this.inventory.read(this.scope).status === "unavailable"
        )
          delay = backoffFor(this.attempt++, 2_000, REPAIR_MS);
        else this.attempt = 0;
      }
      this.probeOffset = (this.probeOffset + MAX_BATCHES_PER_REPAIR) % batches;
    } catch (error) {
      if (!controller.signal.aborted) {
        const response: BrowserCatalogReadResponse =
          classifyHostRequestFailure(error).kind === "downgrade-unsupported"
            ? { kind: "unsupported" }
            : { kind: "unavailable", reason: "cloud" };
        await this.inventory
          .accept(this.scope, response, epoch)
          .catch(() => undefined);
        delay = backoffFor(this.attempt++, 2_000, REPAIR_MS);
      }
    } finally {
      this.running = null;
      if (this.readers.size !== 0) {
        if (this.requested) this.refresh();
        else
          this.timer = window.setTimeout(() => {
            this.timer = null;
            void this.repair();
          }, delay);
      }
    }
  }
}

const discovery = new Map<string, BrowserCatalogDiscovery>();
export function browserCatalogDiscovery(
  scope: BrowserCatalogScope,
): BrowserCatalogDiscovery {
  const key = JSON.stringify([scope.userId, scope.epicId]);
  let entry = discovery.get(key);
  if (entry === undefined) {
    entry = new BrowserCatalogDiscovery(scope, browserCatalogInventory);
    discovery.set(key, entry);
  }
  return entry;
}
