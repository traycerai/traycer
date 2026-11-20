import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import {
  hostScopeFixture,
  hostScopeOptionFixture,
} from "@/components/settings/host-scope/host-scope-fixture";
import { useWindowHostPersonal } from "@/components/settings/personal/use-window-host-personal";

const reads = vi.hoisted(() => ({
  data: null,
  isError: false,
  version: null as NegotiatedMethodVersion,
}));

vi.mock("@/hooks/environment/use-environment-reads", () => ({
  useEnvironmentStatusRead: () => ({
    supported: null,
    data: reads.data,
    isError: reads.isError,
  }),
}));
vi.mock("@/hooks/host/use-host-negotiated-method-version", () => ({
  useHostNegotiatedMethodVersion: () => reads.version,
}));

const HOST = hostScopeOptionFixture({ hostId: "host-a" });

afterEach(() => {
  reads.isError = false;
  reads.version = null;
});

describe("useWindowHostPersonal", () => {
  it("is the cloud road, with no outage, for a window with no host", () => {
    const { result } = renderHook(() =>
      useWindowHostPersonal(hostScopeFixture({ host: null })),
    );

    expect(result.current).toEqual({ runs: false, outage: false });
  });

  it.each(["unreachable", "vanished"] as const)(
    "is the cloud road, in an outage, for a host that is %s",
    (status) => {
      const { result } = renderHook(() =>
        useWindowHostPersonal(hostScopeFixture({ host: HOST, status })),
      );

      expect(result.current).toEqual({ runs: false, outage: true });
    },
  );

  it("is unknown, with no outage, until the host answers its status", () => {
    reads.version = { major: 1, minor: 3 };

    const { result } = renderHook(() =>
      useWindowHostPersonal(hostScopeFixture({ host: HOST })),
    );

    expect(result.current).toEqual({ runs: null, outage: false });
  });

  it("is the cloud road, in an outage, when the status read errored", () => {
    reads.version = { major: 1, minor: 3 };
    reads.isError = true;

    const { result } = renderHook(() =>
      useWindowHostPersonal(hostScopeFixture({ host: HOST })),
    );

    expect(result.current).toEqual({ runs: false, outage: true });
  });

  it("is the cloud road, with no outage, for a host that does not serve the status", () => {
    reads.version = false;

    const { result } = renderHook(() =>
      useWindowHostPersonal(hostScopeFixture({ host: HOST })),
    );

    expect(result.current).toEqual({ runs: false, outage: false });
  });
});
