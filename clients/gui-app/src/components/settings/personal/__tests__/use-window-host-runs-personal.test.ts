import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import type { EnvironmentStatusResponseV13 } from "@traycer/protocol/host/environment-schemas";
import { environmentStatusFixture } from "@/lib/environment/__tests__/environment-test-support";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import { useWindowHostRunsPersonal } from "@/components/settings/personal/use-window-host-runs-personal";

const reads = vi.hoisted(() => ({
  data: null as EnvironmentStatusResponseV13 | null,
  isError: false,
  version: null as NegotiatedMethodVersion,
}));

vi.mock("@/hooks/environment/use-environment-reads", () => ({
  useEnvironmentStatusRead: () => ({
    data: reads.data,
    isError: reads.isError,
  }),
}));
vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersion: () => reads.version,
}));

const HOST = hostScopeOptionFixture({ hostId: "host-a" });

afterEach(() => {
  reads.data = null;
  reads.isError = false;
  reads.version = null;
});

describe("useWindowHostRunsPersonal", () => {
  it("is the cloud road for a window with no host", () => {
    const { result } = renderHook(() =>
      useWindowHostRunsPersonal(hostScopeFixture({ host: null })),
    );

    expect(result.current).toBe(false);
  });

  it.each(["unreachable", "vanished"] as const)(
    "is the cloud road, as the page reads it, for a host that is %s",
    (status) => {
      const { result } = renderHook(() =>
        useWindowHostRunsPersonal(hostScopeFixture({ host: HOST, status })),
      );

      expect(result.current).toBe(false);
    },
  );

  it("is unknown until the host answers its status", () => {
    reads.version = { major: 1, minor: 3 };

    const { result } = renderHook(() =>
      useWindowHostRunsPersonal(hostScopeFixture({ host: HOST })),
    );

    expect(result.current).toBeNull();
  });

  it("is the cloud road when the status read errored", () => {
    reads.version = { major: 1, minor: 3 };
    reads.isError = true;

    const { result } = renderHook(() =>
      useWindowHostRunsPersonal(hostScopeFixture({ host: HOST })),
    );

    expect(result.current).toBe(false);
  });

  it("leaves the cloud road for a host whose status names Personal as its principal", () => {
    reads.version = { major: 1, minor: 3 };
    reads.data = environmentStatusFixture({ principal: { kind: "personal" } });

    const { result } = renderHook(() =>
      useWindowHostRunsPersonal(hostScopeFixture({ host: HOST })),
    );

    expect(result.current).toBe(true);
  });

  it("is the cloud road for a host that does not serve the status", () => {
    reads.version = false;

    const { result } = renderHook(() =>
      useWindowHostRunsPersonal(hostScopeFixture({ host: HOST })),
    );

    expect(result.current).toBe(false);
  });
});
