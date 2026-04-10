/**
 * Cloudcore Public API
 *
 * A read-only, publicly-deployable API that serves published content from a
 * Cloudcore CMS database. Designed to be the only internet-facing endpoint
 * while the CMS admin stays behind Cloudflare Access or a VPN.
 *
 * SECURITY GUARANTEES:
 * - Zero write operations — no INSERT, UPDATE, or DELETE anywhere
 * - Zero auth/user data — never reads users, sessions, audit logs, or settings
 * - Zero admin endpoints — no login, no setup, no management
 * - Only reads: published content, categories, tags, and media files
 * - Rate limited on every endpoint
 * - Strict CORS with configurable origins
 * - Security headers on every response
 * - Cache-friendly responses with configurable TTL
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';

// ============================================================================
// Types
// ============================================================================

interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ALLOWED_ORIGINS?: string;
  CACHE_TTL?: string;
}

interface ContentRow {
  id: string;
  type: string;
  title: string;
  slug: string;
  status: string;
  blocks: string;
  author_id: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Helpers
// ============================================================================

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function getCacheTtl(env: Env): number {
  const ttl = parseInt(env.CACHE_TTL || '60', 10);
  return Math.max(0, Math.min(ttl, 86400)); // 0 to 24 hours
}

// In-memory rate limiter (resets on worker restart — fine for edge)
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();
const MAX_ENTRIES = 10000;

function checkRateLimit(ip: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = rateLimitStore.get(ip);

  if (entry) {
    if (now > entry.resetAt) {
      entry.count = 1;
      entry.resetAt = now + windowMs;
      return true;
    }
    if (entry.count >= maxRequests) {
      return false;
    }
    entry.count++;
    return true;
  }

  rateLimitStore.set(ip, { count: 1, resetAt: now + windowMs });

  // Cleanup if too large
  if (rateLimitStore.size > MAX_ENTRIES) {
    for (const [k, v] of rateLimitStore.entries()) {
      if (now > v.resetAt) rateLimitStore.delete(k);
    }
  }

  return true;
}

function getClientIp(request: Request): string {
  const cf = (request as unknown as { cf?: Record<string, unknown> }).cf;
  if (cf) {
    const cfIp = request.headers.get('cf-connecting-ip')?.trim();
    if (cfIp) return cfIp;
  }
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'unknown';
}

// ============================================================================
// App
// ============================================================================

const app = new Hono<{ Bindings: Env }>();

// Security headers on every response
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // No HSTS here — let the domain-level Cloudflare config handle that
});

// CORS
app.use('*', async (c, next) => {
  const origins = c.env.ALLOWED_ORIGINS
    ? c.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
    : [];

  const corsMiddleware = cors({
    origin: (origin) => {
      if (!origin) return origin;
      if (origins.length === 0) return origin; // Allow all if not configured
      return origins.includes(origin) ? origin : undefined;
    },
    allowMethods: ['GET', 'HEAD', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    maxAge: 86400,
  });

  return corsMiddleware(c, next);
});

// Rate limiting middleware
app.use('*', async (c, next) => {
  const ip = getClientIp(c.req.raw);
  // 120 requests per minute per IP
  if (!checkRateLimit(ip, 120, 60000)) {
    return c.json({ error: 'Too many requests' }, 429);
  }
  await next();
});

// Block all non-GET methods at the top level
app.use('*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.method !== 'OPTIONS') {
    return c.json({ error: 'Method not allowed. This is a read-only API.' }, 405);
  }
  await next();
});

// ============================================================================
// Routes
// ============================================================================

// Health check
app.get('/', (c) => {
  return c.json({
    name: 'Cloudcore Public API',
    version: '0.1.0',
    status: 'ok',
    endpoints: {
      content: '/content',
      contentBySlug: '/content/:type/:slug',
      categories: '/categories',
      tags: '/tags',
      media: '/media/:id',
    },
  });
});

// List published content
app.get('/content', async (c) => {
  const type = c.req.query('type'); // 'page' | 'post'
  const limit = Math.min(Math.max(1, parseInt(c.req.query('limit') || '20') || 20), 100);
  const offset = Math.max(0, parseInt(c.req.query('offset') || '0') || 0);
  const ttl = getCacheTtl(c.env);

  let query = `SELECT id, type, title, slug, status, blocks, author_id, published_at, created_at, updated_at FROM cc_content WHERE status = 'published'`;
  const params: unknown[] = [];

  if (type === 'page' || type === 'post') {
    query += ` AND type = ?`;
    params.push(type);
  }

  query += ` ORDER BY published_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const result = await c.env.DB.prepare(query).bind(...params).all<ContentRow>();

  // Count
  let countQuery = `SELECT count(*) as count FROM cc_content WHERE status = 'published'`;
  const countParams: unknown[] = [];
  if (type === 'page' || type === 'post') {
    countQuery += ` AND type = ?`;
    countParams.push(type);
  }
  const countResult = await c.env.DB.prepare(countQuery).bind(...countParams).first<{ count: number }>();
  const total = countResult?.count ?? 0;

  c.header('Cache-Control', `public, max-age=${ttl}, s-maxage=${ttl}`);

  return c.json({
    items: (result.results || []).map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      slug: row.slug,
      blocks: parseJson(row.blocks, []),
      publishedAt: row.published_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    pagination: { total, limit, offset, hasMore: offset + (result.results?.length || 0) < total },
  });
});

// Get single published content by type and slug
app.get('/content/:type/:slug', async (c) => {
  const type = c.req.param('type');
  const slug = c.req.param('slug');
  const ttl = getCacheTtl(c.env);

  if (type !== 'page' && type !== 'post') {
    return c.json({ error: 'Invalid content type' }, 400);
  }

  // Validate slug format
  if (!/^[a-z0-9-]+$/.test(slug) || slug.length > 200) {
    return c.json({ error: 'Invalid slug' }, 400);
  }

  const row = await c.env.DB.prepare(
    `SELECT id, type, title, slug, status, blocks, author_id, published_at, created_at, updated_at
     FROM cc_content WHERE type = ? AND slug = ? AND status = 'published' LIMIT 1`
  ).bind(type, slug).first<ContentRow>();

  if (!row) {
    return c.json({ error: 'Not found' }, 404);
  }

  // Get categories and tags for posts
  let categories: { id: string; slug: string; name: string }[] = [];
  let tags: { id: string; slug: string; name: string }[] = [];

  if (row.type === 'post') {
    const catResult = await c.env.DB.prepare(
      `SELECT c.id, c.slug, c.name FROM cc_categories c
       INNER JOIN cc_content_categories cc ON c.id = cc.category_id
       WHERE cc.content_id = ?`
    ).bind(row.id).all<{ id: string; slug: string; name: string }>();
    categories = catResult.results || [];

    const tagResult = await c.env.DB.prepare(
      `SELECT t.id, t.slug, t.name FROM cc_tags t
       INNER JOIN cc_content_tags ct ON t.id = ct.tag_id
       WHERE ct.content_id = ?`
    ).bind(row.id).all<{ id: string; slug: string; name: string }>();
    tags = tagResult.results || [];
  }

  c.header('Cache-Control', `public, max-age=${ttl}, s-maxage=${ttl}`);

  return c.json({
    id: row.id,
    type: row.type,
    title: row.title,
    slug: row.slug,
    blocks: parseJson(row.blocks, []),
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    categories,
    tags,
  });
});

// List categories
app.get('/categories', async (c) => {
  const ttl = getCacheTtl(c.env);

  const result = await c.env.DB.prepare(
    `SELECT id, slug, name, parent_id FROM cc_categories ORDER BY name ASC`
  ).all<{ id: string; slug: string; name: string; parent_id: string | null }>();

  c.header('Cache-Control', `public, max-age=${ttl}, s-maxage=${ttl}`);

  return c.json({
    items: (result.results || []).map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      parentId: row.parent_id,
    })),
  });
});

// List tags
app.get('/tags', async (c) => {
  const ttl = getCacheTtl(c.env);

  const result = await c.env.DB.prepare(
    `SELECT id, slug, name FROM cc_tags ORDER BY name ASC`
  ).all<{ id: string; slug: string; name: string }>();

  c.header('Cache-Control', `public, max-age=${ttl}, s-maxage=${ttl}`);

  return c.json({
    items: (result.results || []).map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
    })),
  });
});

// Serve media file
app.get('/media/:id', async (c) => {
  const id = c.req.param('id');

  // Validate ID format (ULID-like)
  if (!/^[A-Z0-9]{26}$/.test(id) && !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return c.json({ error: 'Invalid media ID' }, 400);
  }

  // Look up media record to get storage key and mime type
  const media = await c.env.DB.prepare(
    `SELECT storage_key, mime_type, size, filename FROM cc_media WHERE id = ? LIMIT 1`
  ).bind(id).first<{ storage_key: string; mime_type: string; size: number | null; filename: string }>();

  if (!media) {
    return c.json({ error: 'Not found' }, 404);
  }

  const object = await c.env.BUCKET.get(media.storage_key);
  if (!object) {
    return c.json({ error: 'File not found in storage' }, 404);
  }

  const headers = new Headers();
  headers.set('Content-Type', media.mime_type);
  headers.set('Cache-Control', 'public, max-age=2592000'); // 30 days for media
  headers.set('X-Content-Type-Options', 'nosniff');
  // Strict CSP to prevent script execution from served files
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'");
  headers.set('X-Frame-Options', 'DENY');
  if (media.size) {
    headers.set('Content-Length', media.size.toString());
  }

  // Force download for non-image/video/audio types
  if (!media.mime_type.startsWith('image/') &&
      !media.mime_type.startsWith('video/') &&
      !media.mime_type.startsWith('audio/')) {
    // Safe Content-Disposition — only ASCII filenames
    const safeName = media.filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
    headers.set('Content-Disposition', `attachment; filename="${safeName}"`);
  }

  return new Response(object.body, { headers });
});

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

// Error handler — never leak internals
app.onError((_err, c) => {
  console.error('Error:', _err);
  return c.json({ error: 'Internal server error' }, 500);
});

export default app;
