import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against the TypeScript sources, so no build is needed first.
    alias: {
      "@atcn/schema": source("./packages/schema/src/index.ts"),
      "@atcn/usage": source("./packages/usage/src/index.ts"),
      "@atcn/core": source("./packages/core/src/index.ts"),
      "@atcn/verifiers": source("./packages/verifiers/src/index.ts"),
      "@atcn/subledger": source("./packages/subledger/src/index.ts"),
      "@atcn/sdk": source("./packages/sdk-ts/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "examples/*/test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30000,
  },
});
