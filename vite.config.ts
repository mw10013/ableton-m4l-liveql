import { defineConfig } from "vite-plus";

const anyTypedRules = [
  "no-unsafe-argument",
  "no-unsafe-assignment",
  "no-unsafe-call",
  "no-unsafe-member-access",
  "no-unsafe-return",
  "restrict-plus-operands",
  "restrict-template-expressions",
].map((rule) => `@typescript-eslint/${rule}`);

export default defineConfig({
  fmt: {
    printWidth: 80,
    ignorePatterns: ["docs/**", "refs/**", "dist/**"],
  },
  lint: {
    plugins: ["eslint", "typescript", "unicorn", "oxc"],
    categories: {
      correctness: "error",
      suspicious: "error",
      pedantic: "error",
      perf: "error",
      style: "error",
    },
    env: {
      builtin: true,
      node: true,
    },
    ignorePatterns: ["dist/", "docs/", "refs/"],
    rules: {
      // Options on enabled rules, and opt-ins beyond the categories.
      "no-underscore-dangle": [
        "error",
        {
          allow: ["_tag"],
        },
      ],
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          minimumDescriptionLength: 10,
        },
      ],
      "@typescript-eslint/restrict-plus-operands": [
        "error",
        {
          allowAny: false,
          allowBoolean: false,
          allowNullish: false,
          allowNumberAndString: false,
          allowRegExp: false,
        },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        {
          allowAny: false,
          allowBoolean: false,
          allowNever: false,
          allowNullish: false,
          allowNumber: false,
          allowRegExp: false,
        },
      ],
      "@typescript-eslint/return-await": [
        "error",
        "error-handling-correctness-only",
      ],
      "no-empty": "error",
      "no-empty-function": "error",
      "no-regex-spaces": "error",
      "no-unused-expressions": "error",
      "@typescript-eslint/no-dynamic-delete": "error",
      "@typescript-eslint/no-empty-object-type": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-invalid-void-type": "error",
      "@typescript-eslint/no-namespace": "error",
      "@typescript-eslint/no-non-null-asserted-nullish-coalescing": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/non-nullable-type-assertion-style": "error",
      "@typescript-eslint/prefer-literal-enum-member": "error",
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "error",

      // Off: misreads Effect (pipeable data-last calls, `Effect.gen` and `Effect.fn` bodies,
      // capitalized constructors such as `Schema.Struct`, `Effect.succeed(undefined)`).
      "unicorn/no-array-method-this-argument": "off",
      "unicorn/no-array-callback-reference": "off",
      "unicorn/consistent-function-scoping": "off",
      "unicorn/max-nested-calls": "off",
      "unicorn/no-useless-undefined": "off",
      "unicorn/catch-error-name": "off",
      "@typescript-eslint/consistent-return": "off",
      "@typescript-eslint/strict-void-return": "off",
      "new-cap": "off",
      "func-names": "off",
      "func-style": "off",
      "require-await": "off",

      // Off: contradicts house style.
      "no-ternary": "off",
      "no-nested-ternary": "off",
      "unicorn/no-nested-ternary": "off",
      "unicorn/no-null": "off",
      "unicorn/throw-new-error": "off",
      "unicorn/no-await-expression-member": "off",
      "unicorn/prefer-global-this": "off",
      "unicorn/text-encoding-identifier-case": "off",
      "unicorn/filename-case": "off",
      "@typescript-eslint/strict-boolean-expressions": "off",
      "@typescript-eslint/no-unsafe-type-assertion": "off",
      "typescript/prefer-readonly-parameter-types": "off",
      "sort-keys": "off",
      "no-magic-numbers": "off",
      "no-negated-condition": "off",
      "no-continue": "off",
      "no-shadow": "off",
      "no-inline-comments": "off",
      "no-implicit-coercion": "off",
      "capitalized-comments": "off",
      "arrow-body-style": "off",
      "prefer-destructuring": "off",
      "init-declarations": "off",
      "one-var": "off",
      "id-length": "off",
      "max-params": "off",
      "max-lines": "off",
      "max-lines-per-function": "off",
      "max-classes-per-file": "off",
      "max-statements": "off",
      "no-await-in-loop": "off",
      "oxc/no-map-spread": "off",

      // Off: the formatter owns it.
      "sort-imports": "off",
      "no-duplicate-imports": "off",
      curly: "off",
      "unicorn/number-literal-case": "off",
    },
    overrides: [
      {
        // Untyped JavaScript: parameters are `any` and `require` yields `error` types, so these
        // rules flag every use rather than a real mistake.
        files: ["**/*.js"],
        rules: Object.fromEntries(
          anyTypedRules.map((rule) => [rule, "off" as const]),
        ),
      },
      {
        // `node:test` registers a test by calling `test(...)`; its promise is not awaited.
        files: ["test/**"],
        rules: {
          "@typescript-eslint/no-floating-promises": "off",
        },
      },
      {
        // Max's `v8` object, not Node. Max binds the bare `inlets`/`outlets` globals and calls
        // each top-level function not marked `.local = 1` as the handler of the message it names.
        files: ["liveql-m4l.js"],
        env: {
          node: false,
        },
        globals: {
          LiveAPI: "readonly",
          outlet: "readonly",
          inlets: "writable",
          outlets: "writable",
        },
        rules: {
          "no-unused-vars": [
            "error",
            {
              argsIgnorePattern: "^_",
              varsIgnorePattern: "^_|^(get|set|call)$",
            },
          ],
        },
      },
    ],
    options: {
      typeAware: true,
      typeCheck: true,
      reportUnusedDisableDirectives: "error",
    },
  },
});
