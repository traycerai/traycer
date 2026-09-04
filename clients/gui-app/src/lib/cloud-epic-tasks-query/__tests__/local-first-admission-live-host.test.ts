import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type { HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { readNegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import { createAppQueryClient } from "@/lib/query-client";
import {
  liveHostServesLocalFirst,
  negotiatedListTasksServesLocalFirst,
} from "@/lib/cloud-epic-tasks-query/local-first-admission";

/**
 * The registry keeps a host's LAST handshake until traffic replaces it, so a
 * host rolled back under the same id reads as local-first until something
 * re-handshakes. `liveHostServesLocalFirst` is that something: it forces a
 * floor-method read and decides on what the live process advertised.
 *
 * The mock messenger does not handshake, so each case's `host.status`
 * handler stands in for the `openAck` the real transport records - which is
 * exactly the seam under test: the answer must come from what the PROBE
 * writes, never from what the registry held before it.
 */
const HOST_ID = mockLocalHostEntry.hostId;

const hostStatus: ResponseOfMethod<HostRpcRegistry, "host.status"> = {
  ready: true,
  hostVersion: "1.2.3",
  protocolVersion: { major: 1, minor: 0 },
  busy: false,
  busySessionCount: 0,
  updateProgress: null,
  busyBreakdown: null,
  updateOperation: null,
  updateTransaction: null,
};

function clientWhoseHandshakeAdvertises(
  onProbe: () => void,
): HostClient<HostRpcRegistry> {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(createAppQueryClient()),
    findHostById: (hostId) => (hostId === HOST_ID ? mockLocalHostEntry : null),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-probe",
      handlers: {
        "host.status": () => {
          onProbe();
          return hostStatus;
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(mockLocalHostEntry);
}

beforeEach(() => {
  resetNegotiatedManifests();
  // The retained evidence: the host that last handshook served `@1.6`.
  recordNegotiatedHostManifest(HOST_ID, {
    "epic.listTasks": { major: 1, minor: 6 },
  });
});

afterEach(() => {
  resetNegotiatedManifests();
});

describe("liveHostServesLocalFirst", () => {
  it("refuses when the live host's handshake advertises a pre-local-first line the registry still remembered as 1.6", async () => {
    // Non-vacuity: the render-time read admits on the retained record.
    expect(
      negotiatedListTasksServesLocalFirst(
        readNegotiatedMethodVersion(HOST_ID, "epic.listTasks"),
      ),
    ).toBe(true);
    let probes = 0;
    const client = clientWhoseHandshakeAdvertises(() => {
      probes += 1;
      recordNegotiatedHostManifest(HOST_ID, {
        "epic.listTasks": { major: 1, minor: 5 },
      });
    });

    await expect(liveHostServesLocalFirst(client, HOST_ID)).resolves.toBe(
      false,
    );
    expect(probes).toBe(1);
  });

  it("admits when the live host's handshake confirms the local-first line", async () => {
    const client = clientWhoseHandshakeAdvertises(() => {
      recordNegotiatedHostManifest(HOST_ID, {
        "epic.listTasks": { major: 1, minor: 6 },
      });
    });

    await expect(liveHostServesLocalFirst(client, HOST_ID)).resolves.toBe(true);
  });

  it("refuses when the probe itself fails - no live evidence, no admission", async () => {
    const client = clientWhoseHandshakeAdvertises(() => {
      throw new Error("host unreachable (test)");
    });

    await expect(liveHostServesLocalFirst(client, HOST_ID)).resolves.toBe(
      false,
    );
  });
});
