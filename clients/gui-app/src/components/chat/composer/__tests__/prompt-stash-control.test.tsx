import "../../../../../__tests__/test-browser-apis";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import type { PromptStashController } from "@/hooks/composer/use-prompt-stash";
import type { PromptStashEntry } from "@/lib/composer/prompt-stash-codec";
import {
  createComposerPickerStore,
  type ComposerPickerStore,
} from "@/components/chat/composer/picker/composer-picker-store";
import { PromptStashControl as PromptStashControlView } from "@/components/chat/composer/prompt-stash-control";

function textEntry(
  id: string,
  text: string,
  createdAt: number,
): PromptStashEntry {
  return {
    id,
    createdAt,
    blobHashes: [],
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text }],
        },
      ],
    },
  };
}

function imageOnlyEntry(id: string): PromptStashEntry {
  return {
    id,
    createdAt: Date.now(),
    blobHashes: ["abc"],
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "imageAttachment",
              attrs: {
                id: "img-1",
                fileName: "shot.png",
                hash: "abc",
                b64content: null,
                mimeType: "image/png",
                size: 12,
              },
            },
          ],
        },
      ],
    },
  };
}

function entryRow(entry: PromptStashEntry) {
  return { kind: "entry" as const, entry };
}

function entryRows(entries: ReadonlyArray<PromptStashEntry>) {
  return entries.map(entryRow);
}

function makeController(
  overrides: Partial<PromptStashController>,
): PromptStashController {
  return {
    rows: [],
    busyEntryId: null,
    saving: false,
    pulseEpoch: 0,
    menuOpen: false,
    setMenuOpen: vi.fn(),
    editorHasFocus: () => false,
    focusEditor: vi.fn(),
    stashCurrent: vi.fn(),
    restore: vi.fn(() => Promise.resolve(true)),
    remove: vi.fn(() => Promise.resolve(undefined)),
    ...overrides,
  };
}

function PromptStashControl(props: {
  readonly controller: PromptStashController;
  readonly pickerStore: ComposerPickerStore;
}) {
  const [menuOpen, setMenuOpen] = useState(props.controller.menuOpen);
  return (
    <PromptStashControlView
      controller={{
        ...props.controller,
        menuOpen,
        setMenuOpen: (open) => {
          props.controller.setMenuOpen(open);
          setMenuOpen(open && props.controller.rows.length > 0);
        },
      }}
      pickerStore={props.pickerStore}
    />
  );
}

