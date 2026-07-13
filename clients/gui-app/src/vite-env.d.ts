/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_VERSION: string | undefined;
  readonly VITE_DEV_DESKTOP_WORKTREE_LABEL: string | undefined;
  readonly VITE_TRAYCER_OSS_REPO: string | undefined;
  readonly VITE_POSTHOG_KEY: string | undefined;
  readonly VITE_VIRTUOSO_MESSAGE_LIST_LICENSE_KEY: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
