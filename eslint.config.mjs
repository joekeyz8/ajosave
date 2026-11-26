import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const noQueryInterpolation = require("./eslint-rules/no-query-interpolation.js");

/** @type {import('eslint').Linter.Config[]} */
const config = [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // SQL injection prevention: flag interpolation inside query() calls.
    // See docs/sql-security-audit.md for the full audit findings.
    plugins: { local: { rules: { "no-query-interpolation": noQueryInterpolation } } },
    rules: {
      "local/no-query-interpolation": "error",
    },
  },
  {
    ignores: [".next/**", "node_modules/**", "contracts/**", "eslint-rules/**"],
  },
];

export default config;
