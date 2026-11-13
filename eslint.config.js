import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"] },
  ...tseslint.configs.recommended,
  {
    // The protocol package must run unchanged in the browser and in Node: Web Crypto only.
    files: ["packages/protocol/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "crypto", message: "Use Web Crypto (globalThis.crypto)." },
            { name: "buffer", message: "Use Uint8Array." },
          ],
          patterns: [{ group: ["node:*"], message: "No Node-only APIs in protocol." }],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "Buffer", message: "Use Uint8Array." },
        { name: "process", message: "No Node-only APIs in protocol." },
      ],
    },
  },
);
