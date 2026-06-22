import type { SuggestionProps } from "@tiptap/suggestion";
import type {
  ComposerPickerItem,
  ComposerPickerKind,
  ComposerPickerStore,
} from "./composer-picker-store";

export interface ComposerSuggestionRenderArgs {
  readonly pickerStore: ComposerPickerStore;
  readonly kind: ComposerPickerKind;
}

interface SuggestionRender<TItem extends ComposerPickerItem> {
  onStart(props: SuggestionProps<unknown, TItem>): void;
  onUpdate(props: SuggestionProps<unknown, TItem>): void;
  onExit(): void;
  onKeyDown(props: { event: KeyboardEvent }): boolean;
}

export function createComposerSuggestionRender<
  TItem extends ComposerPickerItem,
>(args: ComposerSuggestionRenderArgs): () => SuggestionRender<TItem> {
  return () => {
    // Tiptap's suggestion plugin builds a fresh `props` object on every
    // view.update - including a `command` closure bound to the *current*
    // state.range. The closure captured during onStart points at the
    // range covering only the trigger char, so committing later would
    // leave the typed query in place. Track the latest props so commits
    // dispatch against the up-to-date range.
    let latestProps: SuggestionProps<unknown, TItem> | null = null;
    return {
      onStart(props) {
        latestProps = props;
        args.pickerStore.getState().openPicker({
          kind: args.kind,
          range: { from: props.range.from, to: props.range.to },
          query: props.query,
          commit: (item) => {
            if (latestProps === null) return;
            latestProps.command(item as TItem);
          },
          clientRect: props.clientRect ?? null,
        });
      },

      onUpdate(props) {
        latestProps = props;
        args.pickerStore.getState().updateRange({
          range: { from: props.range.from, to: props.range.to },
          query: props.query,
          clientRect: props.clientRect ?? null,
        });
      },

      onExit() {
        latestProps = null;
        args.pickerStore.getState().close();
      },

      onKeyDown({ event }) {
        const state = args.pickerStore.getState();
        if (!state.open) return false;

        if (event.key === "ArrowDown") {
          state.moveActive(1);
          return true;
        }
        if (event.key === "ArrowUp") {
          state.moveActive(-1);
          return true;
        }
        if (event.key === "Enter") {
          if (event.shiftKey) return false;
          if (state.items.length === 0) return false;
          return state.commitActiveItem();
        }
        if (event.key === "Tab") {
          if (state.items.length === 0) return false;
          return state.commitActiveItem();
        }
        if (event.key === "Escape") {
          state.close();
          return true;
        }
        return false;
      },
    };
  };
}
