/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@composio/ao-core"],
  webpack: (config, { isServer }) => {
    if (isServer) {
      // @composio/core (Composio SDK) is an optional peer dependency of
      // tracker-linear, dynamically imported only when COMPOSIO_API_KEY is set.
      // Mark it external so webpack doesn't try to resolve it at build time.
      config.externals.push("@composio/core");
    }

    // plugin-registry.ts uses a variable-string dynamic import() to load plugins
    // at runtime. The /* webpackIgnore: true */ magic comment guards the source,
    // but SWC (used by transpilePackages) can strip magic comments before webpack
    // sees them. Suppress the resulting "Critical dependency" warning explicitly.
    config.ignoreWarnings = [
      ...(config.ignoreWarnings ?? []),
      { module: /plugin-registry/ },
    ];

    return config;
  },
};

export default nextConfig;
