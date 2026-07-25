import type { HostRequestAuthority } from "../host-transport/host-messenger";
import type { HostDirectoryEntry } from "./host-directory";

/** Immutable binding portion of a request authority, shared per host id. */
export interface HostBindingAuthority {
  /** Opaque identity used by the coordinator to compare binding domains. */
  readonly token: object;
  readonly endpoint: HostRequestAuthority["endpoint"];
  readonly abortSignal: AbortSignal;
  readonly providerGeneration: number;
}

interface StoredBindingAuthority extends HostBindingAuthority {
  readonly controller: AbortController;
  readonly transport: HostTransportSnapshot;
}

interface HostTransportSnapshot {
  readonly hostId: string;
  readonly kind: HostDirectoryEntry["kind"];
  readonly websocketUrl: string | null;
  readonly version: string | null;
  readonly status: HostDirectoryEntry["status"];
}

/** A routed entry no longer describes the directory's current transport. */
export class StaleHostBindingAuthorityError extends Error {
  constructor(hostId: string) {
    super(`Host '${hostId}' changed before its request authority was captured`);
    this.name = "StaleHostBindingAuthorityError";
  }
}

/**
 * Owns immutable, abortable host-binding generations. A binding is renewed
 * whenever any meaningful transport field changes, including H1 → H2 → H1;
 * the old generation is aborted before its replacement is exposed.
 */
export class HostBindingAuthorityRegistry {
  private readonly bindings = new Map<string, StoredBindingAuthority>();
  private providerGeneration = 0;
  private disposed = false;

  capture(
    requested: HostDirectoryEntry,
    current: HostDirectoryEntry | null,
  ): HostBindingAuthority {
    if (this.disposed || current === null) {
      const stale = this.bindings.get(requested.hostId);
      stale?.controller.abort("host-binding-stale");
      this.bindings.delete(requested.hostId);
      throw new StaleHostBindingAuthorityError(requested.hostId);
    }
    if (!sameTransport(requested, current)) {
      // The caller's routed entry is stale, not the stored binding. Keep the
      // latter live for default and other routed requests that already hold it.
      throw new StaleHostBindingAuthorityError(requested.hostId);
    }

    const transport = snapshot(current);
    const previous = this.bindings.get(current.hostId);
    if (previous !== undefined && sameSnapshot(previous.transport, transport)) {
      return previous;
    }

    previous?.controller.abort("host-binding-replaced");
    this.providerGeneration += 1;
    const controller = new AbortController();
    const binding: StoredBindingAuthority = {
      token: {},
      endpoint: {
        hostId: transport.hostId,
        websocketUrl: transport.websocketUrl,
      },
      abortSignal: controller.signal,
      providerGeneration: this.providerGeneration,
      controller,
      transport,
    };
    this.bindings.set(current.hostId, binding);
    return binding;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const binding of this.bindings.values()) {
      binding.controller.abort("host-binding-registry-disposed");
    }
    this.bindings.clear();
  }
}

function snapshot(entry: HostDirectoryEntry): HostTransportSnapshot {
  return {
    hostId: entry.hostId,
    kind: entry.kind,
    websocketUrl: entry.websocketUrl,
    version: entry.version,
    status: entry.status,
  };
}

function sameTransport(
  requested: HostDirectoryEntry,
  current: HostDirectoryEntry,
): boolean {
  return sameSnapshot(snapshot(requested), snapshot(current));
}

function sameSnapshot(
  left: HostTransportSnapshot,
  right: HostTransportSnapshot,
): boolean {
  return (
    left.hostId === right.hostId &&
    left.kind === right.kind &&
    left.websocketUrl === right.websocketUrl &&
    left.version === right.version &&
    left.status === right.status
  );
}
