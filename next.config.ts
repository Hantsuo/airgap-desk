import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The demo is opened as http://127.0.0.1:3000, which Next 16 treats as a
  // cross-origin dev host and blocks client chunks for. Allow it explicitly.
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  // Static export: the whole product is client-side, so Firebase Hosting's
  // free tier can serve it without Cloud Functions or billing.
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
