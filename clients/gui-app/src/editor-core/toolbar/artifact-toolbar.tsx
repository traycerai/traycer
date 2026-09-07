import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { NodeSelection } from "@tiptap/pm/state";
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
import { shortcutHintsVisible } from "@/lib/keybindings/shortcut-hints";

// Toolbar button labels double as their tooltip text, so the chord is part of
// the label rather than a separate chip. Where shortcut hints are suppressed
// the plain action name is what remains.
function linkToolbarLabel(): string {
  if (!shortcutHintsVisible()) return "Link";
  return isMac() ? "Link (⌘K)" : "Link (Ctrl+K)";
}

function commentToolbarLabel(): string {
  if (!shortcutHintsVisible()) return "Comment";
  return "Comment (⌘⌥M)";
}

export interface ArtifactCommentAction {
  /** Snap the current selection into a draft and open the floating
   *  composer. The host wires this to its tile-scoped draft creator. */
  readonly onStart: () => void;
}

export interface ArtifactToolbarProps {
  readonly editor: Editor;
  readonly className: string | undefined;
  /** Tile-owned scroll container. The bubble-menu plugin listens to this element so the toolbar stays anchored while the tile body scrolls. */
  readonly scrollTarget: HTMLElement | null;
  /** null for chat. Non-null shows the comment button even for viewers; formatting stays disabled when not editable. */
  readonly commentAction: ArtifactCommentAction | null;
  /** Hide while a higher-priority surface owns the range (comment draft). Never both. */
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
 * Bubble formatting toolbar. `useEditorState` for active-state because the host sets `shouldRerenderOnTransaction: false`. Undo is keyboard-only.
 */
export function ArtifactToolbar(props: ArtifactToolbarProps) {
  const { editor, className, scrollTarget, commentAction, suppressBubbleMenu } =
    props;

  const state = useEditorState<ToolbarState>({
    editor,
    selector: selectToolbarState,
  });

  const editable = editor.isEditable;
  const linkShortcutLabel = linkToolbarLabel();
  const bubbleMenuOptions = useMemo(
    () => createArtifactToolbarOptions(scrollTarget),
    [scrollTarget],
  );
  const canShowToolbar = useCallback(
    (currentEditor: Editor, from: number, to: number): boolean => {
      // Viewers still see the bar when commenting is available. Formatting
      // stays disabled.
      if (!currentEditor.isEditable && commentAction === null) return false;
      // Hide inside code blocks - inline formatting would be rejected
      // by the schema and the bar would flash against an empty selection.
      if (currentEditor.isActive("codeBlock")) return false;
      // Hide over atom blocks: text formatting does not apply to images, and
      // diagrams ship their own floating toolbars.
      if (currentEditor.isActive("mermaidBlock")) return false;
      if (currentEditor.isActive("uiPreviewBlock")) return false;
      if (currentEditor.isActive("image")) return false;
      if (currentEditor.state.selection instanceof NodeSelection) return false;
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

  // Toolbar still mounts so BubbleMenu keeps listeners; shouldShow is false for
  // viewers. z-index 40 stays below Dialog overlay at 50.
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
                label={commentToolbarLabel()}
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
