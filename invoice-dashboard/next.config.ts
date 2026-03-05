import type { NextConfig } from "next";
import path from "path";

const monorepoRoot = path.resolve(__dirname, "..");

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://storage.googleapis.com https://*.tile.openstreetmap.org",
      "font-src 'self'",
      "connect-src 'self' https://*.supabase.co https://api.samsara.com https://storage.googleapis.com",
      "frame-src 'self' https://view.officeapps.live.com https://storage.googleapis.com",
      "frame-ancestors 'none'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  allowedDevOrigins: ["*.cloudworkstations.dev"],
  turbopack: {
    root: "..",
  },
  outputFileTracingRoot: monorepoRoot,
  serverExternalPackages: ["pdfjs-dist"],
  webpack(config) {
    config.resolve.alias["@agents"] = path.join(monorepoRoot, "agents");
    return config;
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
