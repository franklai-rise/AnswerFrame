import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  const extensionBuild = mode === "extension";
  return {
    // Extension resources must be resolved relative to library.html rather
    // than to the hosting origin used by the standalone development app.
    base: extensionBuild ? "./" : "/",
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
    },
    build: {
      target: "es2022",
      ...(extensionBuild ? {
        outDir: resolve(webRoot, "../extension/dist"),
        emptyOutDir: false,
        rollupOptions: { input: resolve(webRoot, "library.html") },
      } : {}),
    },
  };
});
