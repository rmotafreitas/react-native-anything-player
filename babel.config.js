// bob adds `.js` to the relative static imports of its ESM build (strict ESM
// resolvers need the extension); this does the same for `import()`, which
// loads the web's optional parts (the Cast driver, the MP4 muxer). Only in
// bob's build: Jest and Metro read the sources, where there is no `.js` file.
function dynamicImportExtensions(api) {
  const esm = api.caller((caller) => caller?.rewriteImportExtensions === true);
  return {
    name: 'rnap-dynamic-import-extensions',
    visitor: {
      CallExpression(path) {
        if (!esm || path.node.callee.type !== 'Import') return;
        const [specifier] = path.node.arguments;
        if (
          specifier?.type === 'StringLiteral' &&
          specifier.value.startsWith('.') &&
          !/\.[cm]?js$/.test(specifier.value)
        )
          specifier.value += '.js';
      },
    },
  };
}

module.exports = {
  overrides: [
    {
      exclude: /\/node_modules\//,
      presets: ['module:react-native-builder-bob/babel-preset'],
      plugins: [dynamicImportExtensions],
    },
    {
      include: /\/node_modules\//,
      presets: [
        [
          'module:@react-native/babel-preset',
          { enableBabelRuntime: '^7.29.7' },
        ],
      ],
    },
  ],
};
