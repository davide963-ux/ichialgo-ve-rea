/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TWELVEDATA_POLL_MS?: string;
  readonly VITE_TWELVEDATA_CREDITS_PER_MINUTE?: string;
  readonly VITE_TWELVEDATA_CREDITS_PER_DAY?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
