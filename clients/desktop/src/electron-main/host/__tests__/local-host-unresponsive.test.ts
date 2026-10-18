import { afterEach, describe, expect, it, vi } from "vitest";
import {
  confirmLocalHostStillUnresponsive,
  publishLocalHostUnresponsive,
  readLocalHostUnresponsive,
  setLocalHostStillUnresponsiveCheck,
} from "../local-host-unresponsive";

// `confirmLocalHostStillUnresponsive` is what the force-restart handler asks
// before it restarts anything: the current verdict must name the pid, and the
// monitor's fresh look must agree (traycer#1563 D3a).

afterEach(() => {
  setLocalHostStillUnresponsiveCheck(null);
  publishLocalHostUnresponsive(null);
});

describe("confirmLocalHostStillUnresponsive", () => {
  it("asks the registered check for the pid and returns its answer", async () => {
    const check = vi.fn(async () => true);
    setLocalHostStillUnresponsiveCheck(check);
    publishLocalHostUnresponsive({ pid: 4242, unreachableForMs: 600_000 });

    await expect(confirmLocalHostStillUnresponsive(4242)).resolves.toBe(true);
    expect(check).toHaveBeenCalledWith(4242);
  });

  it("returns false when the check says the host is no longer unresponsive", async () => {
    setLocalHostStillUnresponsiveCheck(async () => false);
    publishLocalHostUnresponsive({ pid: 4242, unreachableForMs: 600_000 });

    await expect(confirmLocalHostStillUnresponsive(4242)).resolves.toBe(false);
  });

  it("returns false for a pid the current verdict does not name, without asking", async () => {
    const check = vi.fn(async () => true);
    setLocalHostStillUnresponsiveCheck(check);
    publishLocalHostUnresponsive({ pid: 4242, unreachableForMs: 600_000 });

    await expect(confirmLocalHostStillUnresponsive(9999)).resolves.toBe(false);
    expect(check).not.toHaveBeenCalled();
  });

  it("returns false when there is no verdict", async () => {
    const check = vi.fn(async () => true);
    setLocalHostStillUnresponsiveCheck(check);

    await expect(confirmLocalHostStillUnresponsive(4242)).resolves.toBe(false);
    expect(check).not.toHaveBeenCalled();
  });

  it("returns false when no monitor has registered a check", async () => {
    publishLocalHostUnresponsive({ pid: 4242, unreachableForMs: 600_000 });

    await expect(confirmLocalHostStillUnresponsive(4242)).resolves.toBe(false);
  });

  it("leaves no standing offer once the monitor is torn down: the verdict reads null and the stale pid is declined without a look", async () => {
    // The sequence desktop-startup runs when it disposes the monitor.
    const check = vi.fn(async () => true);
    setLocalHostStillUnresponsiveCheck(check);
    publishLocalHostUnresponsive({ pid: 4242, unreachableForMs: 600_000 });
    expect(readLocalHostUnresponsive()).toEqual({
      pid: 4242,
      unreachableForMs: 600_000,
    });

    setLocalHostStillUnresponsiveCheck(null);
    publishLocalHostUnresponsive(null);

    expect(readLocalHostUnresponsive()).toBeNull();
    await expect(confirmLocalHostStillUnresponsive(4242)).resolves.toBe(false);
    expect(check).not.toHaveBeenCalled();
  });
});
