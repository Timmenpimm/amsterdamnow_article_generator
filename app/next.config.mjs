/** @type {import('next').NextConfig} */
const nextConfig = {
  images: { unoptimized: true },
  serverExternalPackages: ['better-sqlite3', 'pg'],
  outputFileTracingIncludes: { '/api/**': ['./seeds/**'] },
};
export default nextConfig;
