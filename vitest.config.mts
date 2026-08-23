import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

/**
 * Unit tests only: no microphone, no child processes, no network, no VS Code.
 *
 * `vscode` is not a real npm package, it is injected by the extension host at
 * runtime, so any src module that imports it is unresolvable under a plain
 * Node test runner. The alias below points those imports at a hand-written
 * stub that satisfies the surface the tested code touches.
 *
 * The file is .mts, not .ts, because the package is CommonJS and Vite's native
 * config loader will not accept ESM syntax from a .ts file in a CJS package.
 */
export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL("./tests/mocks/vscode.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.js"],
    coverage: {
      include: ["src/**/*.ts", "engine/lib/**/*.js"],
    },
  },
});
