import type { NextConfig } from "next";

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
      "script-src 'self' 'unsafe-inline' blob:",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://storage.googleapis.com https://*.tile.openstreetmap.org https://tilecache.rainviewer.com",
      "font-src 'self'",
      "media-src 'self' blob: https://storage.googleapis.com",
      "connect-src 'self' blob: data: https://*.supabase.co https://api.samsara.com https://storage.googleapis.com https://api.rainviewer.com",
      "frame-src 'self' https://view.officeapps.live.com https://storage.googleapis.com",
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  allowedDevOrigins: ["*.cloudworkstations.dev"],
  turbopack: {
    root: "..",
  },
  output: "standalone",
  experimental: {
    optimizePackageImports: [
      "recharts",
      "lucide-react",
      "@turf/turf",
      "leaflet",
    ],
  },
  serverExternalPackages: [
    "pdfjs-dist",
    "cheerio",
    "@anthropic-ai/sdk",
    "openai",
    "@google-cloud/storage",
    "pdf-parse",
    "ffmpeg-static",
    "fluent-ffmpeg",
  ],
  typescript: { ignoreBuildErrors: true },
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
      {
        // Cross-origin isolation for FFmpeg.wasm (SharedArrayBuffer)
        source: "/admin/super",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
        ],
      },
    ];
  },
  async redirects() {
    return [
      { source: "/alerts", destination: "/invoices?tab=alerts", permanent: true },
    ];
  },
};

export default nextConfig;
