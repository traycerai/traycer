import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createScreencastArmBuffer,
  SCREENCAST_ARM_BUFFER_CLICK_SLOP_PX,
  type ScreencastArmBuffer,
  type ScreencastArmGestureDown,
  type ScreencastArmGestureUp,
} from "@/components/epic-canvas/renderers/screencast-arm-buffer";
import {
  deriveViewerDeadlineMs,
  VIEWER_CONTROL_PLANE_DEADLINES,
} from "@/lib/browser-view/sessions/control-plane-deadlines";

/** What the buffer holds a press for with no measured RTT: the floor. */
const SCREENCAST_ARM_BUFFER_TIMEOUT_MS =
  VIEWER_CONTROL_PLANE_DEADLINES.armBuffer.floorMs;

function downAt(
  payload: string,
  correlationToken: number,
  clientX: number,
  clientY: number,
): ScreencastArmGestureDown<string> {
  return { payload, correlationToken, clientX, clientY, isPrimary: true };
}

function upAt(
  payload: string,
  isPrimary: boolean,
  clientX: number,
  clientY: number,
): ScreencastArmGestureUp<string> {
  return { payload, isPrimary, clientX, clientY };
}

function createBuffer(): ScreencastArmBuffer<string> {
  return createScreencastArmBuffer(
    () => {},
    () => SCREENCAST_ARM_BUFFER_TIMEOUT_MS,
  );
}

