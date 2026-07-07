import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // there are sibling projects with their own lockfiles in the parent dir
  outputFileTracingRoot: __dirname,
  // Playwright (Joburg adapter) is a heavy Node module with its own browser
  // binaries — keep it out of the server bundle and load it at runtime.
  serverExternalPackages: ["playwright"],
};

export default nextConfig;
