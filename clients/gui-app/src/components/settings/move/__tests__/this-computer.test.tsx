import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

interface HookInputs {
  hostId: string | null;
  client: object | null;
  entry: { readonly label: string } | null;
  hosts: { readonly hostId: string; readonly displayName: string }[];
}

const inputs = vi.hoisted((): HookInputs => ({
  hostId: "host-local",
  client: null,
  entry: null,
  hosts: [],
}));

vi.mock("@/hooks/host/use-reactive-local-host-id", () => ({
  useReactiveLocalHostId: () => inputs.hostId,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => inputs.client,
  useHostDirectoryEntryForHostId: () => inputs.entry,
}));
vi.mock("@/hooks/auth/use-registered-hosts-query", () => ({
  useRegisteredHosts: () => ({ data: { hosts: inputs.hosts } }),
}));

import {
  useThisComputer,
  type ThisComputer,
} from "@/components/settings/move/this-computer";

afterEach(() => {
  cleanup();
  inputs.hostId = "host-local";
  inputs.client = null;
  inputs.entry = null;
  inputs.hosts = [];
});

function renderComputer(): ThisComputer {
  return renderHook(() => useThisComputer()).result.current;
}

describe("useThisComputer", () => {
  it("uses the registered name ahead of the directory label", () => {
    inputs.hosts = [{ hostId: "host-local", displayName: "Walk computer" }];
    inputs.entry = { label: "fallback-host" };

    expect(renderComputer().hostName).toBe("Walk computer");
  });

  it("uses the directory label when this host has no registry row", () => {
    inputs.hosts = [{ hostId: "another-host", displayName: "Other computer" }];
    inputs.entry = { label: "fallback-host" };

    expect(renderComputer().hostName).toBe("fallback-host");
  });

  it("uses this computer when neither source has a usable name", () => {
    inputs.hosts = [{ hostId: "host-local", displayName: "  " }];
    inputs.entry = { label: "  " };

    expect(renderComputer().hostName).toBe("this computer");
  });

  it("has no host identity or client when there is no local host id", () => {
    inputs.hostId = null;
    inputs.client = {};

    expect(renderComputer()).toEqual({
      hostId: null,
      hostName: "this computer",
      client: null,
    });
  });
});