describe("createScreencastArmBuffer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores a down and matching primary nearby up and delivers both when current", () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const buffer = createBuffer();

    buffer.storeDown(downAt("down", 7, 10, 20));
    expect(setTimeoutSpy).toHaveBeenCalledWith(
      expect.any(Function),
      SCREENCAST_ARM_BUFFER_TIMEOUT_MS,
    );
    expect(buffer.hasPending()).toBe(true);

    buffer.storeMatchingUp(upAt("up", true, 12, 21));
    expect(buffer.takeIfCurrent(7)).toEqual({ down: "down", up: "up" });
    expect(buffer.hasPending()).toBe(false);
    expect(buffer.takeIfCurrent(7)).toBeNull();
  });

  it("drops when the current token does not match the buffered one", () => {
    const buffer = createBuffer();

    buffer.storeDown(downAt("down", 7, 10, 20));
    buffer.storeMatchingUp(upAt("up", true, 10, 20));
    expect(buffer.takeIfCurrent(8)).toBeNull();
    expect(buffer.hasPending()).toBe(false);
  });

  it("drops when no surface is current", () => {
    const buffer = createBuffer();

    buffer.storeDown(downAt("down", 7, 10, 20));
    expect(buffer.takeIfCurrent(null)).toBeNull();
    expect(buffer.hasPending()).toBe(false);
  });

  it("does not deliver a down without a matching nearby up", () => {
    const buffer = createBuffer();

    buffer.storeDown(downAt("down", 7, 10, 20));
    expect(buffer.takeIfCurrent(7)).toBeNull();
    expect(buffer.hasPending()).toBe(false);
  });

  it("ignores a non-primary storeDown", () => {
    const buffer = createBuffer();
    const down = downAt("down", 7, 10, 20);

    buffer.storeDown({ ...down, isPrimary: false });
    expect(buffer.hasPending()).toBe(false);
    expect(buffer.takeIfCurrent(7)).toBeNull();
  });

  it("drops on noteMove past the click slop", () => {
    const buffer = createBuffer();

    buffer.storeDown(downAt("down", 7, 10, 20));
    buffer.noteMove(10 + SCREENCAST_ARM_BUFFER_CLICK_SLOP_PX + 1, 20);
    expect(buffer.hasPending()).toBe(false);
    expect(buffer.takeIfCurrent(7)).toBeNull();
  });

  it("keeps the pending gesture when noteMove stays within slop", () => {
    const buffer = createBuffer();

    buffer.storeDown(downAt("down", 7, 10, 20));
    buffer.noteMove(10 + SCREENCAST_ARM_BUFFER_CLICK_SLOP_PX, 20);
    buffer.noteMove(10, 20 + SCREENCAST_ARM_BUFFER_CLICK_SLOP_PX);
    expect(buffer.hasPending()).toBe(true);
    buffer.storeMatchingUp(upAt("up", true, 10, 20));
    expect(buffer.takeIfCurrent(7)).toEqual({ down: "down", up: "up" });
  });

  it("drops a non-primary up as arm-only instead of delivering a partial gesture", () => {
    const buffer = createBuffer();

    buffer.storeDown(downAt("down", 7, 10, 20));
    buffer.storeMatchingUp(upAt("right-up", false, 10, 20));
    expect(buffer.hasPending()).toBe(false);
    expect(buffer.takeIfCurrent(7)).toBeNull();
  });

  it("drops a far up as arm-only instead of delivering a partial gesture", () => {
    const buffer = createBuffer();

    buffer.storeDown(downAt("down", 7, 10, 20));
    buffer.storeMatchingUp(
      upAt("far-up", true, 10 + SCREENCAST_ARM_BUFFER_CLICK_SLOP_PX + 1, 20),
    );
    expect(buffer.hasPending()).toBe(false);
    expect(buffer.takeIfCurrent(7)).toBeNull();
  });

  it("ignores a second storeDown so there is no queue", () => {
    const buffer = createBuffer();

    buffer.storeDown(downAt("first", 7, 10, 20));
    buffer.storeDown(downAt("second", 8, 40, 50));
    buffer.storeMatchingUp(upAt("up", true, 10, 20));
    expect(buffer.takeIfCurrent(7)).toEqual({ down: "first", up: "up" });
  });

  it("times out at SCREENCAST_ARM_BUFFER_TIMEOUT_MS", () => {
    const buffer = createBuffer();

    buffer.storeDown(downAt("down", 7, 10, 20));
    vi.advanceTimersByTime(SCREENCAST_ARM_BUFFER_TIMEOUT_MS - 1);
    expect(buffer.hasPending()).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(1);
    expect(buffer.hasPending()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(buffer.takeIfCurrent(7)).toBeNull();
  });

  it("drop clears the timeout and the pending gesture", () => {
    const buffer = createBuffer();

    buffer.storeDown(downAt("first", 7, 10, 20));
    buffer.drop();
    expect(buffer.hasPending()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(buffer.takeIfCurrent(7)).toBeNull();

    buffer.storeDown(downAt("second", 9, 30, 40));
    vi.advanceTimersByTime(SCREENCAST_ARM_BUFFER_TIMEOUT_MS - 1);
    buffer.storeMatchingUp(upAt("up", true, 30, 40));
    expect(buffer.takeIfCurrent(9)).toEqual({ down: "second", up: "up" });
  });

  it("derives the timeout from the reader at storeDown time (ticket 18)", () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const measuredRttMs = 800;
    const buffer = createScreencastArmBuffer<string>(
      () => {},
      () =>
        deriveViewerDeadlineMs(
          VIEWER_CONTROL_PLANE_DEADLINES.armBuffer,
          measuredRttMs,
        ),
    );

    buffer.storeDown(downAt("down", 7, 10, 20));

    // roundTrips 2.5 * 800ms rtt = 2000ms, above the 1000ms floor.
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2_000);
  });

  it("picks up a reader value that changed between two presses", () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    let measuredRttMs = 800;
    const buffer = createScreencastArmBuffer<string>(
      () => {},
      () =>
        deriveViewerDeadlineMs(
          VIEWER_CONTROL_PLANE_DEADLINES.armBuffer,
          measuredRttMs,
        ),
    );

    buffer.storeDown(downAt("first", 7, 10, 20));
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 2_000);
    buffer.storeMatchingUp(upAt("up", true, 10, 20));
    buffer.takeIfCurrent(7);

    // A fresh probe landed between the two presses - the SECOND press must
    // read the new estimate, not the one captured when the buffer was built.
    measuredRttMs = 400;
    buffer.storeDown(downAt("second", 9, 30, 40));
    // roundTrips 2.5 * 400ms rtt = 1000ms, exactly the floor.
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 1_000);
  });
});
