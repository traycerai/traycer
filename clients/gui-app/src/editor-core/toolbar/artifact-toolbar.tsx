import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import {
  Bold,
  Code,
  CodeSquare,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  List,
  ListOrdered,
  ListTodo,
  Link,
  MessageSquarePlus,
  Quote,
  Strikethrough,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  artifactToolbarPluginKey,
  createArtifactToolbarOptions,
  hideArtifactToolbar,
  showArtifactToolbar,
} from "./artifact-toolbar-position";
import { ToolbarButton } from "./toolbar-button";
import { ARTIFACT_LINK_CREATE_EVENT } from "../links/artifact-link-popover";
import { canUseArtifactLinkControl } from "../links/artifact-link-selection";
import { isMac } from "@/lib/keybindings/platform";

export interface ArtifactCommentAction {
  /** Snap the current selection into a draft and open the floating
   *  composer. The host wires this to its tile-scoped draft creator. */
  readonly onStart: () => void;
}

export interface ArtifactToolbarProps {
  readonly editor: Editor;
  readonly className: string | undefined;
  /**
   * Tile-owned scroll container. The bubble-menu plugin listens to this
   * element so the toolbar stays anchored while the tile body scrolls.
   */
  readonly scrollTarget: HTMLElement | null;
  /**
   * Pass `null` for tiles whose artifact type doesn't support comments
   * (chat). When non-null, the bubble bar shows the 💬 button on every
   * non-collapsed selection - including for viewers, who can comment but
   * not format. The formatting buttons stay `disabled` for non-editable
   * editors while the comment button remains active.
   */
  readonly commentAction: ArtifactCommentAction | null;
  /**
   * Hide the selection bubble while a higher-priority selection surface owns
   * the range, e.g. the comment draft composer. This keeps the interaction
   * model single-modal: selection menu -> comment composer, never both.
   */
  readonly suppressBubbleMenu: boolean;
}

interface ToolbarState {
  readonly isBold: boolean;
  readonly isItalic: boolean;
  readonly isStrike: boolean;
  readonly isHeading1: boolean;
  readonly isHeading2: boolean;
  readonly isHeading3: boolean;
  readonly isBulletList: boolean;
  readonly isOrderedList: boolean;
  readonly isTaskList: boolean;
  readonly isBlockquote: boolean;
  readonly isCodeBlock: boolean;
  readonly isCodeInline: boolean;
  readonly isLink: boolean;
  readonly canUseLinkControl: boolean;
}

function selectToolbarState({ editor }: { editor: Editor }): ToolbarState {
  return {
    isBold: editor.isActive("bold"),
    isItalic: editor.isActive("italic"),
    isStrike: editor.isActive("strike"),
    isHeading1: editor.isActive("heading", { level: 1 }),
    isHeading2: editor.isActive("heading", { level: 2 }),
    isHeading3: editor.isActive("heading", { level: 3 }),
    isBulletList: editor.isActive("bulletList"),
    isOrderedList: editor.isActive("orderedList"),
    isTaskList: editor.isActive("taskList"),
    isBlockquote: editor.isActive("blockquote"),
    isCodeBlock: editor.isActive("codeBlock"),
    isCodeInline: editor.isActive("code"),
    isLink: editor.isActive("link"),
    canUseLinkControl: canUseArtifactLinkControl(editor),
  };
}

/**
 * Floating bubble-menu formatting toolbar. Rides on `@tiptap/react/menus`'s
 * `BubbleMenu`, which positions the menu above the current selection via
 * Floating UI and hides whenever the selection is collapsed. The benefit
 * over a sticky bar is that the menu is only present when the user is
 * actively formatting - it stays out of the way while reading or drafting
 * and appears exactly where the caret is.
 *
 * Active-state is driven by `useEditorState` so the subscription stays
 * selector-scoped; the host editor sets `shouldRerenderOnTransaction: false`
 * for view cost, which would otherwise prevent the bar from reflecting
 * toggle state without a full re-render.
 *
 * History (undo/redo) lives on the Yjs undo manager and is driven via
 * keyboard (⌘Z / ⌘⇧Z); it is intentionally not exposed in the bubble bar.
 */
