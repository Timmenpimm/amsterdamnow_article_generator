/** @type {import('next').NextConfig} */
const nextConfig = {
  images: { unoptimized: true },
  serverExternalPackages: ['better-sqlite3', 'pg'],
  // De app wordt lokaal vanuit app/ gestart, maar de legacy Vercel-builder
  // traceert vanuit de repository-root. Neem beide geldige locaties mee in
  // de serverless bundle; de niet-bestaande variant wordt genegeerd.
  outputFileTracingIncludes: { '/api/**': ['./seeds/**', './app/seeds/**'] },
};
export default nextConfig;
