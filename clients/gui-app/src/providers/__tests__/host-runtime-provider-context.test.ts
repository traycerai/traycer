import { createContext } from "react";
import { describe, expect, it } from "vitest";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import {
  createHostRuntime,
  type HostRuntimeBinding,
} from "@/providers/host-runtime-provider";

describe("createHostRuntime", () => {
  it("retains one context across provider and hook module generations", () => {
    const sharedContext =
      createContext<HostRuntimeBinding<HostRpcRegistry> | null>(null);

    const providerGeneration = createHostRuntime(
      hostRpcSchedulingPolicy,
      sharedContext,
    );
    const hookGeneration = createHostRuntime(
      hostRpcSchedulingPolicy,
      sharedContext,
    );

    expect(providerGeneration.HostRuntimeContext).toBe(sharedContext);
    expect(hookGeneration.HostRuntimeContext).toBe(sharedContext);
  });
});
