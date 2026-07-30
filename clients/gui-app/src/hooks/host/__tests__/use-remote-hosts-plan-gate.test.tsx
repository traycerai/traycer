/**
 * The client-side paid-plan gate for remote hosts. Pins the deny-list
 * semantics (only FREE/PENDING restrict — mirroring `isPaidTier` and the
 * server's attach-grant gate) and the definite-evidence rule: a signed-out /
 * not-yet-known plan (`null`) never reads as restricted. Drives the REAL auth
 * store — the projection the hook reads in production.
 */
import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { SubscriptionStatus } from "@traycer/protocol/auth/user";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useRemoteHostsPlanRestricted } from "../use-remote-hosts-plan-gate";

afterEach(() => {
  useAuthStore.getState().setSubscriptionStatus(null);
});

describe("useRemoteHostsPlanRestricted", () => {
  it.each<[SubscriptionStatus, boolean]>([
    ["FREE", true],
    ["PENDING", true],
    ["LITE_V3", false],
    ["PRO_V3", false],
    ["ULTRA_1X_V3", false],
    ["BYOA_V3", false],
    ["PRO", false],
  ])("%s → restricted: %s", (status, expected) => {
    useAuthStore.getState().setSubscriptionStatus(status);
    const { result } = renderHook(() => useRemoteHostsPlanRestricted());
    expect(result.current).toBe(expected);
  });

  it("signed out / plan not yet known (null) → NOT restricted (no false upsell flash)", () => {
    useAuthStore.getState().setSubscriptionStatus(null);
    const { result } = renderHook(() => useRemoteHostsPlanRestricted());
    expect(result.current).toBe(false);
  });

  it("reacts to a plan change without a remount (upgrade picked up live)", () => {
    useAuthStore.getState().setSubscriptionStatus("FREE");
    const { result, rerender } = renderHook(() =>
      useRemoteHostsPlanRestricted(),
    );
    expect(result.current).toBe(true);
    useAuthStore.getState().setSubscriptionStatus("PRO_V3");
    rerender();
    expect(result.current).toBe(false);
  });
});
