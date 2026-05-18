import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.DATA_ROOT =
  process.env.DATA_ROOT || path.resolve(__dirname, "../../../nyseeds/data");

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration.test.ts"],
  },
  resolve: {
    alias: [
      {
        find: "@civillyengaged/ordinizer-core",
        replacement: path.resolve(__dirname, "../../packages/core/src"),
      },
      {
        find: "@civillyengaged/ordinizer-servercore",
        replacement: path.resolve(__dirname, "../../packages/servercore/src"),
      },
    ],
  },
});
