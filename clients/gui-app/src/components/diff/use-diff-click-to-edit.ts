import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Editor, EditorOptions } from "@pierre/diffs/edit";
import type { FileDiffProps, FileOptions } from "@pierre/diffs/react";
import {
  focusRegisteredDiffEditor,
  isDiffEditActivationGesture,
  registerDiffEditor,
  resolveLineCaretCharacter,
  resolveTokenCaretCharacter,
  type DiffEditCaret,
} from "@/components/diff/diff-click-to-edit";
import { preloadDiffEditProvider } from "@/components/diff/diff-edit-provider-loader";

type DiffInteractionOptions = NonNullable<FileDiffProps<undefined>["options"]>;

/**
 * Opportunistic preloads (hover, pointerdown) are fire-and-forget - nothing
 * awaits them, so a rejected dynamic import must not surface as an unhandled
 * rejection. The activation path preloads separately via `preloadDiffEditProvider`
 * directly, awaited through `editorReady`, and reports failures via
 * `onActivationError`; this helper is only for the passive warm-up calls.
 */
function preloadDiffEditProviderSilently(): void {
  void preloadDiffEditProvider().catch(() => undefined);
}

export interface DiffEditActivationRequest {
  readonly caret: DiffEditCaret;
  readonly isCurrent: () => boolean;
  readonly editorReady: Promise<void>;
}

export type DiffEditActivationResult =
  | { readonly kind: "activated" }
  | { readonly kind: "focus-owner"; readonly ownerSurfaceId: string }
  | { readonly kind: "rejected" };

/** Caret an empty-origin activation (no clickable line exists) starts at. */
const EMPTY_ORIGIN_CARET: DiffEditCaret = { lineNumber: 1, character: 0 };

export interface DiffClickToEditAdapter {
  readonly fileOptions: Pick<
    FileOptions<undefined>,
    | "enableTokenInteractionsOnWhitespace"
    | "onLineClick"
    | "onLineEnter"
    | "onTokenClick"
    | "onTokenEnter"
  >;
  readonly diffOptions: Pick<
    DiffInteractionOptions,
    | "enableTokenInteractionsOnWhitespace"
    | "onLineClick"
    | "onLineEnter"
    | "onTokenClick"
    | "onTokenEnter"
  >;
  readonly editorOptions: EditorOptions<undefined>;
  readonly onKeyDownCapture: (event: KeyboardEvent<HTMLElement>) => void;
  readonly onPointerDownCapture: (
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  readonly cancelPendingActivation: () => void;
  /** Activates at `{lineNumber: 1, character: 0}` with no click-target required - a surface (e.g. an empty file) with no rendered line/token to click routes through this instead. */
  readonly activateEmptyOrigin: () => void;
  /** True once `editorOptions.onAttach` has actually fired for the live session - distinct from `active`, which flips as soon as ownership is claimed, before the real editable surface exists. */
  readonly attached: boolean;
}

export function useDiffClickToEdit(props: {
  readonly surfaceId: string;
  readonly enabled: boolean;
  readonly active: boolean;
  readonly onActivate: (
    request: DiffEditActivationRequest,
  ) => Promise<DiffEditActivationResult>;
  readonly onActivationError: (error: unknown) => void;
  readonly onChange: (content: string) => void;
  readonly onBlur: () => void;
  readonly onSaveShortcut: () => void;
}): DiffClickToEditAdapter {
  const propsRef = useRef(props);
  useLayoutEffect(() => {
    propsRef.current = props;
  }, [props]);
  const generationRef = useRef(0);
  const pendingCaretRef = useRef<{
    readonly generation: number;
    readonly caret: DiffEditCaret;
  } | null>(null);
  const seenTokenEventsRef = useRef<WeakSet<Event> | null>(null);
  if (seenTokenEventsRef.current === null) {
    seenTokenEventsRef.current = new WeakSet<Event>();
  }
  const unregisterEditorRef = useRef<(() => void) | null>(null);
  const attachedEditorRef = useRef<Editor<undefined> | null>(null);
  const [attached, setAttached] = useState(false);
  // Render-phase reset (React's documented "storing information from
  // previous renders" pattern - not an effect body, avoiding the
  // `react-hooks/set-state-in-effect` cascading-render concern, and not a
  // ref, since a ref's `.current` can't be read during render either): the
  // moment `active` goes false, `attached` must reflect it immediately,
  // since a fresh activation cycle can start again before any effect would
  // otherwise run.
  const [wasActive, setWasActive] = useState(props.active);
  if (wasActive !== props.active) {
    setWasActive(props.active);
    if (!props.active && attached) setAttached(false);
  }

  const cancelPendingActivation = useCallback((): void => {
    generationRef.current += 1;
    pendingCaretRef.current = null;
  }, []);
  const preloadIfEnabled = useCallback((): void => {
    if (propsRef.current.enabled) preloadDiffEditProviderSilently();
  }, []);

  // Shared activation core: every activation path (a real line/token click,
  // and `activateEmptyOrigin` for a file with no clickable lines at all)
  // funnels through here, so there is exactly one place that starts an edit
  // session - no separate save/session state for the empty-file case.
  const activateWithCaret = useCallback((caret: DiffEditCaret): void => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    pendingCaretRef.current = { generation, caret };
    const request: DiffEditActivationRequest = {
      caret,
      isCurrent: () => generationRef.current === generation,
      editorReady: preloadDiffEditProvider(),
    };
    void propsRef.current
      .onActivate(request)
      .then((result) => {
        if (!request.isCurrent() || result.kind !== "focus-owner") return;
        focusRegisteredDiffEditor(result.ownerSurfaceId, caret);
      })
      .catch((error: unknown) => {
        if (request.isCurrent()) propsRef.current.onActivationError(error);
      });
  }, []);

