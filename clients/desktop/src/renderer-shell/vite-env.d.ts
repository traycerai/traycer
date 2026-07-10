/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TRAYCER_SIGN_IN_URL: string | undefined;
  readonly VITE_TRAYCER_OSS_REPO: string | undefined;
  readonly VITE_DEV_DESKTOP_SLOT: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
