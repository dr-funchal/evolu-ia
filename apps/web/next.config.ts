import type { NextConfig } from "next";

// CSP estrita o suficiente para o piloto: nada de terceiros, sem frames, sem objetos.
// 'unsafe-inline' em script é exigido pelo bootstrap do App Router sem nonce (limitação registrada no ADR 0003).
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self' https://auth.pulpfy.com",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
  transpilePackages: ["@evolu/api", "@evolu/authorization", "@evolu/config", "@evolu/contracts", "@evolu/database", "@evolu/domain"],
  serverExternalPackages: ["postgres", "pino", "openid-client"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

export default config;