export function ArtifactToolbar(props: ArtifactToolbarProps) {
  const { editor, className, scrollTarget, commentAction, suppressBubbleMenu } =
    props;

  const state = useEditorState<ToolbarState>({
    editor,
    selector: selectToolbarState,
  });

  const editable = editor.isEditable;
  const linkShortcutLabel = isMac() ? "Link (⌘K)" : "Link (Ctrl+K)";
  const bubbleMenuOptions = useMemo(
    () => createArtifactToolbarOptions(scrollTarget),
    [scrollTarget],
  );
  const canShowToolbar = useCallback(
    (currentEditor: Editor, from: number, to: number): boolean => {
      // Viewers (non-editable) still see the bar when commenting is
      // available - the bar will only render the 💬 button via the
      // `commentAction !== null` branch below; formatting buttons stay
      // disabled regardless.
      if (!currentEditor.isEditable && commentAction === null) return false;
      // Hide inside code blocks - inline formatting would be rejected
      // by the schema and the bar would flash against an empty selection.
      if (currentEditor.isActive("codeBlock")) return false;
      // Hide over atom blocks (mermaid diagrams / wireframes) - each
      // ships its own floating toolbar and the global formatting bar
      // would fight with it visually and semantically.
      if (currentEditor.isActive("mermaidBlock")) return false;
      if (currentEditor.isActive("uiPreviewBlock")) return false;
      return from !== to;
    },
    [commentAction],
  );
  const shouldShow = useCallback(
    ({
      editor: currentEditor,
      from,
      to,
    }: {
      readonly editor: Editor;
      readonly from: number;
      readonly to: number;
    }): boolean => {
      // Keep BubbleMenu mounted for the editor's lifetime. Unmounting it
      // unregisters its ProseMirror plugin and reconfigures the state; with
      // ySync that can emit a full-document replacement transaction.
      return !suppressBubbleMenu && canShowToolbar(currentEditor, from, to);
    },
    [canShowToolbar, suppressBubbleMenu],
  );

  const previouslySuppressedRef = useRef(suppressBubbleMenu);
  useEffect(() => {
    const previouslySuppressed = previouslySuppressedRef.current;
    previouslySuppressedRef.current = suppressBubbleMenu;
    if (suppressBubbleMenu) {
      hideArtifactToolbar(editor);
      return;
    }
    if (!previouslySuppressed) return;
    const { from, to } = editor.state.selection;
    if (canShowToolbar(editor, from, to)) showArtifactToolbar(editor);
  }, [canShowToolbar, editor, suppressBubbleMenu]);

  // Focus the editor after a button click so the selection does not collapse
  // through the button's momentary focus steal (which would dismiss the menu).
  const run = (fn: () => void): void => {
    fn();
    editor.view.focus();
  };

  // `editor.isEditable` gates visibility at the data level: the toolbar still
  // mounts (so BubbleMenu can keep its listeners attached), but its own
  // `shouldShow` returns false for viewers. Buttons are also `disabled` as a
  // second layer in case the menu is forced open by custom callers.
  // `style` lands on BubbleMenu's positioned wrapper, not the inner toolbar.
  // Keep z-index 40 below the shared Dialog overlay/content at z-50, including
  // future dialogs that opt out of Radix's default focus transfer.
  return (
    <BubbleMenu
      editor={editor}
      pluginKey={artifactToolbarPluginKey}
      options={bubbleMenuOptions}
      shouldShow={shouldShow}
      style={{ zIndex: 40 }}
    >
      <div
        role="toolbar"
        aria-label="Editor formatting"
        className={className ?? "tc-editor-bubble-menu"}
      >
        <div className="tc-editor-toolbar-group" data-group="heading">
          <ToolbarButton
            icon={<Heading1 className="size-4" aria-hidden="true" />}
            label="Heading 1"
            active={state.isHeading1}
            disabled={!editable}
            onClick={() =>
              run(() =>
                editor.chain().focus().toggleHeading({ level: 1 }).run(),
              )
            }
            className="tc-editor-toolbar-button"
          />
          <ToolbarButton
            icon={<Heading2 className="size-4" aria-hidden="true" />}
            label="Heading 2"
            active={state.isHeading2}
            disabled={!editable}
            onClick={() =>
              run(() =>
                editor.chain().focus().toggleHeading({ level: 2 }).run(),
              )
            }
            className="tc-editor-toolbar-button"
          />
          <ToolbarButton
            icon={<Heading3 className="size-4" aria-hidden="true" />}
            label="Heading 3"
            active={state.isHeading3}
            disabled={!editable}
            onClick={() =>
              run(() =>
                editor.chain().focus().toggleHeading({ level: 3 }).run(),
              )
            }
            className="tc-editor-toolbar-button"
          />
        </div>

        <div className="tc-editor-toolbar-separator" aria-hidden="true" />

        <div className="tc-editor-toolbar-group" data-group="mark">
          <ToolbarButton
            icon={<Bold className="size-4" aria-hidden="true" />}
            label="Bold"
            active={state.isBold}
            disabled={!editable}
            onClick={() => run(() => editor.chain().focus().toggleBold().run())}
            className="tc-editor-toolbar-button"
          />
          <ToolbarButton
            icon={<Italic className="size-4" aria-hidden="true" />}
            label="Italic"
            active={state.isItalic}
            disabled={!editable}
            onClick={() =>
              run(() => editor.chain().focus().toggleItalic().run())
            }
            className="tc-editor-toolbar-button"
          />
          <ToolbarButton
            icon={<Strikethrough className="size-4" aria-hidden="true" />}
            label="Strikethrough"
            active={state.isStrike}
            disabled={!editable}
            onClick={() =>
              run(() => editor.chain().focus().toggleStrike().run())
            }
            className="tc-editor-toolbar-button"
          />
          <ToolbarButton
            icon={<Link className="size-4" aria-hidden="true" />}
            label={linkShortcutLabel}
            active={state.isLink}
            disabled={!editable || !state.canUseLinkControl}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              editor.view.dom.dispatchEvent(
                new CustomEvent(ARTIFACT_LINK_CREATE_EVENT),
              );
            }}
            className="tc-editor-toolbar-button"
          />
        </div>

        <div className="tc-editor-toolbar-separator" aria-hidden="true" />

        <div className="tc-editor-toolbar-group" data-group="list">
          <ToolbarButton
            icon={<List className="size-4" aria-hidden="true" />}
            label="Bullet list"
            active={state.isBulletList}
            disabled={!editable}
            onClick={() =>
              run(() => editor.chain().focus().toggleBulletList().run())
            }
            className="tc-editor-toolbar-button"
          />
          <ToolbarButton
            icon={<ListOrdered className="size-4" aria-hidden="true" />}
            label="Numbered list"
            active={state.isOrderedList}
            disabled={!editable}
            onClick={() =>
              run(() => editor.chain().focus().toggleOrderedList().run())
            }
            className="tc-editor-toolbar-button"
          />
          <ToolbarButton
            icon={<ListTodo className="size-4" aria-hidden="true" />}
            label="Task list"
            active={state.isTaskList}
            disabled={!editable}
            onClick={() =>
              run(() => editor.chain().focus().toggleTaskList().run())
            }
            className="tc-editor-toolbar-button"
          />
        </div>

        <div className="tc-editor-toolbar-separator" aria-hidden="true" />

        <div className="tc-editor-toolbar-group" data-group="block">
          <ToolbarButton
            icon={<Quote className="size-4" aria-hidden="true" />}
            label="Quote"
            active={state.isBlockquote}
            disabled={!editable}
            onClick={() =>
              run(() => editor.chain().focus().toggleBlockquote().run())
            }
            className="tc-editor-toolbar-button"
          />
          <ToolbarButton
            icon={<Code className="size-4" aria-hidden="true" />}
            label="Inline code"
            active={state.isCodeInline}
            disabled={!editable}
            onClick={() => run(() => editor.chain().focus().toggleCode().run())}
            className="tc-editor-toolbar-button"
          />
          <ToolbarButton
            icon={<CodeSquare className="size-4" aria-hidden="true" />}
            label="Code block"
            active={state.isCodeBlock}
            disabled={!editable}
            onClick={() =>
              run(() => editor.chain().focus().toggleCodeBlock().run())
            }
            className="tc-editor-toolbar-button"
          />
        </div>

        {commentAction !== null ? (
          <>
            <div className="tc-editor-toolbar-separator" aria-hidden="true" />
            <div className="tc-editor-toolbar-group" data-group="comment">
              <ToolbarButton
                icon={
                  <MessageSquarePlus className="size-4" aria-hidden="true" />
                }
                label="Comment (⌘⌥M)"
                active={false}
                disabled={false}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commentAction.onStart()}
                className="tc-editor-toolbar-button"
              />
            </div>
          </>
        ) : null}
      </div>
    </BubbleMenu>
  );
}
