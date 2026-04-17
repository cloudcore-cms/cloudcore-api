import { describe, it, expect } from 'vitest';
import app from '../index';

const env = { DB: {} as any, BUCKET: {} as any };

describe('Public API', () => {
  describe('Health', () => {
    it('GET / returns API info', async () => {
      const res = await app.request('/', {}, env);
      expect(res.status).toBe(200);
      const body = await res.json() as { name: string; status: string };
      expect(body.name).toBe('Cloudcore Public API');
      expect(body.status).toBe('ok');
    });

    it('404 for unknown routes', async () => {
      const res = await app.request('/nonexistent', {}, env);
      expect(res.status).toBe(404);
    });
  });

  describe('Read-only enforcement', () => {
    const methods = ['POST', 'PUT', 'PATCH', 'DELETE'];
    for (const method of methods) {
      it(`${method} is rejected with 405`, async () => {
        const res = await app.request('/content', { method }, env);
        expect(res.status).toBe(405);
        const body = await res.json() as { error: string };
        expect(body.error).toContain('read-only');
      });
    }
  });

  describe('Security headers', () => {
    it('sets X-Content-Type-Options', async () => {
      const res = await app.request('/', {}, env);
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    });

    it('sets X-Frame-Options', async () => {
      const res = await app.request('/', {}, env);
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    });

    it('sets Referrer-Policy', async () => {
      const res = await app.request('/', {}, env);
      expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    });
  });

  describe('Content type validation', () => {
    it('rejects invalid content type in slug route', async () => {
      const res = await app.request('/content/invalid/test', {}, env);
      expect(res.status).toBe(400);
    });
  });
});