  const activate = useCallback(
    (event: MouseEvent | PointerEvent, caret: DiffEditCaret): void => {
      if (!propsRef.current.enabled || !isDiffEditActivationGesture(event)) {
        return;
      }
      activateWithCaret(caret);
    },
    [activateWithCaret],
  );

  // Entry point for a surface with no clickable line/token at all (an empty
  // file renders zero lines - see `splitFileContents` - so `onLineClick`/
  // `onTokenClick` can never fire). Any caller-side gesture filtering
  // (button/modifier checks for a pointer event, key checks for a keyboard
  // event) happens in the caller, since there both mouse and keyboard
  // gestures may reach this same one entry point.
  const activateEmptyOrigin = useCallback((): void => {
    if (!propsRef.current.enabled) return;
    activateWithCaret(EMPTY_ORIGIN_CARET);
  }, [activateWithCaret]);

  const fileOptions = useMemo<DiffClickToEditAdapter["fileOptions"]>(() => {
    if (!props.enabled) return {};
    return {
      enableTokenInteractionsOnWhitespace: true,
      onLineEnter: preloadIfEnabled,
      onTokenEnter: preloadIfEnabled,
      onTokenClick: (token, event) => {
        seenTokenEventsRef.current?.add(event);
        activate(event, {
          lineNumber: token.lineNumber,
          character: resolveTokenCaretCharacter({
            clientX: event.clientX,
            lineCharEnd: token.lineCharEnd,
            lineCharStart: token.lineCharStart,
            tokenElement: token.tokenElement,
          }),
        });
      },
      onLineClick: (event) => {
        if (
          seenTokenEventsRef.current?.has(event.event) === true ||
          event.numberColumn
        ) {
          return;
        }
        activate(event.event, {
          lineNumber: event.lineNumber,
          character: resolveLineCaretCharacter({
            clientX: event.event.clientX,
            lineElement: event.lineElement,
          }),
        });
      },
    };
  }, [activate, preloadIfEnabled, props.enabled]);

  const diffOptions = useMemo<DiffClickToEditAdapter["diffOptions"]>(() => {
    if (!props.enabled) return {};
    return {
      enableTokenInteractionsOnWhitespace: true,
      onLineEnter: (event) => {
        if (event.annotationSide === "additions") preloadIfEnabled();
      },
      onTokenEnter: (token) => {
        if (token.side === "additions") preloadIfEnabled();
      },
      onTokenClick: (token, event) => {
        seenTokenEventsRef.current?.add(event);
        if (token.side !== "additions") return;
        activate(event, {
          lineNumber: token.lineNumber,
          character: resolveTokenCaretCharacter({
            clientX: event.clientX,
            lineCharEnd: token.lineCharEnd,
            lineCharStart: token.lineCharStart,
            tokenElement: token.tokenElement,
          }),
        });
      },
      onLineClick: (event) => {
        if (
          seenTokenEventsRef.current?.has(event.event) === true ||
          event.numberColumn ||
          event.annotationSide !== "additions"
        ) {
          return;
        }
        activate(event.event, {
          lineNumber: event.lineNumber,
          character: resolveLineCaretCharacter({
            clientX: event.event.clientX,
            lineElement: event.lineElement,
          }),
        });
      },
    };
  }, [activate, preloadIfEnabled, props.enabled]);

  const editorOptions = useMemo<EditorOptions<undefined>>(
    () => ({
      persistState: true,
      onAttach: (editor) => {
        unregisterEditorRef.current?.();
        attachedEditorRef.current = editor;
        unregisterEditorRef.current = registerDiffEditor(
          props.surfaceId,
          editor,
        );
        setAttached(true);
        queueMicrotask(() => {
          if (attachedEditorRef.current !== editor) return;
          // A superseded/hidden surface can finish attaching after ownership
          // has already moved. It must never steal focus (or scroll its kept-
          // alive canvas) on that late completion.
          if (!propsRef.current.active) return;
          const pending = pendingCaretRef.current;
          if (
            pending !== null &&
            pending.generation === generationRef.current
          ) {
            editor.focus({
              lineNumber: pending.caret.lineNumber,
              character: pending.caret.character,
              preventScroll: true,
            });
            return;
          }
          editor.focus({ lineNumber: "first-visible", preventScroll: true });
        });
      },
      onChange: (changedFile) => {
        propsRef.current.onChange(changedFile.contents);
      },
      onBlur: () => {
        propsRef.current.onBlur();
      },
    }),
    [props.surfaceId],
  );

  useEffect(() => {
    if (!props.active) {
      unregisterEditorRef.current?.();
      unregisterEditorRef.current = null;
      attachedEditorRef.current = null;
    }
  }, [props.active]);

  useEffect(() => {
    return () => {
      cancelPendingActivation();
      unregisterEditorRef.current?.();
      unregisterEditorRef.current = null;
      attachedEditorRef.current = null;
    };
  }, [cancelPendingActivation, props.surfaceId]);

  const onKeyDownCapture = useCallback(
    (event: KeyboardEvent<HTMLElement>): void => {
      if (
        propsRef.current.active &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "s"
      ) {
        event.preventDefault();
        event.stopPropagation();
        propsRef.current.onSaveShortcut();
      }
    },
    [],
  );
  const onPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>): void => {
      if (
        propsRef.current.enabled &&
        event.button === 0 &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        preloadDiffEditProviderSilently();
      }
    },
    [],
  );

  return {
    fileOptions,
    diffOptions,
    editorOptions,
    onKeyDownCapture,
    onPointerDownCapture,
    cancelPendingActivation,
    activateEmptyOrigin,
    attached,
  };
}
