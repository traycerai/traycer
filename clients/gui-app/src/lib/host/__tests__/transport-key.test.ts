import { describe, expect, it } from "vitest";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostTransportKey,
  dialableHostEndpoint,
} from "@/lib/host/transport-key";

function entry(overrides: Partial<HostDirectoryEntry>): HostDirectoryEntry {
  return {
    hostId: "host-a",
    label: "Host A",
    kind: "local",
    websocketUrl: "ws://127.0.0.1:9/stream",
    version: "1.2.3",
    status: "available",
    ...overrides,
  };
}

describe("dialableHostEndpoint", () => {
  it("returns the endpoint for an available, dialable entry", () => {
    expect(dialableHostEndpoint(entry({}))).toEqual({
      hostId: "host-a",
      websocketUrl: "ws://127.0.0.1:9/stream",
    });
  });

  it("returns null when not dialable or not available", () => {
    expect(dialableHostEndpoint(null)).toBeNull();
    expect(dialableHostEndpoint(entry({ websocketUrl: null }))).toBeNull();
    expect(dialableHostEndpoint(entry({ status: "unavailable" }))).toBeNull();
  });

  it("agrees with hostTransportKey on dialability", () => {
    // A non-null transport key must imply a dialable endpoint (the durable
    // streams gate on the key but dial the endpoint), and vice-versa.
    const dialable = entry({});
    const undialable = entry({ websocketUrl: null });
    expect(hostTransportKey(dialable)).not.toBeNull();
    expect(dialableHostEndpoint(dialable)).not.toBeNull();
    expect(hostTransportKey(undialable)).toBeNull();
    expect(dialableHostEndpoint(undialable)).toBeNull();
  });
});
