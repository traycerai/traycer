import { describe, expect, it } from "vitest";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import {
  createHostRuntime,
  type HostRuntimeBinding,
  createHostRuntimeState,
} from "@/providers/host-runtime-provider";

describe("createHostRuntime", () => {
  it("retains context and binding snapshot across provider and hook module generations", () => {
    const sharedState = createHostRuntimeState<HostRpcRegistry>();

    const providerGeneration = createHostRuntime(
      hostRpcSchedulingPolicy,
      sharedState,
    );
    const hookGeneration = createHostRuntime(
      hostRpcSchedulingPolicy,
      sharedState,
    );

    expect(providerGeneration.HostRuntimeContext).toBe(sharedState.context);
    expect(hookGeneration.HostRuntimeContext).toBe(sharedState.context);

    const binding = Object.create(null) as HostRuntimeBinding<HostRpcRegistry>;
    sharedState.bindingSnapshot.value = binding;

    expect(hookGeneration.getBindingSnapshot()).toBe(binding);
  });
});
