import { afterEach, describe, expect, it, vi } from "vitest";
import {
  confirmLocalHostStillUnresponsive,
  publishLocalHostUnresponsive,
  readLocalHostUnresponsive,
  setLocalHostStillUnresponsiveCheck,
} from "../local-host-unresponsive";

// `confirmLocalHostStillUnresponsive` is what the force-restart handler asks
// before it restarts anything: the current verdict must be that offer (pid and
// offer id), and the monitor's fresh look must agree (traycer#1563 D3a).

afterEach(() => {
  setLocalHostStillUnresponsiveCheck(null);
  publishLocalHostUnresponsive(null);
});

describe("confirmLocalHostStillUnresponsive", () => {
  it("asks the registered check for the pid and returns its answer", async () => {
    const check = vi.fn(async () => true);
    setLocalHostStillUnresponsiveCheck(check);
    publishLocalHostUnresponsive({
      pid: 4242,
      offerId: 7,
      unreachableForMs: 600_000,
    });

    await expect(
      confirmLocalHostStillUnresponsive({ pid: 4242, offerId: 7 }),
    ).resolves.toBe(true);
    expect(check).toHaveBeenCalledWith({ pid: 4242, offerId: 7 });
  });

  it("returns false when the check says the host is no longer unresponsive", async () => {
    setLocalHostStillUnresponsiveCheck(async () => false);
    publishLocalHostUnresponsive({
      pid: 4242,
      offerId: 7,
      unreachableForMs: 600_000,
    });

    await expect(
      confirmLocalHostStillUnresponsive({ pid: 4242, offerId: 7 }),
    ).resolves.toBe(false);
  });

  it("returns false for an offer id the current verdict does not carry, without asking", async () => {
    const check = vi.fn(async () => true);
    setLocalHostStillUnresponsiveCheck(check);
    publishLocalHostUnresponsive({
      pid: 4242,
      offerId: 7,
      unreachableForMs: 600_000,
    });

    await expect(
      confirmLocalHostStillUnresponsive({ pid: 4242, offerId: 6 }),
    ).resolves.toBe(false);
    await expect(
      confirmLocalHostStillUnresponsive({ pid: 4242, offerId: 8 }),
    ).resolves.toBe(false);
    expect(check).not.toHaveBeenCalled();
  });

  it("returns false for an old offer once a later one for the same pid is published", async () => {
    const check = vi.fn(async () => true);
    setLocalHostStillUnresponsiveCheck(check);
    publishLocalHostUnresponsive({
      pid: 4242,
      offerId: 7,
      unreachableForMs: 600_000,
    });
    publishLocalHostUnresponsive({
      pid: 4242,
      offerId: 9,
      unreachableForMs: 610_000,
    });

    await expect(
      confirmLocalHostStillUnresponsive({ pid: 4242, offerId: 7 }),
    ).resolves.toBe(false);
    expect(check).not.toHaveBeenCalled();
    await expect(
      confirmLocalHostStillUnresponsive({ pid: 4242, offerId: 9 }),
    ).resolves.toBe(true);
  });

  it("returns false for a pid the current verdict does not name, without asking", async () => {
    const check = vi.fn(async () => true);
    setLocalHostStillUnresponsiveCheck(check);
    publishLocalHostUnresponsive({
      pid: 4242,
      offerId: 7,
      unreachableForMs: 600_000,
    });

    await expect(
      confirmLocalHostStillUnresponsive({ pid: 9999, offerId: 7 }),
    ).resolves.toBe(false);
    expect(check).not.toHaveBeenCalled();
  });

  it("returns false when there is no verdict", async () => {
    const check = vi.fn(async () => true);
    setLocalHostStillUnresponsiveCheck(check);

    await expect(
      confirmLocalHostStillUnresponsive({ pid: 4242, offerId: 7 }),
    ).resolves.toBe(false);
    expect(check).not.toHaveBeenCalled();
  });

  it("returns false when no monitor has registered a check", async () => {
    publishLocalHostUnresponsive({
      pid: 4242,
      offerId: 7,
      unreachableForMs: 600_000,
    });

    await expect(
      confirmLocalHostStillUnresponsive({ pid: 4242, offerId: 7 }),
    ).resolves.toBe(false);
  });

  it("leaves no standing offer once the monitor is torn down: the verdict reads null and the stale pid is declined without a look", async () => {
    // The sequence desktop-startup runs when it disposes the monitor.
    const check = vi.fn(async () => true);
    setLocalHostStillUnresponsiveCheck(check);
    publishLocalHostUnresponsive({
      pid: 4242,
      offerId: 7,
      unreachableForMs: 600_000,
    });
    expect(readLocalHostUnresponsive()).toEqual({
      pid: 4242,
      offerId: 7,
      unreachableForMs: 600_000,
    });

    setLocalHostStillUnresponsiveCheck(null);
    publishLocalHostUnresponsive(null);

    expect(readLocalHostUnresponsive()).toBeNull();
    await expect(
      confirmLocalHostStillUnresponsive({ pid: 4242, offerId: 7 }),
    ).resolves.toBe(false);
    expect(check).not.toHaveBeenCalled();
  });
});