describe("PromptStashControl", () => {
  afterEach(() => {
    cleanup();
  });

  it("hides the badge trigger when there are no entries", () => {
    render(
      <PromptStashControl
        controller={makeController({ rows: [] })}
        pickerStore={createComposerPickerStore()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /stashed prompts/i }),
    ).toBeNull();
    expect(document.querySelector("[data-composer-utility-rail]")).toBeNull();
  });

  it("opens the popover from the badge, restores on select, and closes", async () => {
    const restore = vi.fn(() => Promise.resolve(true));
    const focusEditor = vi.fn();
    const entries = [
      textEntry("e1", "first prompt", Date.now()),
      textEntry("e2", "second", Date.now()),
    ];
    render(
      <PromptStashControl
        controller={makeController({
          rows: entryRows(entries),
          restore,
          focusEditor,
        })}
        pickerStore={createComposerPickerStore()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /stashed prompts: 2/i }),
    );
    expect(await screen.findByText("Stashed prompts")).toBeTruthy();
    expect(screen.getByText("Stashed prompts").parentElement?.textContent).toBe(
      "Stashed prompts",
    );
    expect(screen.getByText("first prompt")).toBeTruthy();
    expect(screen.getByText("second")).toBeTruthy();

    // cmdk CommandItem commits via pointer-up / click on the item text.
    fireEvent.click(screen.getByText("first prompt"));
    await waitFor(() => {
      expect(restore).toHaveBeenCalledWith(entries[0]);
      expect(focusEditor).toHaveBeenCalled();
      expect(screen.queryByText("Stashed prompts")).toBeNull();
    });
  });

  it("renders as a compact rounded utility pill and flashes the count", () => {
    render(
      <PromptStashControl
        controller={makeController({
          rows: entryRows([textEntry("e1", "one", Date.now())]),
          pulseEpoch: 1,
        })}
        pickerStore={createComposerPickerStore()}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: /stashed prompts: 1/i,
    });
    const rail = trigger.closest("[data-composer-utility-rail]");
    expect(rail).not.toBeNull();
    expect(rail?.className).toContain("shrink-0");
    expect(rail?.className).not.toContain("pl-3");
    expect(rail?.className).not.toContain("pt-2");
    expect(rail?.className).not.toContain("absolute");
    expect(rail?.className).not.toContain("border-b");
    expect(rail?.className).not.toContain("bg-muted");
    expect(trigger.className).not.toContain("absolute");
    expect(trigger.className).not.toContain("translate");
    expect(trigger.getAttribute("data-variant")).toBe("outline");
    expect(trigger.className).toContain("px-2");
    expect(trigger.className).toContain("rounded-full");
    expect(trigger.getAttribute("data-size")).toBe("xs");
    expect(trigger.querySelector(".prompt-stash-count-flash")).not.toBeNull();
  });

  it("shows the utility trigger while the first stash is saving", () => {
    render(
      <PromptStashControl
        controller={makeController({ rows: [], saving: true })}
        pickerStore={createComposerPickerStore()}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Stashing prompt" });
    expect(trigger.closest("[data-composer-utility-rail]")).not.toBeNull();
    expect(screen.getByTestId("prompt-stash-saving")).not.toBeNull();
  });

  it("uses a compact popover surface and dense row hierarchy", async () => {
    render(
      <PromptStashControl
        controller={makeController({
          rows: entryRows([textEntry("e1", "compact prompt", Date.now())]),
        })}
        pickerStore={createComposerPickerStore()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /stashed prompts: 1/i }),
    );
    const snippet = await screen.findByText("compact prompt");
    const row = snippet.closest("[cmdk-item]");
    const popover = document.querySelector<HTMLElement>(
      '[data-slot="popover-content"]',
    );

    expect(popover?.className).toContain("max-w-lg");
    expect(popover?.className).toContain(
      "--radix-popover-content-available-height",
    );
    expect(popover?.className).toContain("p-0");
    expect(row?.className).toContain("min-h-9");
    expect(row?.className).toContain("py-1.5");
    expect(row?.className).toContain("data-selected:border-primary/35");
    expect(row?.className).toContain("data-selected:shadow-sm");
  });

  it("visibly tracks the active row as pointer selection changes", async () => {
    render(
      <PromptStashControl
        controller={makeController({
          rows: entryRows([
            textEntry("e1", "first active prompt", Date.now()),
            textEntry("e2", "second active prompt", Date.now()),
          ]),
        })}
        pickerStore={createComposerPickerStore()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /stashed prompts: 2/i }),
    );
    const firstRow = (await screen.findByText("first active prompt")).closest(
      "[cmdk-item]",
    );
    const secondRow = screen
      .getByText("second active prompt")
      .closest("[cmdk-item]");
    expect(firstRow?.getAttribute("data-selected")).toBe("true");

    if (secondRow === null) throw new Error("Expected second stash row");
    fireEvent.mouseMove(secondRow);
    await waitFor(() => {
      expect(secondRow.getAttribute("data-selected")).toBe("true");
      expect(firstRow?.getAttribute("data-selected")).toBe("false");
    });
  });

  it("scrolls the arrow-selected row into the overflowing list viewport", async () => {
    const entries = Array.from({ length: 8 }, (_, index) =>
      textEntry(
        `e${String(index)}`,
        `prompt ${String(index + 1)}`,
        Date.now() + index,
      ),
    );
    render(
      <PromptStashControl
        controller={makeController({ rows: entryRows(entries) })}
        pickerStore={createComposerPickerStore()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /stashed prompts: 8/i }),
    );
    await screen.findByText("prompt 1");
    const secondRow = screen.getByText("prompt 2").closest("[cmdk-item]");
    if (secondRow === null) throw new Error("Expected second stash row");
    const scrollIntoView = vi.fn();
    Object.defineProperty(secondRow, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() => {
      expect(secondRow.getAttribute("data-selected")).toBe("true");
      expect(scrollIntoView).toHaveBeenCalledWith({
        block: "nearest",
        inline: "nearest",
      });
    });
  });

  it("restores prior editor focus when the menu closes", async () => {
    const focusEditor = vi.fn();
    render(
      <PromptStashControl
        controller={makeController({
          rows: entryRows([textEntry("e1", "focus", Date.now())]),
          editorHasFocus: () => true,
          focusEditor,
        })}
        pickerStore={createComposerPickerStore()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /stashed prompts: 1/i }),
    );
    await screen.findByText("Stashed prompts");
    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(focusEditor).toHaveBeenCalled());
  });

  it("closes and focuses the editor when the open list becomes empty", async () => {
    const focusEditor = vi.fn();
    const setMenuOpen = vi.fn();
    const pickerStore = createComposerPickerStore();
    const { rerender } = render(
      <PromptStashControl
        controller={makeController({
          rows: entryRows([textEntry("e1", "last prompt", Date.now())]),
          setMenuOpen,
          editorHasFocus: () => false,
          focusEditor,
        })}
        pickerStore={pickerStore}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /stashed prompts: 1/i }),
    );
    await screen.findByText("last prompt");

    rerender(
      <PromptStashControl
        controller={makeController({
          rows: [],
          setMenuOpen,
          editorHasFocus: () => false,
          focusEditor,
        })}
        pickerStore={pickerStore}
      />,
    );

    expect(screen.queryByText("Stashed prompts")).toBeNull();
    expect(screen.queryByText(/nothing stashed yet/i)).toBeNull();
    await waitFor(() => {
      expect(setMenuOpen).toHaveBeenLastCalledWith(false);
      expect(focusEditor).toHaveBeenCalled();
    });
  });

  it("uses a two-line rich-content viewport and no bookmark icon on stash rows", async () => {
    const longPrompt =
      "A long prompt that should be allowed to occupy two lines before the remaining content is visually truncated by the stash list row.";
    render(
      <PromptStashControl
        controller={makeController({
          rows: entryRows([textEntry("e1", longPrompt, Date.now())]),
        })}
        pickerStore={createComposerPickerStore()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /stashed prompts: 1/i }),
    );
    const snippet = await screen.findByText(longPrompt);
    const row = snippet.closest("[cmdk-item]");
    const viewport = screen.getByTestId(
      "prompt-stash-content-preview",
    ).parentElement;
    expect(viewport?.className).toContain("max-h-[2lh]");
    expect(viewport?.className).toContain("overflow-hidden");
    expect(row?.querySelector(".lucide-bookmark")).toBeNull();
  });

  it("uses a stable two-column layout for healthy and unavailable row actions", async () => {
    const healthyText =
      "A healthy prompt long enough to wrap across both available preview lines without moving when its action rail appears.";
    const unavailableText =
      "Recoverable text from an unavailable prompt that also needs two stable lines while keyboard selection moves onto it.";
    const unavailable = {
      kind: "unavailable" as const,
      id: "u1",
      createdAt: Date.now() - 1,
      content: textEntry("u1", unavailableText, Date.now()).content,
    };
    render(
      <PromptStashControl
        controller={makeController({
          rows: [
            entryRow(textEntry("e1", healthyText, Date.now())),
            unavailable,
          ],
        })}
        pickerStore={createComposerPickerStore()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /stashed prompts: 2/i }),
    );
    await screen.findByText(healthyText);

    const healthyRow = document.querySelector<HTMLElement>(
      '[data-prompt-stash-id="e1"]',
    );
    const unavailableRow = document.querySelector<HTMLElement>(
      '[data-prompt-stash-id="u1"]',
    );
    if (healthyRow === null || unavailableRow === null) {
      throw new Error("Expected both prompt stash rows");
    }

    for (const row of [healthyRow, unavailableRow]) {
      const preview = row.querySelector<HTMLElement>(
        '[data-slot="prompt-stash-row-preview"]',
      );
      const metadata = row.querySelector<HTMLElement>(
        '[data-slot="prompt-stash-row-metadata"]',
      );
      const actions = row.querySelector<HTMLElement>(
        '[data-slot="prompt-stash-row-actions"]',
      );
      if (preview === null || metadata === null || actions === null) {
        throw new Error("Expected stable preview, metadata, and action layers");
      }

      expect(row.className).toContain("overflow-hidden");
      expect(row.className).toContain("grid");
      expect(row.className).toContain("grid-cols-[minmax(0,1fr)_9rem]");
      expect(preview.className).not.toContain("pr-20");
      expect(metadata.className).toContain("col-start-2");
      expect(metadata.className).toContain("row-start-1");
      expect(metadata.className).not.toContain("absolute");
      expect(actions.className).toContain("col-start-2");
      expect(actions.className).toContain("row-start-1");
      expect(actions.className).toContain("transition-opacity");
      expect(actions.className).not.toContain("absolute");
      expect(actions.className).not.toContain("bg-linear-to-r");
      expect(
        `${row.className} ${metadata.className} ${actions.className}`,
      ).not.toMatch(/group-(?:hover|data-selected)\/stash:w-/);
    }

    const healthyPreviewClasses = healthyRow.querySelector<HTMLElement>(
      '[data-slot="prompt-stash-row-preview"]',
    )?.className;
    const unavailablePreviewClasses = unavailableRow.querySelector<HTMLElement>(
      '[data-slot="prompt-stash-row-preview"]',
    )?.className;

    fireEvent.mouseMove(unavailableRow);
    fireEvent.keyDown(window, { key: "ArrowUp" });

    expect(
      healthyRow.querySelector<HTMLElement>(
        '[data-slot="prompt-stash-row-preview"]',
      )?.className,
    ).toBe(healthyPreviewClasses);
    expect(
      unavailableRow.querySelector<HTMLElement>(
        '[data-slot="prompt-stash-row-preview"]',
      )?.className,
    ).toBe(unavailablePreviewClasses);
  });

  it("deletes from the row without restoring", async () => {
    const remove = vi.fn(() => Promise.resolve(undefined));
    const restore = vi.fn(() => Promise.resolve(true));
    const entries = [textEntry("e1", "delete me", Date.now())];
    render(
      <PromptStashControl
        controller={makeController({
          rows: entryRows(entries),
          remove,
          restore,
        })}
        pickerStore={createComposerPickerStore()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /stashed prompts: 1/i }),
    );
    const deleteButton = await screen.findByRole("button", {
      name: /delete stashed prompt/i,
    });
    fireEvent.click(deleteButton);

    await waitFor(() => {
      expect(remove).toHaveBeenCalledWith("e1");
    });
    expect(restore).not.toHaveBeenCalled();
  });

  it("shows Insert Enter and Delete D affordances, then deletes with bare D", async () => {
    const remove = vi.fn(() => Promise.resolve(undefined));
    const restore = vi.fn(() => Promise.resolve(true));
    const entries = [
      textEntry("e1", "delete with key", Date.now()),
      textEntry("e2", "keep me", Date.now()),
    ];
    render(
      <PromptStashControl
        controller={makeController({
          rows: entryRows(entries),
          remove,
          restore,
        })}
        pickerStore={createComposerPickerStore()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /stashed prompts: 2/i }),
    );
    await screen.findByText("delete with key");
    const insertButton = screen.getAllByRole("button", {
      name: /insert stashed prompt/i,
    })[0];
    const deleteButton = screen.getAllByRole("button", {
      name: /delete stashed prompt/i,
    })[0];
    expect(insertButton.getAttribute("aria-keyshortcuts")).toBe("Enter");
    expect(insertButton.textContent).toContain("Insert");
    expect(insertButton.textContent).toContain("↵");
    expect(deleteButton.getAttribute("aria-keyshortcuts")).toBe("D");
    expect(deleteButton.textContent).toContain("Delete");
    expect(deleteButton.textContent).toContain("D");

    fireEvent.keyDown(window, { key: "d" });
    await waitFor(() => expect(remove).toHaveBeenCalledWith("e1"));
    expect(restore).not.toHaveBeenCalled();
  });

  it("never opens the popover when the global stash is empty", () => {
    render(
      <PromptStashControl
        controller={makeController({
          rows: [],
          menuOpen: true,
        })}
        pickerStore={createComposerPickerStore()}
      />,
    );

    expect(screen.queryByText("Stashed prompts")).toBeNull();
    expect(screen.queryByText(/nothing stashed yet/i)).toBeNull();
  });

  it("shows a newly created first stash without opening the popover", () => {
    const pickerStore = createComposerPickerStore();
    const { rerender } = render(
      <PromptStashControl
        controller={makeController({ rows: [], menuOpen: false })}
        pickerStore={pickerStore}
      />,
    );

    rerender(
      <PromptStashControl
        controller={makeController({
          rows: entryRows([textEntry("e1", "first stash", Date.now())]),
          menuOpen: false,
        })}
        pickerStore={pickerStore}
      />,
    );

    expect(
      screen.getByRole("button", { name: /stashed prompts: 1/i }),
    ).not.toBeNull();
    expect(screen.queryByText("first stash")).toBeNull();
  });

  it("renders image blocks through the shared rich-content preview", async () => {
    render(
      <PromptStashControl
        controller={makeController({
          rows: entryRows([imageOnlyEntry("img-entry")]),
        })}
        pickerStore={createComposerPickerStore()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /stashed prompts: 1/i }),
    );
    expect(await screen.findByText("Image#1")).toBeTruthy();
    expect(screen.getByLabelText("Attached Image#1: shot.png")).toBeTruthy();
    const row = screen.getByText("Image#1").closest("[cmdk-item]");
    const metadata = row?.querySelector(
      '[data-slot="prompt-stash-row-metadata"]',
    );
    expect(metadata?.children).toHaveLength(1);
    expect(metadata?.textContent).not.toBe("");
  });

  it("preserves inline image placement inside a mixed stashed prompt", async () => {
    const entry: PromptStashEntry = {
      id: "mixed-image-entry",
      createdAt: Date.now(),
      blobHashes: ["hash-a", "hash-b"],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "This contains " },
              {
                type: "imageAttachment",
                attrs: {
                  id: "img-a",
                  fileName: "first.png",
                  hash: "hash-a",
                  b64content: null,
                  mimeType: "image/png",
                  size: 12,
                },
              },
              { type: "text", text: " and also here " },
              {
                type: "imageAttachment",
                attrs: {
                  id: "img-b",
                  fileName: "second.png",
                  hash: "hash-b",
                  b64content: null,
                  mimeType: "image/png",
                  size: 14,
                },
              },
            ],
          },
        ],
      },
    };

    render(
      <PromptStashControl
        controller={makeController({ rows: entryRows([entry]) })}
        pickerStore={createComposerPickerStore()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /stashed prompts: 1/i }),
    );

    const preview = await screen.findByTestId("prompt-stash-content-preview");
    expect(preview.textContent).toBe(
      "This contains Image#1 and also here Image#2",
    );
    expect(screen.getByLabelText("Attached Image#1: first.png")).toBeTruthy();
    expect(screen.getByLabelText("Attached Image#2: second.png")).toBeTruthy();
  });

  it("preserves lists and mention chips in stashed prompt rows", async () => {
    const entry: PromptStashEntry = {
      id: "rich-entry",
      createdAt: Date.now(),
      blobHashes: [],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Review " },
              {
                type: "mention",
                attrs: {
                  contextType: "file",
                  id: "/tmp/README.md",
                  path: "README.md",
                  pathKind: "file",
                  relPath: "README.md",
                  absolutePath: "/tmp/README.md",
                  workspacePath: "/tmp",
                  label: "README.md",
                  description: null,
                },
              },
            ],
          },
          {
            type: "orderedList",
            attrs: { start: 3 },
            content: [
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "Keep structure" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    };

    render(
      <PromptStashControl
        controller={makeController({ rows: entryRows([entry]) })}
        pickerStore={createComposerPickerStore()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /stashed prompts: 1/i }),
    );

    expect(await screen.findByText("README.md")).toBeTruthy();
    const list = screen.getByRole("list");
    if (!(list instanceof HTMLOListElement)) {
      throw new Error("Expected an ordered list in the stash preview");
    }
    expect(list.start).toBe(3);
    expect(screen.getByText("Keep structure")).toBeTruthy();
  });

  it("renders unavailable rows without Insert, with Delete, and Copy only when text exists", async () => {
    const remove = vi.fn(() => Promise.resolve(undefined));
    const restore = vi.fn(() => Promise.resolve(true));
    const writeText = vi.fn(() => Promise.resolve(undefined));
    const originalClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    onTestFinished(() => {
      if (originalClipboard === undefined) {
        Reflect.deleteProperty(navigator, "clipboard");
        return;
      }
      Object.defineProperty(navigator, "clipboard", originalClipboard);
    });

    const withText = {
      kind: "unavailable" as const,
      id: "u-text",
      createdAt: Date.now(),
      content: textEntry("u-text", "recoverable text", Date.now()).content,
    };
    const withoutText = {
      kind: "unavailable" as const,
      id: "u-empty",
      createdAt: Date.now() - 1,
      content: null,
    };
    const entry = textEntry("e-ok", "healthy entry", Date.now());

    render(
      <PromptStashControl
        controller={makeController({
          rows: [withText, withoutText, entryRow(entry)],
          remove,
          restore,
        })}
        pickerStore={createComposerPickerStore()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /stashed prompts: 3/i }),
    );
    expect(await screen.findByText("recoverable text")).toBeTruthy();
    expect(
      screen.getByText(
        "Unavailable - this stashed prompt could not be restored.",
      ),
    ).toBeTruthy();

    // No Insert affordance on either unavailable row; one exists on the healthy entry.
    expect(
      screen.getAllByRole("button", { name: /insert stashed prompt/i }),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: /delete stashed prompt/i }),
    ).toHaveLength(3);
    // Copy only when best-effort text is non-empty.
    expect(
      screen.getAllByRole("button", { name: /copy stashed text/i }),
    ).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /copy stashed text/i }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("recoverable text");
    });

    const deleteButtons = screen.getAllByRole("button", {
      name: /delete stashed prompt/i,
    });
    expect(deleteButtons).toHaveLength(3);
    fireEvent.click(deleteButtons[0]);
    await waitFor(() => {
      expect(remove).toHaveBeenCalledWith("u-text");
    });
    expect(restore).not.toHaveBeenCalled();
  });

  it("Enter is a no-op on a highlighted unavailable row; D still deletes", async () => {
    const remove = vi.fn(() => Promise.resolve(undefined));
    const restore = vi.fn(() => Promise.resolve(true));
    const rows = [
      {
        kind: "unavailable" as const,
        id: "u1",
        createdAt: Date.now(),
        content: textEntry("u1", "broken", Date.now()).content,
      },
      entryRow(textEntry("e1", "healthy", Date.now())),
    ];
    render(
      <PromptStashControl
        controller={makeController({ rows, remove, restore })}
        pickerStore={createComposerPickerStore()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /stashed prompts: 2/i }),
    );
    await screen.findByText("broken");

    fireEvent.keyDown(window, { key: "Enter" });
    await Promise.resolve();
    expect(restore).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "d" });
    await waitFor(() => {
      expect(remove).toHaveBeenCalledWith("u1");
    });
  });

  it("Enter on a highlighted unavailable row is consumed (defaultPrevented) and never reaches the focused editor", async () => {
    // The popover keeps the underlying editor focused while open
    // (`onOpenAutoFocus` preventDefault). Enter on an unavailable row must
    // therefore be defaultPrevented + stopPropagated in the capture-phase
    // window listener - not merely no-restore - or the focused editor would
    // submit the draft.
    const restore = vi.fn(() => Promise.resolve(true));
    const submitOnEnter = vi.fn();
    const rows = [
      {
        kind: "unavailable" as const,
        id: "u1",
        createdAt: Date.now(),
        content: textEntry("u1", "broken", Date.now()).content,
      },
      entryRow(textEntry("e1", "healthy", Date.now())),
    ];

    render(
      <div>
        <div
          role="textbox"
          contentEditable
          tabIndex={-1}
          data-testid="fake-editor"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              submitOnEnter();
            }
          }}
        />
        <PromptStashControl
          controller={makeController({ rows, restore })}
          pickerStore={createComposerPickerStore()}
        />
      </div>,
    );

    const fakeEditor = screen.getByTestId("fake-editor");
    fakeEditor.focus();
    expect(document.activeElement).toBe(fakeEditor);

    fireEvent.click(
      screen.getByRole("button", { name: /stashed prompts: 2/i }),
    );
    await screen.findByText("broken");

    // Match production: popover never steals focus from the editor. Re-assert
    // focus before dispatching so the keydown originates on the focused target.
    fakeEditor.focus();
    expect(document.activeElement).toBe(fakeEditor);

    // Dispatch on the focused element (not window). PromptStashControl's
    // capture-phase window listener still sees the event first; preventDefault
    // there makes dispatchEvent / fireEvent.keyDown return false.
    const notCanceled = fireEvent.keyDown(fakeEditor, {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });

    expect(notCanceled).toBe(false);
    expect(submitOnEnter).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it("arrow keys navigate across entry and unavailable rows", async () => {
    const rows = [
      entryRow(textEntry("e1", "first entry", Date.now())),
      {
        kind: "unavailable" as const,
        id: "u1",
        createdAt: Date.now() - 1,
        content: textEntry("u1", "middle unavailable", Date.now()).content,
      },
      entryRow(textEntry("e2", "third entry", Date.now())),
    ];
    render(
      <PromptStashControl
        controller={makeController({ rows })}
        pickerStore={createComposerPickerStore()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /stashed prompts: 3/i }),
    );
    const first = (await screen.findByText("first entry")).closest(
      "[cmdk-item]",
    );
    const middle = screen
      .getByText("middle unavailable")
      .closest("[cmdk-item]");
    const third = screen.getByText("third entry").closest("[cmdk-item]");
    expect(first?.getAttribute("data-selected")).toBe("true");

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() => {
      expect(middle?.getAttribute("data-selected")).toBe("true");
    });
    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() => {
      expect(third?.getAttribute("data-selected")).toBe("true");
    });
    fireEvent.keyDown(window, { key: "ArrowUp" });
    await waitFor(() => {
      expect(middle?.getAttribute("data-selected")).toBe("true");
    });
  });
});
