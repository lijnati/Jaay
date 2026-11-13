import { defineConfig } from "vitest/config";

// Some protocol tests run tens of thousands of Web Crypto calls; on a loaded machine they pass 5 s.
export default defineConfig({ test: { testTimeout: 30_000 } });
