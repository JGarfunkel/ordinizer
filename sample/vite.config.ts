import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const contextPath = env.ORDINIZER_CONTEXT_PATH || "/ordinizer";
  return {
    base: contextPath + "/",
    plugins: [react()],
    define: {
      __ORDINIZER_CONTEXT_PATH__: JSON.stringify(contextPath),
    },
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "client", "src"),
        "@assets": path.resolve(import.meta.dirname, "attached_assets"),
        react: path.resolve(import.meta.dirname, "node_modules/react"),
        "react-dom": path.resolve(import.meta.dirname, "node_modules/react-dom"),
        "@tanstack/react-query": path.resolve(
          import.meta.dirname,
          "node_modules/@tanstack/react-query",
        ),
      },
      dedupe: ["react", "react-dom", "@tanstack/react-query"],
      preserveSymlinks: true,
    },
    root: path.resolve(import.meta.dirname, "client"),
    build: {
      outDir: path.resolve(import.meta.dirname, "dist/public"),
      emptyOutDir: true,
      rollupOptions: {
        output: {
          manualChunks: undefined,
        },
      },
      chunkSizeWarningLimit: 1000,
    },
    server: {
      fs: {
        strict: false,
        allow: [
          path.resolve(import.meta.dirname),
          path.resolve(import.meta.dirname, "node_modules/@civillyengaged/ordinizer-client/"),
          path.resolve(import.meta.dirname, "../ordinizer"),
        ],
      },
    },
  };
});
