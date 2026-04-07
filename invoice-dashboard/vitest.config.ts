import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@agents": path.resolve(__dirname, "../agents"),
      // Stub out server-only so tests can import server modules
      "server-only": path.resolve(__dirname, "./src/lib/__tests__/stubs/server-only.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
