/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MARKET_PROVIDER?: string;
  readonly VITE_TWELVEDATA_POLL_MS?: string;
  readonly VITE_TWELVEDATA_CREDITS_PER_MINUTE?: string;
  readonly VITE_TWELVEDATA_CREDITS_PER_DAY?: string;
  readonly VITE_YAHOO_POLL_MS?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
