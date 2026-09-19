import type { WebpackOverrideFn } from "@remotion/bundler";

/**
 * Teaches the Remotion bundle (webpack) the NodeNext-style `.js` → `.ts(x)`
 * mapping that the repo's TypeScript programs already use, so video files can
 * import each other — and the package — with explicit `.js` extensions.
 */
export const allowJsExtensionMapping: WebpackOverrideFn = (config) => ({
  ...config,
  resolve: {
    ...config.resolve,
    extensionAlias: {
      ...(config.resolve?.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    },
  },
});
