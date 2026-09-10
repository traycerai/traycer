import { create } from "zustand";

interface ScreencastArmedState {
  readonly ownerId: string | null;
  /**
   * Tells the armed tile's page that every key it still believes is held is
   * up, published by the owner because the app keybinding registry has no
   * other way to reach it.
   *
   * Needed the moment an app action can fire while a tile is armed: the tile
   * forwards a bare modifier keydown to the page as soon as it is pressed, and
   * an action that takes focus out of the tile's IME input (the palette, a new
   * terminal, closing the epic) means the matching keyup never arrives there.
   * The page would go on believing Cmd is down for the rest of its life. This
   * is the same release the controller already performs for its own chords
   * (`mod+l` / `mod+t` / `mod+w`), reached from the one place that owns the
   * others.
   *
   * `null` only between a claim and the owner publishing one, which does not
   * happen: `claim` takes it.
   */
  readonly releasePageKeys: (() => void) | null;
  readonly claim: (ownerId: string, releasePageKeys: () => void) => void;
  readonly release: (ownerId: string) => void;
}

export const useScreencastArmedStore = create<ScreencastArmedState>((set) => ({
  ownerId: null,
  releasePageKeys: null,
  claim: (ownerId, releasePageKeys) => set({ ownerId, releasePageKeys }),
  release: (ownerId) =>
    set((state) =>
      state.ownerId === ownerId
        ? { ownerId: null, releasePageKeys: null }
        : state,
    ),
}));
