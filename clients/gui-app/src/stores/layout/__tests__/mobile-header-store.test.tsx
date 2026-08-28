import { afterEach, describe, expect, it } from "vitest";
import { useMobileHeaderStore } from "@/stores/layout/mobile-header-store";

/**
 * The slot arbitrates a single cell between surfaces. Taking it is last-in-wins
 * - the surface on screen owns the header. Releasing it is owner-scoped,
 * because a departing surface's teardown is not ordered against the incoming
 * one's claim.
 */
describe("useMobileHeaderStore right-actions slot", () => {
  afterEach(() => {
    useMobileHeaderStore.setState({
      rightActions: null,
      rightActionsOwner: null,
    });
  });

  it("hands the cell to the last writer", () => {
    const first = <button type="button" data-testid="first" />;
    const second = <button type="button" data-testid="second" />;

    useMobileHeaderStore.getState().setRightActions("owner-a", first);
    useMobileHeaderStore.getState().setRightActions("owner-b", second);

    expect(useMobileHeaderStore.getState().rightActions).toBe(second);
    expect(useMobileHeaderStore.getState().rightActionsOwner).toBe("owner-b");
  });

  it("clears the cell for the owner that holds it", () => {
    useMobileHeaderStore
      .getState()
      .setRightActions("owner-a", <button type="button" />);

    useMobileHeaderStore.getState().clearRightActions("owner-a");

    expect(useMobileHeaderStore.getState().rightActions).toBeNull();
    expect(useMobileHeaderStore.getState().rightActionsOwner).toBeNull();
  });

  // The case the ownership exists for: a surface torn down a commit late must
  // not blank controls the surface that replaced it has already published.
  it("ignores a clear from an owner that no longer holds it", () => {
    const incoming = <button type="button" data-testid="incoming" />;
    useMobileHeaderStore
      .getState()
      .setRightActions("owner-a", <button type="button" />);
    useMobileHeaderStore.getState().setRightActions("owner-b", incoming);

    useMobileHeaderStore.getState().clearRightActions("owner-a");

    expect(useMobileHeaderStore.getState().rightActions).toBe(incoming);
    expect(useMobileHeaderStore.getState().rightActionsOwner).toBe("owner-b");
  });

  it("ignores a clear against an empty slot", () => {
    useMobileHeaderStore.getState().clearRightActions("owner-a");

    expect(useMobileHeaderStore.getState().rightActions).toBeNull();
    expect(useMobileHeaderStore.getState().rightActionsOwner).toBeNull();
  });
});
