import { afterEach, describe, expect, it, vi } from "vitest";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import { createLocalHostInventoryStreamClient } from "../local-host-inventory-subscription";
import { LocalOpenAuth } from "@traycer-clients/shared/host-transport/local-open-auth";
import { RunnerHostInvoke } from "../../../ipc-contracts/ipc-channels";
import { buildHostManagementBridge } from "../../../electron-preload/host-management-bridge";
import {
  invalidateMainLocalAdmission,
  onMainLocalAdmissionInvalidated,
} from "../local-admission-invalidation";

const HOST_ID = "main-inventory-local-host";
const endpoint = {
  hostId: HOST_ID,
  websocketUrl: "ws://127.0.0.1:4917/rpc",
};

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));
let cleanupInventory: (() => void) | null = null;

vi.mock("electron", () => ({
  ipcRenderer: { invoke: mocks.invoke },
}));

afterEach(() => {
  cleanupInventory?.();
  cleanupInventory = null;
  vi.clearAllMocks();
});

describe("main local team grant invalidation", () => {
  it("routes the renderer invalidation through the shared channel to the inventory auth client", async () => {
    const inventoryAuth = new LocalOpenAuth({
      provisionMember: null,
      mintSessionGrant: async () => ({ kind: "unavailable" }),
    });
    inventoryAuth.noteSessionGrantRequired(HOST_ID);
    const bearer = new MutableBearerLease(
      "inventory-user-bearer",
      "inventory-test-user",
    );
    const membershipRefusal = {
      code: "TEAM_MEMBERSHIP_REQUIRED",
      reason: "membership required",
      incompatibleMethods: null,
      upgradeGuidance: null,
    } as const;
    inventoryAuth.noteRefusal(HOST_ID, bearer, membershipRefusal);
    const registeredAuthInvalidation = vi.spyOn(
      inventoryAuth,
      "onHostInvalidated",
    );
    const openInventoryStream = createLocalHostInventoryStreamClient({
      localOpenAuth: inventoryAuth,
      localHost: () => endpoint,
      bearer: () => bearer,
      appVersion: "test",
    });
    const inventoryClient = openInventoryStream(endpoint);
    const detach = onMainLocalAdmissionInvalidated((hostId) => {
      inventoryAuth.invalidateHost(hostId, null);
    });
    cleanupInventory = () => {
      detach();
      inventoryClient.close("test-teardown");
    };

    mocks.invoke.mockImplementation(
      (channel: string, hostId: string | undefined) => {
        if (
          channel === RunnerHostInvoke.invalidateLocalTeamAdmission &&
          typeof hostId === "string"
        ) {
          invalidateMainLocalAdmission(hostId);
        }
        return Promise.resolve(undefined);
      },
    );
    const hostManagement = buildHostManagementBridge();

    expect(registeredAuthInvalidation).toHaveBeenCalledTimes(1);
    expect(inventoryAuth.requiresSessionGrant(HOST_ID)).toBe(true);
    await expect(
      inventoryAuth.ensureMemberReady(
        endpoint,
        bearer,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: "refused", fatal: membershipRefusal });
    await hostManagement.invalidateLocalTeamAdmission?.(HOST_ID);

    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(
      RunnerHostInvoke.invalidateLocalTeamAdmission,
      HOST_ID,
    );
    expect(inventoryAuth.revisionFor(HOST_ID)).toBe(1);
    expect(inventoryAuth.requiresSessionGrant(HOST_ID)).toBe(false);
    await expect(
      inventoryAuth.ensureMemberReady(
        endpoint,
        bearer,
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: "ready" });
  });
});
