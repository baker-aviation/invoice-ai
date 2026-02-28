import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["*.cloudworkstations.dev"],
  turbopack: {
    root: "..",
  },
};

export default nextConfig;
