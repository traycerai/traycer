import "../../../../../__tests__/test-browser-apis";
import { Profiler, useState, type ProfilerOnRenderCallback } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import { ComposerPromptEditor } from "../composer-prompt-editor";
import type { ComposerPromptEditorHandle } from "../composer-prompt-editor";
import {
  createComposerPickerStore,
  type ComposerPickerStore,
} from "../picker/composer-picker-store";

afterEach(() => {
  cleanup();
});

interface HarnessProps {
  readonly profileRender: ProfilerOnRenderCallback;
  readonly handleRef: { current: ComposerPromptEditorHandle | null };
}

function Harness({ profileRender, handleRef }: HarnessProps) {
  const [pickerStore] = useState<ComposerPickerStore>(() =>
    createComposerPickerStore(),
  );
  const setHandle = (instance: ComposerPromptEditorHandle | null): void => {
    handleRef.current = instance;
  };
  return (
    <Profiler id="composer-editor" onRender={profileRender}>
      <ComposerPromptEditor
        ref={setHandle}
        initialContent={{ type: "doc", content: [{ type: "paragraph" }] }}
        initialSelection={null}
        pickerStore={pickerStore}
        placeholder="test"
        editorClassName={undefined}
        isActive={false}
        disabled={false}
        slashProviderId="claude"
        onSnapshot={() => undefined}
        onSubmit={() => undefined}
        onPaste={() => undefined}
        onDragOver={() => undefined}
        onDrop={() => undefined}
        onKeyDown={undefined}
        onFocus={() => undefined}
        onBlur={() => undefined}
      />
    </Profiler>
  );
}

describe("ComposerPromptEditor render isolation", () => {
  it("does not re-render the editor wrapper on focus / typing", async () => {
    const phases: string[] = [];
    const profileRender: ProfilerOnRenderCallback = (_id, phase) => {
      phases.push(phase);
    };
    const handleRef: { current: ComposerPromptEditorHandle | null } = {
      current: null,
    };
    render(<Harness profileRender={profileRender} handleRef={handleRef} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const updatesAfterMount = phases.filter((p) => p === "update").length;

    const handle = handleRef.current;
    expect(handle).not.toBeNull();
    if (handle === null) throw new Error("editor handle missing");
    act(() => {
      handle.focus();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const finalUpdates = phases.filter((p) => p === "update").length;
    expect(finalUpdates - updatesAfterMount).toBeLessThanOrEqual(1);
  });
});
