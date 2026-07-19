import type { NextRequest } from 'next/server';

export function checkToken(req: NextRequest): boolean {
  const token = process.env.N8N_TOKEN;
  if (!token) return true; // geen token geconfigureerd = open (alleen voor lokaal gebruik)
  return req.headers.get('x-api-key') === token;
}
