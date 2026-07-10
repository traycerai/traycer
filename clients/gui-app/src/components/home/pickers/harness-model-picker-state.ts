import type { ProviderId } from "@/components/home/data/landing-options";
import { useCallback, useEffect, useReducer } from "react";

interface HarnessModelPickerState {
  readonly open: boolean;
  readonly query: string;
  readonly activeProviderId: ProviderId;
  /** Browsed rail entry's profile within `activeProviderId` - `null` for a
   *  single/no-profile harness or the ambient entry of a split one. */
  readonly activeProfileId: string | null;
  readonly activeRowId: string;
  readonly hoveredRowId: string;
  readonly openVersion: number;
}

type HarnessModelPickerStateAction =
  | {
      readonly type: "setOpen";
      readonly open: boolean;
      readonly selectedProviderId: ProviderId;
      readonly selectedProfileId: string | null;
    }
  | { readonly type: "closeOnly" }
  | { readonly type: "closeForDisabled" }
  | { readonly type: "setQuery"; readonly query: string }
  | {
      readonly type: "setActiveRailEntry";
      readonly providerId: ProviderId;
      readonly profileId: string | null;
    }
  | { readonly type: "setActiveRowId"; readonly rowId: string }
  | { readonly type: "setHoveredRowId"; readonly rowId: string };

interface HarnessModelPickerStateController extends HarnessModelPickerState {
  readonly visibleOpen: boolean;
  readonly handleOpenChange: (next: boolean) => void;
  readonly handleQueryChange: (next: string) => void;
  readonly setActiveRailEntry: (
    providerId: ProviderId,
    profileId: string | null,
  ) => void;
  readonly setActiveRowId: (rowId: string) => void;
  readonly setHoveredRowId: (rowId: string) => void;
  readonly closeOnly: () => void;
}

export function useHarnessModelPickerState(
  selectedProviderId: ProviderId,
  selectedProfileId: string | null,
  disabled: boolean,
): HarnessModelPickerStateController {
  const [state, dispatch] = useReducer(
    harnessModelPickerStateReducer,
    { selectedProviderId, selectedProfileId },
    initialHarnessModelPickerState,
  );

  useEffect(() => {
    if (disabled && state.open) {
      dispatch({ type: "closeForDisabled" });
    }
  }, [disabled, state.open]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (disabled) {
        dispatch({ type: "closeForDisabled" });
        return;
      }
      dispatch({
        type: "setOpen",
        open: next,
        selectedProviderId,
        selectedProfileId,
      });
    },
    [disabled, selectedProviderId, selectedProfileId],
  );
  const handleQueryChange = useCallback((next: string) => {
    dispatch({ type: "setQuery", query: next });
  }, []);
  const setActiveRailEntry = useCallback(
    (providerId: ProviderId, profileId: string | null) => {
      dispatch({ type: "setActiveRailEntry", providerId, profileId });
    },
    [],
  );
  const setActiveRowId = useCallback((rowId: string) => {
    dispatch({ type: "setActiveRowId", rowId });
  }, []);
  const setHoveredRowId = useCallback((rowId: string) => {
    dispatch({ type: "setHoveredRowId", rowId });
  }, []);
  const closeOnly = useCallback(() => {
    dispatch({ type: "closeOnly" });
  }, []);

  return {
    ...state,
    visibleOpen: state.open && !disabled,
    handleOpenChange,
    handleQueryChange,
    setActiveRailEntry,
    setActiveRowId,
    setHoveredRowId,
    closeOnly,
  };
}

function initialHarnessModelPickerState(seed: {
  selectedProviderId: ProviderId;
  selectedProfileId: string | null;
}): HarnessModelPickerState {
  return {
    open: false,
    query: "",
    activeProviderId: seed.selectedProviderId,
    activeProfileId: seed.selectedProfileId,
    activeRowId: "",
    hoveredRowId: "",
    openVersion: 0,
  };
}

function harnessModelPickerStateReducer(
  state: HarnessModelPickerState,
  action: HarnessModelPickerStateAction,
): HarnessModelPickerState {
  switch (action.type) {
    case "setOpen":
      if (action.open) {
        return {
          ...state,
          open: true,
          openVersion: state.openVersion + 1,
          query: "",
          activeProviderId: action.selectedProviderId,
          activeProfileId: action.selectedProfileId,
          hoveredRowId: "",
          activeRowId: "",
        };
      }
      return {
        ...state,
        open: false,
        hoveredRowId: "",
        activeRowId: "",
      };
    case "closeOnly":
      return { ...state, open: false };
    case "closeForDisabled":
      return {
        ...state,
        open: false,
        hoveredRowId: "",
        activeRowId: "",
      };
    case "setQuery":
      return {
        ...state,
        query: action.query,
        activeRowId: "",
      };
    case "setActiveRailEntry":
      return {
        ...state,
        activeProviderId: action.providerId,
        activeProfileId: action.profileId,
      };
    case "setActiveRowId":
      return { ...state, activeRowId: action.rowId };
    case "setHoveredRowId":
      return { ...state, hoveredRowId: action.rowId };
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
