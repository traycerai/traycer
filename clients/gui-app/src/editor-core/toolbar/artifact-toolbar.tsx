import type { Editor } from "@tiptap/react";
import { useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { NodeSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import {
  Bold,
  ChevronDown,
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
  MessageSquareShare,
  Quote,
  Strikethrough,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  artifactToolbarPluginKey,
  createArtifactToolbarOptions,
  hideArtifactToolbar,
  showArtifactToolbar,
} from "./artifact-toolbar-position";
import { ToolbarActionButton } from "./toolbar-action-button";
import { ToolbarButton } from "./toolbar-button";
import { ARTIFACT_LINK_CREATE_EVENT } from "../links/artifact-link-popover";
import { canUseArtifactLinkControl } from "../links/artifact-link-selection";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isMac } from "@/lib/keybindings/platform";
import { shortcutHintsVisible } from "@/lib/keybindings/shortcut-hints";

// Toolbar button labels double as their tooltip text, so the chord is part of
// the label rather than a separate chip. Where shortcut hints are suppressed
// the plain action name is what remains.
function linkToolbarLabel(): string {
  if (!shortcutHintsVisible()) return "Link";
  return isMac() ? "Link (⌘K)" : "Link (Ctrl+K)";
}

// The visible word stays "Comment"; only the hover text carries the chord.
function commentToolbarTooltip(): string | null {
  if (!shortcutHintsVisible()) return null;
  return "Comment (⌘⌥M)";
}

export interface ArtifactCommentAction {
  /** Snap the current selection into a draft and open the floating
   *  composer. The host wires this to its tile-scoped draft creator. */
  readonly onStart: () => void;
}

export interface ArtifactQuoteAction {
  /** Freeze the current selection and open the send-to-chat picker over it.
   *  The host wires this to its tile-scoped quote snapshot. */
  readonly onStart: () => void;
}

export interface ArtifactToolbarProps {
  readonly editor: Editor;
  readonly className: string | undefined;
  /**
   * Tile-owned scroll container. The bubble-menu plugin listens to this
   * element so the toolbar stays anchored while the tile body scrolls, and
   * its width is what decides whether the formatting groups fit.
   */
  readonly scrollTarget: HTMLElement | null;
  /**
   * Pass `null` for tiles whose artifact type doesn't support comments
   * (chat). When non-null, the bubble bar shows the Comment action on every
   * non-collapsed selection - including for viewers, who can comment but
   * not format.
   */
  readonly commentAction: ArtifactCommentAction | null;
  /**
   * Pass `null` for tiles whose content cannot be quoted into a chat. When
   * non-null, the bar shows the Send to chat action beside Comment, under the
   * same rules.
   */
  readonly quoteAction: ArtifactQuoteAction | null;
  /**
   * Hide the selection bubble while a higher-priority selection surface owns
   * the range, e.g. the comment draft composer or the send-to-chat picker.
   * This keeps the interaction model single-modal: selection menu -> one
   * follow-up surface, never both.
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
 * Room the bar keeps from the tile's edges before the formatting groups fold
 * into their overflow: the bubble plugin's own flip/shift padding on each side
 * (`createArtifactToolbarOptions`), plus a little so the bar never sits flush.
 */
const TOOLBAR_EDGE_INSET_PX = 16;

/**
 * Floating bubble-menu formatting toolbar. Rides on `@tiptap/react/menus`'s
 * `BubbleMenu`, which positions the menu above the current selection via
 * Floating UI and hides whenever the selection is collapsed. The benefit
 * over a sticky bar is that the menu is only present when the user is
 * actively formatting - it stays out of the way while reading or drafting
 * and appears exactly where the caret is.
 *
 * Two kinds of control live here, and they are eligible on different terms:
 *
 * - Formatting TOGGLES (icon-only `ToolbarButton`s) apply to editable prose.
 *   They are not rendered at all for a viewer, nor inside a code block where
 *   the schema would reject them - dead, disabled buttons are exactly the
 *   width a narrow tile cannot spare.
 * - ACTIONS (labeled `ToolbarActionButton`s: Comment, Send to chat) apply to
 *   any selection anyone can make, code included. They carry their words on
 *   screen because two speech-bubble icons are not tellable apart otherwise,
 *   and the words are the last thing this bar gives up: when the tile is too
 *   narrow for everything, the formatting groups fold into one "Aa" overflow
 *   menu first.
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
  const {
    editor,
    className,
    scrollTarget,
    commentAction,
    quoteAction,
    suppressBubbleMenu,
  } = props;

  const state = useEditorState<ToolbarState>({
    editor,
    selector: selectToolbarState,
  });

  const editable = editor.isEditable;
  const hasActions = commentAction !== null || quoteAction !== null;
  const showFormatting = editable && !state.isCodeBlock;
  const bubbleMenuOptions = useMemo(
    () => createArtifactToolbarOptions(scrollTarget),
    [scrollTarget],
  );
  const canShowToolbar = useCallback(
    (currentEditor: Editor, from: number, to: number): boolean => {
      // A viewer gets the bar only for what a viewer can do with it.
      if (!currentEditor.isEditable && !hasActions) return false;
      // Hide over atom blocks: text formatting does not apply to images, and
      // diagrams ship their own floating toolbars.
      if (currentEditor.isActive("mermaidBlock")) return false;
      if (currentEditor.isActive("uiPreviewBlock")) return false;
      if (currentEditor.isActive("image")) return false;
      if (currentEditor.state.selection instanceof NodeSelection) return false;
      // A table cell selection is not the `from..to` interval the actions
      // would quote or annotate, so neither kind of control fits it.
      if (currentEditor.state.selection instanceof CellSelection) return false;
      if (from === to) return false;
      // Inside a code block inline formatting would be rejected by the schema,
      // but the actions still apply - code is the one thing people most want
      // to send to an agent. The bar renders actions-only there.
      if (currentEditor.isActive("codeBlock")) return hasActions;
      return true;
    },
    [hasActions],
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

  const { toolbarRef, compact } = useCompactToolbar(
    scrollTarget,
    showFormatting,
  );

  // Focus the editor after a button click so the selection does not collapse
  // through the button's momentary focus steal (which would dismiss the menu).
  const run = (fn: () => void): void => {
    fn();
    editor.view.focus();
  };

  const formatting = showFormatting ? (
    <FormattingControls
      editor={editor}
      state={state}
      compact={compact}
      run={run}
    />
  ) : null;

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
        ref={toolbarRef}
        role="toolbar"
        aria-label="Editor formatting"
        data-compact={compact ? "true" : "false"}
        className={className ?? "tc-editor-bubble-menu"}
      >
        {formatting}
        {hasActions ? (
          <>
            {formatting !== null ? (
              <div className="tc-editor-toolbar-separator" aria-hidden="true" />
            ) : null}
            <div className="tc-editor-toolbar-group" data-group="actions">
              {commentAction !== null ? (
                <ToolbarActionButton
                  icon={
                    <MessageSquarePlus className="size-4" aria-hidden="true" />
                  }
                  label="Comment"
                  tooltip={commentToolbarTooltip()}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => commentAction.onStart()}
                  className="tc-editor-toolbar-action"
                />
              ) : null}
              {quoteAction !== null ? (
                <ToolbarActionButton
                  icon={
                    <MessageSquareShare className="size-4" aria-hidden="true" />
                  }
                  label="Send to chat"
                  tooltip={null}
                  aria-haspopup="menu"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => quoteAction.onStart()}
                  className="tc-editor-toolbar-action"
                />
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </BubbleMenu>
  );
}

/**
 * Decides whether the formatting groups fit beside the actions.
 *
 * The full bar's width is measured whenever it is laid out un-folded, and
 * compared against the tile's scroll container. Folding never re-measures
 * (the folded bar is narrower, and measuring it would keep the bar folded
 * forever), so the remembered full width is the hysteresis: the bar unfolds
 * exactly when the tile is wide enough for what it last measured.
 */
function useCompactToolbar(
  scrollTarget: HTMLElement | null,
  showFormatting: boolean,
): {
  readonly toolbarRef: (element: HTMLDivElement | null) => void;
  readonly compact: boolean;
} {
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const [tooNarrow, setTooNarrow] = useState(false);
  const fullWidthRef = useRef<number | null>(null);
  // Nothing to fold when the formatting groups are not rendered at all.
  const compact = showFormatting && tooNarrow;

  useEffect(() => {
    if (!showFormatting || scrollTarget === null || toolbar === null) return;
    // `observe` delivers an initial notification, so the first evaluation
    // happens through the observer rather than as a synchronous state write.
    const evaluate = (): void => {
      // The bubble plugin detaches the bar while hidden; a zero-width read is
      // "not laid out", never "fits in nothing".
      if (!compact && toolbar.offsetWidth > 0) {
        fullWidthRef.current = toolbar.offsetWidth;
      }
      const fullWidth = fullWidthRef.current;
      if (fullWidth === null) return;
      const available = scrollTarget.clientWidth - TOOLBAR_EDGE_INSET_PX * 2;
      setTooNarrow(available < fullWidth);
    };
    const observer = new ResizeObserver(evaluate);
    observer.observe(scrollTarget);
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, [compact, scrollTarget, showFormatting, toolbar]);

  return { toolbarRef: setToolbar, compact };
}

interface FormattingControlsProps {
  readonly editor: Editor;
  readonly state: ToolbarState;
  readonly compact: boolean;
  readonly run: (fn: () => void) => void;
}

interface FormattingCommand {
  readonly id: string;
  readonly icon: ReactNode;
  readonly label: string;
  readonly active: boolean;
  readonly disabled: boolean;
  /**
   * Keep the pointer from moving focus to the button. Only the link control
   * needs it: its popover takes focus itself and must find the selection
   * still there; every other command refocuses the editor through `run`.
   */
  readonly keepsEditorFocus: boolean;
  readonly onSelect: () => void;
}

interface FormattingGroup {
  readonly id: string;
  readonly commands: ReadonlyArray<FormattingCommand>;
}

function formattingGroups(
  editor: Editor,
  state: ToolbarState,
  run: (fn: () => void) => void,
): ReadonlyArray<FormattingGroup> {
  const chain = () => editor.chain().focus();
  return [
    {
      id: "heading",
      commands: [
        {
          id: "h1",
          icon: <Heading1 className="size-4" aria-hidden="true" />,
          label: "Heading 1",
          active: state.isHeading1,
          disabled: false,
          keepsEditorFocus: false,
          onSelect: () => run(() => chain().toggleHeading({ level: 1 }).run()),
        },
        {
          id: "h2",
          icon: <Heading2 className="size-4" aria-hidden="true" />,
          label: "Heading 2",
          active: state.isHeading2,
          disabled: false,
          keepsEditorFocus: false,
          onSelect: () => run(() => chain().toggleHeading({ level: 2 }).run()),
        },
        {
          id: "h3",
          icon: <Heading3 className="size-4" aria-hidden="true" />,
          label: "Heading 3",
          active: state.isHeading3,
          disabled: false,
          keepsEditorFocus: false,
          onSelect: () => run(() => chain().toggleHeading({ level: 3 }).run()),
        },
      ],
    },
    {
      id: "mark",
      commands: [
        {
          id: "bold",
          icon: <Bold className="size-4" aria-hidden="true" />,
          label: "Bold",
          active: state.isBold,
          disabled: false,
          keepsEditorFocus: false,
          onSelect: () => run(() => chain().toggleBold().run()),
        },
        {
          id: "italic",
          icon: <Italic className="size-4" aria-hidden="true" />,
          label: "Italic",
          active: state.isItalic,
          disabled: false,
          keepsEditorFocus: false,
          onSelect: () => run(() => chain().toggleItalic().run()),
        },
        {
          id: "strike",
          icon: <Strikethrough className="size-4" aria-hidden="true" />,
          label: "Strikethrough",
          active: state.isStrike,
          disabled: false,
          keepsEditorFocus: false,
          onSelect: () => run(() => chain().toggleStrike().run()),
        },
        {
          id: "link",
          icon: <Link className="size-4" aria-hidden="true" />,
          label: linkToolbarLabel(),
          active: state.isLink,
          disabled: !state.canUseLinkControl,
          keepsEditorFocus: true,
          // The link popover owns focus from here; it listens on the editor
          // root for this event and positions itself over the selection.
          onSelect: () => {
            editor.view.dom.dispatchEvent(
              new CustomEvent(ARTIFACT_LINK_CREATE_EVENT),
            );
          },
        },
      ],
    },
    {
      id: "list",
      commands: [
        {
          id: "bullet",
          icon: <List className="size-4" aria-hidden="true" />,
          label: "Bullet list",
          active: state.isBulletList,
          disabled: false,
          keepsEditorFocus: false,
          onSelect: () => run(() => chain().toggleBulletList().run()),
        },
        {
          id: "ordered",
          icon: <ListOrdered className="size-4" aria-hidden="true" />,
          label: "Numbered list",
          active: state.isOrderedList,
          disabled: false,
          keepsEditorFocus: false,
          onSelect: () => run(() => chain().toggleOrderedList().run()),
        },
        {
          id: "task",
          icon: <ListTodo className="size-4" aria-hidden="true" />,
          label: "Task list",
          active: state.isTaskList,
          disabled: false,
          keepsEditorFocus: false,
          onSelect: () => run(() => chain().toggleTaskList().run()),
        },
      ],
    },
    {
      id: "block",
      commands: [
        {
          id: "quote",
          icon: <Quote className="size-4" aria-hidden="true" />,
          label: "Quote",
          active: state.isBlockquote,
          disabled: false,
          keepsEditorFocus: false,
          onSelect: () => run(() => chain().toggleBlockquote().run()),
        },
        {
          id: "code",
          icon: <Code className="size-4" aria-hidden="true" />,
          label: "Inline code",
          active: state.isCodeInline,
          disabled: false,
          keepsEditorFocus: false,
          onSelect: () => run(() => chain().toggleCode().run()),
        },
        {
          id: "code-block",
          icon: <CodeSquare className="size-4" aria-hidden="true" />,
          label: "Code block",
          active: state.isCodeBlock,
          disabled: false,
          keepsEditorFocus: false,
          onSelect: () => run(() => chain().toggleCodeBlock().run()),
        },
      ],
    },
  ];
}

/**
 * The formatting toggles, either laid out as groups or folded into one menu.
 *
 * The folded menu portals into the editor's own wrapper rather than `<body>`.
 * The bubble plugin hides the bar when editor focus moves to anything outside
 * the bar's parent, and a Radix menu focuses its content as it opens; keeping
 * that content inside the same parent is what lets the menu open without the
 * bar vanishing underneath it. Selecting an item refocuses the editor, which
 * is what re-shows the bar after the menu closes.
 */
function FormattingControls(props: FormattingControlsProps) {
  const { editor, state, compact, run } = props;
  const groups = formattingGroups(editor, state, run);
  const [menuOpen, setMenuOpen] = useState(false);

  if (!compact) {
    return (
      <>
        {groups.map((group, index) => (
          <FormattingGroupButtons
            key={group.id}
            group={group}
            trailingSeparator={index < groups.length - 1}
          />
        ))}
      </>
    );
  }

  return (
    <DropdownMenu modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <ToolbarActionButton
          icon={
            <ChevronDown
              className="order-last size-3.5 text-muted-foreground"
              aria-hidden="true"
            />
          }
          label="Aa"
          tooltip="Formatting"
          aria-label="Formatting"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="tc-editor-toolbar-action"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        container={editor.view.dom.parentElement}
        className="min-w-44"
      >
        {groups.map((group, index) => (
          <FormattingGroupItems
            key={group.id}
            group={group}
            trailingSeparator={index < groups.length - 1}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FormattingGroupButtons(props: {
  readonly group: FormattingGroup;
  readonly trailingSeparator: boolean;
}) {
  return (
    <>
      <div className="tc-editor-toolbar-group" data-group={props.group.id}>
        {props.group.commands.map((command) => (
          <ToolbarButton
            key={command.id}
            icon={command.icon}
            label={command.label}
            active={command.active}
            disabled={command.disabled}
            onMouseDown={
              command.keepsEditorFocus
                ? (event) => event.preventDefault()
                : undefined
            }
            onClick={command.onSelect}
            className="tc-editor-toolbar-button"
          />
        ))}
      </div>
      {props.trailingSeparator ? (
        <div className="tc-editor-toolbar-separator" aria-hidden="true" />
      ) : null}
    </>
  );
}

function FormattingGroupItems(props: {
  readonly group: FormattingGroup;
  readonly trailingSeparator: boolean;
}) {
  return (
    <>
      {props.group.commands.map((command) => (
        <DropdownMenuItem
          key={command.id}
          disabled={command.disabled}
          data-active={command.active ? "true" : "false"}
          onSelect={command.onSelect}
        >
          {command.icon}
          <span className="min-w-0 flex-1 truncate">{command.label}</span>
        </DropdownMenuItem>
      ))}
      {props.trailingSeparator ? <DropdownMenuSeparator /> : null}
    </>
  );
}
