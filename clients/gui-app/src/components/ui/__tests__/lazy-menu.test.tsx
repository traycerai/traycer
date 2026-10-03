import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { LazyDropdownMenu } from "@/components/ui/lazy-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

afterEach(cleanup);

function Harness() {
  return (
    <LazyDropdownMenu trigger={<button type="button">Open</button>}>
      <DropdownMenuContent>
        <DropdownMenuItem>First</DropdownMenuItem>
      </DropdownMenuContent>
    </LazyDropdownMenu>
  );
}

function DisabledHarness() {
  return (
    <LazyDropdownMenu
      trigger={
        <button type="button" disabled>
          Open
        </button>
      }
    >
      <DropdownMenuContent>
        <DropdownMenuItem>First</DropdownMenuItem>
      </DropdownMenuContent>
    </LazyDropdownMenu>
  );
}

// Eagerly-mounted Radix DropdownMenu, closed. Renders no menu/menuitem either
// (Content only mounts while open) - that alone is not a fact about lazy vs
// eager mounting. What Radix's `Menu` root DOES do unconditionally on mount,
// open or closed, is install a capture-phase `document` "keydown" listener
// (pointer-vs-keyboard usage detection). That listener is the fact that
// distinguishes "the Radix root is mounted" from "it isn't" - a `getByRole`
// query for absent menu content passes for either.
function EagerHarness() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>Open eager</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>First</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function hasKeydownListener(
  spy: MockInstance<typeof document.addEventListener>,
): boolean {
  return spy.mock.calls.some((call) => call[0] === "keydown");
}

describe("LazyDropdownMenu", () => {
  it("mounts only the trigger before first interaction, installing no Menu-root keydown listener", () => {
    const addEventListenerSpy = vi.spyOn(document, "addEventListener");

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open" });

    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("data-state")).toBe("closed");
    // The resting state renders no DropdownMenu provider at all - nothing to
    // find, not just a closed one.
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(hasKeydownListener(addEventListenerSpy)).toBe(false);

    // Parity check: an eagerly-mounted (always-real) Radix DropdownMenu,
    // still closed, installs the Menu root's keydown listener immediately.
    // This is what would fail if LazyDropdownMenu regressed to eager
    // mounting - the absence above is a real signal, not a tautology.
    render(<EagerHarness />);
    expect(hasKeydownListener(addEventListenerSpy)).toBe(true);

    addEventListenerSpy.mockRestore();
  });

  it("opens immediately on pointerdown, mounting the real Radix trigger", () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open" });

    fireEvent.pointerDown(trigger, { button: 0 });

    expect(screen.getByRole("menuitem", { name: "First" })).toBeTruthy();
  });

  it("opens on a keyboard activation replayed onto the newly mounted Radix trigger, focusing the first item", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open" });

    fireEvent.keyDown(trigger, { key: "Enter" });

    const item = await screen.findByRole("menuitem", { name: "First" });
    await waitFor(() => {
      expect(document.activeElement).toBe(item);
    });
  });

  it("arms on focus alone without opening, mounting the Radix menu root, and keeps focus on the mounted trigger", () => {
    const addEventListenerSpy = vi.spyOn(document, "addEventListener");
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open" });
    expect(hasKeydownListener(addEventListenerSpy)).toBe(false);

    act(() => {
      trigger.focus();
    });

    expect(screen.queryByRole("menuitem")).toBeNull();
    const rearmedTrigger = screen.getByRole("button", { name: "Open" });
    expect(rearmedTrigger.getAttribute("data-state")).toBe("closed");
    expect(document.activeElement).toBe(rearmedTrigger);
    // Armed now mounts the real Radix Menu root, even though it stayed
    // closed - that root's own mount effect is what installs the listener.
    expect(hasKeydownListener(addEventListenerSpy)).toBe(true);

    addEventListenerSpy.mockRestore();
  });

  it("never arms a disabled trigger from pointerdown or click", () => {
    render(<DisabledHarness />);
    const trigger = screen.getByRole("button", { name: "Open" });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);

    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);

    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Open" }).getAttribute("data-state"),
    ).toBe("closed");
  });

  it("keeps normal Radix behavior once armed: Escape closes and restores focus to the trigger", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open" });

    fireEvent.pointerDown(trigger, { button: 0 });
    const item = screen.getByRole("menuitem", { name: "First" });

    fireEvent.keyDown(item, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("menuitem")).toBeNull();
    });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Open" }),
    );
  });
});
