import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setMobileApp } from "@/lib/mobile-app";
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";

// A second representative call site, mounted without any host/query
// scaffolding: every command-palette-style row's trailing chord chip.
describe("<CommandShortcut />", () => {
  afterEach(() => {
    cleanup();
    setMobileApp(false);
  });

  function renderRow() {
    return render(
      <Command>
        <CommandList>
          <CommandGroup>
            <CommandItem value="open-palette">
              Open Palette
              <CommandShortcut>⌘K</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>,
    );
  }

  it("shows the chord chip outside the mobile app", () => {
    renderRow();
    expect(screen.getByText("⌘K")).toBeTruthy();
    expect(screen.getByText("Open Palette")).toBeTruthy();
  });

  it("drops the chord chip on the installed mobile app but keeps the row label", () => {
    setMobileApp(true);
    renderRow();
    expect(screen.queryByText("⌘K")).toBeNull();
    expect(screen.getByText("Open Palette")).toBeTruthy();
  });
});
