import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePickerLeaderScope } from "@/components/home/pickers/use-picker-leader-scope";
import { useDictationHotkey } from "@/hooks/composer/use-dictation-hotkey";
import { KeyboardOwnerContext } from "@/hooks/use-primary-action-shortcut";
import { getLeaderScopesTopDown } from "@/lib/keybindings/leader-scope";

function DictationOwner(props: { readonly start: () => void }) {
  useDictationHotkey({
    enabled: true,
    state: "idle",
    start: props.start,
    stop: () => undefined,
    cancel: () => undefined,
  });
  return null;
}

function OpenModelPicker() {
  usePickerLeaderScope({
    open: true,
    railEntries: [],
    onEntryChange: () => undefined,
    reasoning: null,
    reasoningActionable: false,
    serviceTier: null,
    activeProviderId: "claude",
    activeProviderProfiles: [],
    activeProviderProfileAdmission: null,
    profileEnablementPending: () => false,
    onProfileChange: () => undefined,
  });
  return null;
}

/** The default dictation chord, tapped. */
function tapDictation(): void {
  fireEvent.keyDown(window, { code: "KeyM", ctrlKey: true, shiftKey: true });
  fireEvent.keyUp(window, { code: "KeyM", ctrlKey: true, shiftKey: true });
}

describe("a surface that does not own the keyboard", () => {
  afterEach(cleanup);

  it("starts no dictation from the hotkey until it owns the keyboard again", () => {
    const start = vi.fn();
    const view = render(
      <KeyboardOwnerContext value={false}>
        <DictationOwner start={start} />
      </KeyboardOwnerContext>,
    );

    tapDictation();
    expect(start).not.toHaveBeenCalled();

    view.rerender(
      <KeyboardOwnerContext value>
        <DictationOwner start={start} />
      </KeyboardOwnerContext>,
    );
    tapDictation();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("holds no leader keys for a model picker left open in it", () => {
    const before = getLeaderScopesTopDown().length;
    const view = render(
      <KeyboardOwnerContext value={false}>
        <OpenModelPicker />
      </KeyboardOwnerContext>,
    );

    expect(getLeaderScopesTopDown()).toHaveLength(before);

    view.rerender(
      <KeyboardOwnerContext value>
        <OpenModelPicker />
      </KeyboardOwnerContext>,
    );
    expect(getLeaderScopesTopDown()).toHaveLength(before + 1);
  });
});
