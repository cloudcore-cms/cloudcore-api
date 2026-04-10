# Cloudcore Public API

![CI](https://github.com/cloudcore-cms/cloudcore-api/actions/workflows/ci.yml/badge.svg)

A read-only, publicly-deployable API for serving published content from a Cloudcore CMS database. Deploy on `api.yourdomain.com` while keeping the CMS admin locked behind Cloudflare Access.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudcore-cms/cloudcore-api)

## Why?

The CMS admin has authentication, user management, media uploads, and write operations — it's a rich attack surface. By splitting the public-facing read API into a separate worker, you can:

- **Lock down the CMS** behind Cloudflare Access (zero trust) or a VPN
- **Expose only reads** — this API has zero write operations, zero auth endpoints, zero user data
- **Cache aggressively** — read-only responses with configurable TTL
- **Rate limit independently** — different limits for public traffic vs admin usage
- **Deploy separately** — update the CMS without touching the public API, and vice versa

## Security Guarantees

- **Zero write operations** — no INSERT, UPDATE, or DELETE anywhere in the codebase
- **Zero auth/user data** — never reads users, sessions, passwords, audit logs, or settings
- **Zero admin endpoints** — no login, no setup, no management
- **Only serves** — published content, categories, tags, and media files
- **Method enforcement** — rejects all POST/PUT/PATCH/DELETE at the middleware level
- **Rate limited** — 120 requests/minute per IP
- **CORS configurable** — restrict to your frontend domains
- **Security headers** — X-Content-Type-Options, X-Frame-Options, CSP on media

## Quick Start

```bash
# Install
npm install

# Start locally (uses same D1 database as the CMS)
npm run dev

# API running at http://localhost:8788
```

## Deploy

```bash
# 1. Update wrangler.toml with your D1 database_id (same as the CMS)
# 2. Deploy
npx wrangler deploy

# Your public API is live at https://cloudcore-api.your-subdomain.workers.dev
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ALLOWED_ORIGINS` | Recommended | Comma-separated allowed origins for CORS. Leave empty to allow all (dev only). |
| `CACHE_TTL` | Optional | Cache TTL in seconds for content responses (default: 60, max: 86400). |

### Connect Your Frontend

Update your frontend's CMS URL to point to this API instead of the CMS directly:

```bash
# React
VITE_CMS_URL=https://api.yourdomain.com

# Next.js
NEXT_PUBLIC_CMS_URL=https://api.yourdomain.com

# Astro
PUBLIC_CMS_URL=https://api.yourdomain.com
```

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Health check and endpoint list |
| `GET` | `/content` | List published content. Query: `?type=page\|post&limit=20&offset=0` |
| `GET` | `/content/:type/:slug` | Get published content by type and slug |
| `GET` | `/categories` | List all categories |
| `GET` | `/tags` | List all tags |
| `GET` | `/media/:id` | Serve a media file |

All other HTTP methods return `405 Method Not Allowed`.

### Example Responses

**`GET /content?type=post&limit=2`**
```json
{
  "items": [
    {
      "id": "01ABC...",
      "type": "post",
      "title": "Hello World",
      "slug": "hello-world",
      "blocks": [
        { "type": "richtext", "value": "<p>Welcome!</p>" }
      ],
      "publishedAt": "2025-01-15T10:00:00Z",
      "createdAt": "2025-01-15T09:00:00Z",
      "updatedAt": "2025-01-15T10:00:00Z"
    }
  ],
  "pagination": { "total": 1, "limit": 2, "offset": 0, "hasMore": false }
}
```

**`GET /content/page/about`**
```json
{
  "id": "01DEF...",
  "type": "page",
  "title": "About Us",
  "slug": "about",
  "blocks": [...],
  "publishedAt": "2025-01-10T12:00:00Z",
  "categories": [],
  "tags": []
}
```

## Architecture

```
Internet → cloudcore-api (read-only) → D1 Database ← cloudcore-cms (admin, behind CF Access)
              api.example.com                           cms.example.com (locked down)
```

The public API and the CMS share the same D1 database. The CMS writes, the API reads. They deploy as separate workers so you can restrict access to each independently.

## License

MIT
