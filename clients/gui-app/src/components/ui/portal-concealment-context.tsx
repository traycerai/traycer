import {
  Activity,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * True when the region that RENDERED a portal is concealed — held in a hidden
 * `<Activity>` by a boundary like `HostScopeGate` — so portal surfaces must
 * un-present along with it.
 *
 * React conceals a hidden Activity's in-tree DOM by styling its topmost host
 * nodes, but a portal nested under any host element escapes that: its DOM
 * lives outside the concealed subtree and stays fully visible and interactive
 * (measured — an open settings dialog outlived its panel's concealment).
 * Context crosses portals, so this carries the concealment over the boundary
 * the styling cannot.
 *
 * Converted overlays retain owner state while closing the primitive before
 * Activity disconnects effects. Other families consume the boolean until
 * their migration adopts the shared presentation protocol below.
 */
const PortalConcealmentContext = createContext(false);

export const PortalConcealmentProvider = PortalConcealmentContext.Provider;

export function usePortalConcealed(): boolean {
  return useContext(PortalConcealmentContext);
}

interface PortalPresentation {
  generation: number;
  register: (token: object) => () => void;
  closed: (token: object, generation: number) => void;
  isPresented: () => boolean;
  isGeneration: (generation: number) => boolean;
}
export const PortalPresentationContext =
  createContext<PortalPresentation | null>(null);

/** Publish closed roots before Activity disconnects their effects. */
export function PortalConcealmentBoundary(props: {
  concealed: boolean;
  children: ReactNode;
}): ReactNode {
  const [state, setState] = useState({
    concealed: props.concealed,
    generation: 0,
  });
  if (state.concealed !== props.concealed)
    setState({ concealed: props.concealed, generation: state.generation + 1 });
  const [closedGeneration, setClosedGeneration] = useState(-1);
  const [registry] = useState(() => new Map<object, number>());
  const probe = useRef<HTMLSpanElement>(null);
  const acknowledge = useCallback((): void => {
    const element = probe.current;
    if (element?.dataset.concealed !== "true") return;
    const generation = Number(element.dataset.generation);
    if ([...registry.values()].every((value) => value === generation))
      setClosedGeneration(generation);
  }, [registry]);
  const register = useCallback(
    (token: object) => {
      registry.set(token, -1);
      return () => {
        registry.delete(token);
        acknowledge();
      };
    },
    [registry, acknowledge],
  );
  const closed = useCallback(
    (token: object, generation: number): void => {
      registry.set(token, generation);
      acknowledge();
    },
    [registry, acknowledge],
  );
  const isPresented = useCallback(
    () =>
      probe.current?.isConnected === true &&
      probe.current.dataset.concealed === "false",
    [],
  );
  const isGeneration = useCallback(
    (generation: number) =>
      probe.current?.isConnected === true &&
      Number(probe.current.dataset.generation) === generation,
    [],
  );
  useEffect(acknowledge, [acknowledge, state.generation]);
  const hidden = props.concealed && closedGeneration === state.generation;
  return (
    <>
      <span
        ref={probe}
        hidden
        data-concealed={props.concealed}
        data-generation={state.generation}
      />
      <Activity mode={hidden ? "hidden" : "visible"}>
        <PortalPresentationContext.Provider
          value={{
            generation: state.generation,
            register,
            closed,
            isPresented,
            isGeneration,
          }}
        >
          <PortalConcealmentProvider value={props.concealed}>
            {props.children}
          </PortalConcealmentProvider>
        </PortalPresentationContext.Provider>
      </Activity>
    </>
  );
}
