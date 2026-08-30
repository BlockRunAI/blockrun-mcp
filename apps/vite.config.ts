// apps/vite.config.ts — builds ONE app per invocation into ../ui/<name>.html.
//
//   vite build --config apps/vite.config.ts --mode order-preview
//   vite build --config apps/vite.config.ts --mode wallet
//
// `--mode` picks the entry so each bundle is a self-contained single HTML
// file (vite-plugin-singlefile inlines JS + CSS). MCP hosts render the
// resource in a deny-by-default CSP sandbox, so nothing may be loaded from a
// URL — everything must be inline.
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const entry = mode === "wallet" ? "wallet" : "order-preview";
  return {
    root: here,
    plugins: [viteSingleFile()],
    build: {
      outDir: resolve(here, "..", "ui"),
      emptyOutDir: false,
      rollupOptions: { input: resolve(here, `${entry}.html`) },
      target: "es2022",
      minify: true,
    },
    logLevel: "warn",
  };
});
