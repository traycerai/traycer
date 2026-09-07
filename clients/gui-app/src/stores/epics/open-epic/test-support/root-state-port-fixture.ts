/**
 * The root-state port, inert, for hand-built `OpenEpicStoreHandle` fixtures. ONE source for eight
 * literals across seven files.
 */
export const INERT_ROOT_STATE_PORT = {
  encodeRootState: (): Promise<Uint8Array> => Promise.resolve(new Uint8Array()),
  applyRootUpdate: (): Promise<boolean> => Promise.resolve(false),
};
