import {
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
} from "@floating-ui/dom";
import type { MentionCollaborator } from "@/hooks/comments/use-mention-collaborators";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { deriveInitials } from "./mention-utils";

/**
 * Imperative handle the Tiptap suggestion `render()` lifecycle calls into so
 * arrow / Enter / Escape keystrokes captured by the editor can drive the
 * floating list without React having to own the keymap. The composer wires
 * the ref through `useImperativeHandle` and the suggestion plugin's
 * `onKeyDown` callback returns whatever this handle returns - `true` to
 * swallow, `false` to fall through.
 */
export interface MentionSuggestionListHandle {
  onKeyDown(event: KeyboardEvent): boolean;
}

export interface MentionSuggestionListProps {
  readonly items: ReadonlyArray<MentionCollaborator>;
  readonly command: (attrs: { id: string; label: string }) => void;
  readonly getReferenceClientRect: (() => DOMRect | null) | null;
  readonly ref?: Ref<MentionSuggestionListHandle>;
}

/**
 * Floating list rendered into `document.body` while a `@` mention query is
 * active inside the comment composer. The list itself is a thin presentation
 * layer - the composer owns lifetime, the suggestion plugin owns input
 * dispatch.
 *
 * Positioning uses `@floating-ui/dom` with `autoUpdate` so the popover stays
 * pinned to the caret while the user types or scrolls. We deliberately don't
 * use `cmdk`'s `Command` here: `cmdk` insists on owning the focused element
 * (a hidden input), but the editor must keep DOM focus so its key handlers
 * keep firing. A handcrafted listbox sidesteps that conflict.
 */
export function MentionSuggestionList({
  items,
  command,
  getReferenceClientRect,
  ref,
}: MentionSuggestionListProps) {
  const itemsKey = mentionSuggestionItemsKey(items);
  return (
    <MentionSuggestionListContent
      key={itemsKey}
      items={items}
      command={command}
      getReferenceClientRect={getReferenceClientRect}
      ref={ref}
    />
  );
}

function MentionSuggestionListContent({
  items,
  command,
  getReferenceClientRect,
  ref,
}: MentionSuggestionListProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const floatingRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useImperativeHandle(
    ref,
    () => ({
      onKeyDown(event: KeyboardEvent) {
        if (items.length === 0) return false;
        if (event.key === "ArrowDown") {
          setSelectedIndex((prior) => (prior + 1) % items.length);
          return true;
        }
        if (event.key === "ArrowUp") {
          setSelectedIndex(
            (prior) => (prior - 1 + items.length) % items.length,
          );
          return true;
        }
        if (event.key === "Enter") {
          const choice = items[selectedIndex] ?? items[0];
          command({ id: choice.userId, label: choice.displayName });
          return true;
        }
        return false;
      },
    }),
    [items, selectedIndex, command],
  );

  useLayoutEffect(() => {
    const floating = floatingRef.current;
    if (floating === null) return;
    if (getReferenceClientRect === null) return;
    const virtualReference = {
      getBoundingClientRect: () => {
        const rect = getReferenceClientRect();
        if (rect === null) return new DOMRect(0, 0, 0, 0);
        return rect;
      },
    };
    const reposition = () => {
      void computePosition(virtualReference, floating, {
        placement: "bottom-start",
        middleware: [offset(6), flip(), shift({ padding: 8 })],
      }).then(({ x, y }) => {
        floating.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(
          y,
        )}px, 0)`;
      });
    };
    reposition();
    const cleanup = autoUpdate(virtualReference, floating, reposition);
    return cleanup;
  }, [getReferenceClientRect, items.length]);

  useLayoutEffect(() => {
    if (items.length === 0) return;
    const node = itemRefs.current[selectedIndex] ?? null;
    if (node === null) return;
    node.scrollIntoView({ block: "nearest" });
  }, [items.length, selectedIndex]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={floatingRef}
      role="listbox"
      aria-label="Mention collaborator"
      data-slot="mention-suggestion"
      className={cn(
        "absolute top-0 left-0 z-50 w-[min(80vw,18rem)] max-h-[min(40vh,18rem)] overflow-y-auto rounded-md border border-border bg-popover p-1 text-ui-sm text-popover-foreground shadow-md outline-none",
      )}
    >
      {items.length === 0 ? (
        <div className="px-2 py-3 text-center text-ui-xs text-muted-foreground">
          No matching collaborators
        </div>
      ) : (
        items.map((item, index) => {
          const isSelected = index === selectedIndex;
          return (
            <button
              key={item.userId}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              type="button"
              role="option"
              aria-selected={isSelected}
              data-selected={isSelected ? "true" : undefined}
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left outline-none",
                "data-[selected=true]:bg-muted data-[selected=true]:text-foreground",
                "hover:bg-muted/70",
              )}
              onMouseEnter={() => setSelectedIndex(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                command({ id: item.userId, label: item.displayName });
              }}
            >
              <Avatar size="sm">
                <AvatarFallback>
                  {deriveInitials(item.displayName)}
                </AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-ui-sm leading-tight">
                  {item.displayName}
                </span>
                {item.email.length > 0 && item.email !== item.displayName ? (
                  <span className="truncate text-ui-xs text-muted-foreground">
                    {item.email}
                  </span>
                ) : null}
              </div>
            </button>
          );
        })
      )}
    </div>,
    document.body,
  );
}

function mentionSuggestionItemsKey(
  items: ReadonlyArray<MentionCollaborator>,
): string {
  if (items.length === 0) return "empty";
  return items
    .map((item) => `${item.userId}\u0000${item.displayName}\u0000${item.email}`)
    .join("\u0001");
}
