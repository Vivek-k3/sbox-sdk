import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import next from "ultracite/oxlint/next";
import react from "ultracite/oxlint/react";

export default defineConfig({
  extends: [core, react, next],
  ignorePatterns: [
    "apps/web/components/ui",
    "apps/web/lib/utils.ts",
    "apps/web/hooks/use-mobile.ts",
    "packages/files-sdk/CHANGELOG.md",
    // Svelte test fixtures — oxlint has no Svelte parser, so `.svelte` source
    // trips JS-only rules (`export let` props, etc.).
    "packages/files-sdk/test/fixtures",
    "packages/sbox-sdk/src/aws-lambda/runner/server.mjs",
  ],
  overrides: [
    {
      files: ["packages/sbox-sdk/**/*.ts"],
      rules: {
        "class-methods-use-this": "off",
        complexity: "off",
        curly: "off",
        "default-case": "off",
        "func-style": ["error", "declaration", { allowArrowFunctions: true }],
        "max-classes-per-file": "off",
        "no-empty-function": "off",
        "no-inline-comments": "off",
        "no-nested-ternary": "off",
        "no-plusplus": "off",
        "no-promise-executor-return": "off",
        "no-shadow": "off",
        "no-use-before-define": "off",
        "prefer-destructuring": "off",
        "promise/avoid-new": "off",
        "promise/param-names": "off",
        "promise/prefer-await-to-callbacks": "off",
        "promise/prefer-await-to-then": "off",
        "require-await": "off",
        "require-unicode-regexp": "off",
        "sort-keys": "off",
        "typescript/array-type": "off",
        "typescript/class-literal-property-style": "off",
        "typescript/consistent-type-imports": "off",
        "typescript/no-explicit-any": "off",
        "typescript/no-non-null-assertion": "off",
        "typescript/no-this-alias": "off",
        "typescript/prefer-for-of": "off",
        "unicorn/catch-error-name": "off",
        "unicorn/consistent-function-scoping": "off",
        "unicorn/no-await-expression-member": "off",
        "unicorn/no-nested-ternary": "off",
        "unicorn/no-thenable": "off",
        "unicorn/no-this-assignment": "off",
        "unicorn/no-useless-collection-argument": "off",
        "unicorn/no-useless-error-capture-stack-trace": "off",
        "unicorn/no-useless-spread": "off",
        "unicorn/no-useless-undefined": "off",
        "unicorn/prefer-response-static-json": "off",
        "unicorn/prefer-string-replace-all": "off",
        "unicorn/switch-case-braces": "off",
      },
    },
  ],
});
