import { afterEach, describe, expect, it, vi } from "vitest";
import {
  confirmLocalHostStillUnresponsive,
  publishLocalHostUnresponsive,
  readLocalHostUnresponsive,
  setLocalHostStillUnresponsiveCheck,
} from "../local-host-unresponsive";

// `confirmLocalHostStillUnresponsive` is what the force-restart handler asks
// before it restarts anything: the current verdict must be that offer (pid and
// offer id), and the monitor's fresh look must agree (traycer#1563 D3a). The
// answer is the host the restart may stop, or null.

const HOST = { pid: 4242, startIdentity: "linux:boot-a 4242" };

afterEach(() => {
  setLocalHostStillUnresponsiveCheck(null);
  publishLocalHostUnresponsive(null);
});

describe("confirmLocalHostStillUnresponsive", () => {
  it("asks the registered check for the pid and returns the host it confirms", async () => {
    const check = vi.fn(async () => HOST);
    setLocalHostStillUnresponsiveCheck(check);
    publishLocalHostUnresponsive({
      pid: 4242,
      offerId: 7,
      unreachableForMs: 600_000,
    });

    await expect(
      confirmLocalHostStillUnresponsive({ pid: 4242, offerId: 7 }),
    ).resolves.toEqual(HOST);
    expect(check).toHaveBeenCalledWith({ pid: 4242, offerId: 7 });
  });

  it("returns null when the check says the host is no longer unresponsive", async () => {
    setLocalHostStillUnresponsiveCheck(async () => null);
    publishLocalHostUnresponsive({
      pid: 4242,
      offerId: 7,
      unreachableForMs: 600_000,
    });

    await expect(
      confirmLocalHostStillUnresponsive({ pid: 4242, offerId: 7 }),
    ).resolves.toBeNull();
  });

  it("returns null for an offer id the current verdict does not carry, without asking", async () => {
    const check = vi.fn(async () => HOST);
    setLocalHostStillUnresponsiveCheck(check);
    publishLocalHostUnresponsive({
      pid: 4242,
      offerId: 7,
      unreachableForMs: 600_000,
    });

    await expect(
      confirmLocalHostStillUnresponsive({ pid: 4242, offerId: 6 }),
    ).resolves.toBeNull();
    await expect(
      confirmLocalHostStillUnresponsive({ pid: 4242, offerId: 8 }),
    ).resolves.toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it("returns null for every offer id while the verdict carries no offer, without asking", async () => {
    const check = vi.fn(async () => HOST);
    setLocalHostStillUnresponsiveCheck(check);
    publishLocalHostUnresponsive({
      pid: 4242,
      offerId: null,
      unreachableForMs: 600_000,
    });

    for (const offerId of [1, 7, 2 ** 31]) {
      await expect(
        confirmLocalHostStillUnresponsive({ pid: 4242, offerId }),
      ).resolves.toBeNull();
    }
    expect(check).not.toHaveBeenCalled();
  });

  it("returns null for an old offer once a later one for the same pid is published", async () => {
    const check = vi.fn(async () => HOST);
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
    ).resolves.toBeNull();
    expect(check).not.toHaveBeenCalled();
    await expect(
      confirmLocalHostStillUnresponsive({ pid: 4242, offerId: 9 }),
    ).resolves.toEqual(HOST);
  });

  it("returns null for a pid the current verdict does not name, without asking", async () => {
    const check = vi.fn(async () => HOST);
    setLocalHostStillUnresponsiveCheck(check);
    publishLocalHostUnresponsive({
      pid: 4242,
      offerId: 7,
      unreachableForMs: 600_000,
    });

    await expect(
      confirmLocalHostStillUnresponsive({ pid: 9999, offerId: 7 }),
    ).resolves.toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it("returns null when there is no verdict", async () => {
    const check = vi.fn(async () => HOST);
    setLocalHostStillUnresponsiveCheck(check);

    await expect(
      confirmLocalHostStillUnresponsive({ pid: 4242, offerId: 7 }),
    ).resolves.toBeNull();
    expect(check).not.toHaveBeenCalled();
  });

  it("returns null when no monitor has registered a check", async () => {
    publishLocalHostUnresponsive({
      pid: 4242,
      offerId: 7,
      unreachableForMs: 600_000,
    });

    await expect(
      confirmLocalHostStillUnresponsive({ pid: 4242, offerId: 7 }),
    ).resolves.toBeNull();
  });

  it("leaves no standing offer once the monitor is torn down: the verdict reads null and the stale pid is declined without a look", async () => {
    // The sequence desktop-startup runs when it disposes the monitor.
    const check = vi.fn(async () => HOST);
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
    ).resolves.toBeNull();
    expect(check).not.toHaveBeenCalled();
  });
});
