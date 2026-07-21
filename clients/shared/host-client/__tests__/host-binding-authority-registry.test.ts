import { describe, expect, it } from "vitest";
import type { HostDirectoryEntry } from "../host-directory";
import {
  HostBindingAuthorityRegistry,
  StaleHostBindingAuthorityError,
} from "../host-binding-authority-registry";

function entry(
  overrides: Partial<HostDirectoryEntry> &
    Pick<HostDirectoryEntry, "hostId" | "version">,
): HostDirectoryEntry {
  return {
    label: overrides.label ?? `Host ${overrides.hostId}`,
    kind: overrides.kind ?? "local",
    websocketUrl:
      overrides.websocketUrl === undefined
        ? `ws://127.0.0.1:4917/${overrides.hostId}`
        : overrides.websocketUrl,
    status: overrides.status ?? "available",
    hostId: overrides.hostId,
    version: overrides.version,
  };
}

describe("HostBindingAuthorityRegistry", () => {
  it("stale requested capture leaves the valid current binding untouched (regression pin)", () => {
    const registry = new HostBindingAuthorityRegistry();
    const currentV2 = entry({ hostId: "H", version: "v2" });
    const staleV1 = entry({ hostId: "H", version: "v1" });

    const valid = registry.capture(currentV2, currentV2);
    expect(valid.abortSignal.aborted).toBe(false);
    expect(valid.endpoint).toEqual({
      hostId: "H",
      websocketUrl: currentV2.websocketUrl,
    });
    expect(valid.providerGeneration).toBe(1);

    expect(() => registry.capture(staleV1, currentV2)).toThrow(
      StaleHostBindingAuthorityError,
    );
    expect(() => registry.capture(staleV1, currentV2)).toThrow(
      /Host 'H' changed before its request authority was captured/,
    );

    // Critical pin: pure stale reject must not abort/delete the stored current.
    const afterStale = registry.capture(currentV2, currentV2);
    expect(afterStale).toBe(valid);
    expect(afterStale.token).toBe(valid.token);
    expect(afterStale.abortSignal).toBe(valid.abortSignal);
    expect(valid.abortSignal.aborted).toBe(false);
    expect(afterStale.providerGeneration).toBe(1);
  });

  it("ABA H1 → H2 → H1 mints a new token each transport change and aborts prior signals", () => {
    const registry = new HostBindingAuthorityRegistry();
    const hostId = "H";
    const t1 = entry({
      hostId,
      version: "v1",
      websocketUrl: "ws://127.0.0.1:4917/h1",
    });
    const t2 = entry({
      hostId,
      version: "v2",
      websocketUrl: "ws://127.0.0.1:4917/h2",
    });

    const b1 = registry.capture(t1, t1);
    expect(b1.providerGeneration).toBe(1);
    expect(b1.abortSignal.aborted).toBe(false);

    const b2 = registry.capture(t2, t2);
    expect(b2.token).not.toBe(b1.token);
    expect(b2.abortSignal).not.toBe(b1.abortSignal);
    expect(b1.abortSignal.aborted).toBe(true);
    expect(b2.abortSignal.aborted).toBe(false);
    expect(b2.providerGeneration).toBe(2);
    expect(b2.endpoint.websocketUrl).toBe(t2.websocketUrl);

    // Returning to H1/t1 must mint again — not resurrect the aborted generation.
    const b3 = registry.capture(t1, t1);
    expect(b3.token).not.toBe(b1.token);
    expect(b3.token).not.toBe(b2.token);
    expect(b3.abortSignal).not.toBe(b1.abortSignal);
    expect(b3.abortSignal).not.toBe(b2.abortSignal);
    expect(b2.abortSignal.aborted).toBe(true);
    expect(b3.abortSignal.aborted).toBe(false);
    expect(b3.providerGeneration).toBe(3);
    expect(b3.endpoint.websocketUrl).toBe(t1.websocketUrl);
  });

  it("providerGeneration increments only when a new binding is minted", () => {
    const registry = new HostBindingAuthorityRegistry();
    const v1 = entry({ hostId: "H", version: "v1" });
    const v2 = entry({ hostId: "H", version: "v2" });

    const first = registry.capture(v1, v1);
    const same = registry.capture(v1, v1);
    expect(same).toBe(first);
    expect(same.providerGeneration).toBe(1);

    const next = registry.capture(v2, v2);
    expect(next.providerGeneration).toBe(2);
    expect(next).not.toBe(first);
  });

  it("dispose aborts every binding and later capture rejects", () => {
    const registry = new HostBindingAuthorityRegistry();
    const a = entry({ hostId: "A", version: "1" });
    const b = entry({ hostId: "B", version: "1" });

    const bindingA = registry.capture(a, a);
    const bindingB = registry.capture(b, b);
    expect(bindingA.abortSignal.aborted).toBe(false);
    expect(bindingB.abortSignal.aborted).toBe(false);

    registry.dispose();

    expect(bindingA.abortSignal.aborted).toBe(true);
    expect(bindingB.abortSignal.aborted).toBe(true);

    expect(() => registry.capture(a, a)).toThrow(
      StaleHostBindingAuthorityError,
    );
    expect(() => registry.capture(b, b)).toThrow(
      StaleHostBindingAuthorityError,
    );

    // Idempotent dispose.
    registry.dispose();
    expect(bindingA.abortSignal.aborted).toBe(true);
  });

  it("current === null aborts and deletes the stored binding", () => {
    const registry = new HostBindingAuthorityRegistry();
    const present = entry({ hostId: "H", version: "v1" });
    const binding = registry.capture(present, present);
    expect(binding.abortSignal.aborted).toBe(false);

    expect(() => registry.capture(present, null)).toThrow(
      StaleHostBindingAuthorityError,
    );
    expect(binding.abortSignal.aborted).toBe(true);

    // After deletion, a fresh matching capture mints a new generation.
    const renewed = registry.capture(present, present);
    expect(renewed.token).not.toBe(binding.token);
    expect(renewed.abortSignal.aborted).toBe(false);
    expect(renewed.providerGeneration).toBe(2);
  });

  it("shared registry: transient stale capture does not disturb default binding/signal", () => {
    // Mirrors default + transient clients sharing getAuthorityRegistry().
    const sharedRegistry = new HostBindingAuthorityRegistry();
    const current = entry({
      hostId: "H",
      version: "v2",
      websocketUrl: "ws://127.0.0.1:4917/current",
    });
    const transientStale = entry({
      hostId: "H",
      version: "v1",
      websocketUrl: "ws://127.0.0.1:4917/stale",
    });

    const defaultBinding = sharedRegistry.capture(current, current);
    expect(defaultBinding.abortSignal.aborted).toBe(false);
    const defaultToken = defaultBinding.token;
    const defaultSignal = defaultBinding.abortSignal;
    const defaultGeneration = defaultBinding.providerGeneration;

    // Transient client held a frozen routed entry that no longer matches
    // directory current; its capture must reject without poisoning default.
    expect(() => sharedRegistry.capture(transientStale, current)).toThrow(
      StaleHostBindingAuthorityError,
    );

    expect(defaultBinding.abortSignal.aborted).toBe(false);
    expect(defaultBinding.token).toBe(defaultToken);
    expect(defaultBinding.abortSignal).toBe(defaultSignal);
    expect(defaultBinding.providerGeneration).toBe(defaultGeneration);

    const stillDefault = sharedRegistry.capture(current, current);
    expect(stillDefault).toBe(defaultBinding);
    expect(stillDefault.abortSignal.aborted).toBe(false);
  });
});
