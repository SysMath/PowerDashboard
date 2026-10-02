import { defineConfig } from "vitest/config";

// Le noyau de l'application est du TypeScript pur : il se teste sous Node,
// sans React Native. Les écrans, eux, ne passent pas par Vitest.
export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "modules/**/*.test.ts",
      "plugins/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    environment: "node",
  },
});
