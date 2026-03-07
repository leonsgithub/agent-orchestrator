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
    return config;
  },
};

export default nextConfig;
