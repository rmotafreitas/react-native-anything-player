import sonarjs from "eslint-plugin-sonarjs";

const SONARJS_DISABLED = new Set([
  // Pure style / noise.
  "sonarjs/file-header",
  "sonarjs/arrow-function-convention",
  "sonarjs/no-duplicate-string",
  "sonarjs/shorthand-property-grouping",
  "sonarjs/no-implicit-dependencies", // pnpm-workspace/alias false-positive storm
  // Framework idioms these rules get wrong:
  "sonarjs/function-name", // React components are PascalCase by convention
  "sonarjs/no-wildcard-import", // `import * as React` / `import * as Notifications`
  "sonarjs/no-require-or-define", // Metro resolves assets via require()
  "sonarjs/no-inverted-boolean-check", // intentional `!(a > b)` NaN guards
  "sonarjs/no-reference-error", // type-only React/NodeJS references
  "sonarjs/super-linear-regex", // false positive on a linear regex
  // Metrics that duplicate cognitive-complexity (kept as an error) without
  // measuring readability: a flat validation/switch function is cheap to read
  // but scores high; union size is a style count on string-literal unions.
  "sonarjs/cyclomatic-complexity",
  "sonarjs/max-union-size",
]);

export default {
  files: ["src/**/*.{ts,tsx}"],
  ignores: ["src/**/__tests__/**", "src/**/*.test.{ts,tsx}", "src/**/*.d.ts"],
  ...sonarjs.configs.recommended,
  rules: Object.fromEntries(Object.keys(sonarjs.configs.recommended.rules).map(rule => [rule, SONARJS_DISABLED.has(rule) ? "off" : "error"])),
};
