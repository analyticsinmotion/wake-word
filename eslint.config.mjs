// ESLint flat config. Replaces .eslintrc.json (ESLint 8) with the same
// effective rule set: eslint:recommended, plugin:@typescript-eslint/recommended,
// and no-explicit-any downgraded to a warning.
//
// The file is .mjs, not .js, because the package is CommonJS and the config
// uses ESM imports, for the same reason vitest.config.mts is .mts.
import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  {
    // dist and node_modules were the eslintrc ignorePatterns. engine/ and
    // tests/ were never linted either: the lint script only ever passed src.
    ignores: ["dist/**", "node_modules/**", "engine/**", "tests/**"],
  },
  js.configs.recommended,
  ...tseslint.configs["flat/recommended"],
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",

      // ESLint 9 changed eslint:recommended. The pins below hold the ESLint 8
      // behaviour this project was linted with, verified by diffing
      // --print-config before and after the migration. Drop any of them as a
      // deliberate change, not as part of an upgrade.

      // Added to recommended in ESLint 9; were not on before.
      "no-constant-binary-expression": "off",
      "no-empty-static-block": "off",
      "no-unused-private-class-members": "off",

      // Removed from recommended in ESLint 9; were on before. The two
      // formatting rules are deprecated upstream but still work. ESLint 9 also
      // gave no-inner-declarations a blockScopedFunctions option whose default
      // stops reporting block-level functions; "disallow" is what ESLint 8 did.
      "no-extra-semi": "error",
      "no-inner-declarations": ["error", "functions", { blockScopedFunctions: "disallow" }],
      "no-mixed-spaces-and-tabs": "error",

      // Default changed from checking every loop to allowing `while (true)`.
      "no-constant-condition": ["error", { checkLoops: "all" }],
    },
  },
];
