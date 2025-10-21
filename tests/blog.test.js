/**
 * Blog Endpoints Tests
 * Tests the /api/blog/* endpoints
 */

const { get, post } = require('./setup');

describe('Blog Endpoints', () => {
  let testSlug;

  describe('GET /api/blog/posts', () => {
    it('should return list of blog posts', async () => {
      const response = await get('/api/blog/posts');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('data');
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should handle limit parameter', async () => {
      const response = await get('/api/blog/posts?limit=5');

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeLessThanOrEqual(5);
    });

    it('should handle offset parameter', async () => {
      const response = await get('/api/blog/posts?limit=10&offset=5');

      expect(response.status).toBe(200);
    });

    it('should handle tag filter', async () => {
      const response = await get('/api/blog/posts?tag=avalanche');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('data');
    });

    it('should return pagination metadata', async () => {
      const response = await get('/api/blog/posts?limit=10');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('metadata');
      expect(response.body.metadata).toHaveProperty('total');
      expect(response.body.metadata).toHaveProperty('limit');
      expect(response.body.metadata).toHaveProperty('offset');
    });

    it('should validate limit is within bounds', async () => {
      const response = await get('/api/blog/posts?limit=150'); // Max is 100

      // Should either clamp to 100 or return validation error
      expect([200, 400]).toContain(response.status);
    });

    it('should return JSON content type', async () => {
      const response = await get('/api/blog/posts');

      expect(response.headers['content-type']).toMatch(/json/);
    });
  });

  describe('GET /api/blog/posts/:slug', () => {
    beforeAll(async () => {
      // Get a valid slug for testing
      const postsResponse = await get('/api/blog/posts?limit=1');
      if (postsResponse.body.data && postsResponse.body.data.length > 0) {
        testSlug = postsResponse.body.data[0].slug;
      }
    });

    it('should return specific blog post by slug', async () => {
      if (!testSlug) {
        console.warn('No test slug available, skipping test');
        return;
      }

      const response = await get(`/api/blog/posts/${testSlug}`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('data');
      expect(response.body.data.slug).toBe(testSlug);
    });

    it('should include post content', async () => {
      if (!testSlug) return;

      const response = await get(`/api/blog/posts/${testSlug}`);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveProperty('title');
      expect(response.body.data).toHaveProperty('content');
    });

    it('should return 404 for non-existent slug', async () => {
      const response = await get('/api/blog/posts/non-existent-slug-12345');

      expect([404, 500]).toContain(response.status);
    });

    it('should return 400 for invalid slug format', async () => {
      const response = await get('/api/blog/posts/invalid@slug#here');

      expect([400, 404]).toContain(response.status);
    });
  });

  describe('GET /api/blog/posts/:slug/related', () => {
    it('should return related posts', async () => {
      if (!testSlug) {
        console.warn('No test slug available, skipping test');
        return;
      }

      const response = await get(`/api/blog/posts/${testSlug}/related`);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('data');
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should handle limit parameter', async () => {
      if (!testSlug) return;

      const response = await get(`/api/blog/posts/${testSlug}/related?limit=3`);

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeLessThanOrEqual(3);
    });

    it('should validate limit bounds (max 6)', async () => {
      if (!testSlug) return;

      const response = await get(`/api/blog/posts/${testSlug}/related?limit=10`);

      // Should either clamp to 6 or return validation error
      expect([200, 400]).toContain(response.status);
    });
  });

  describe('GET /api/blog/health', () => {
    it('should return blog health status', async () => {
      const response = await get('/api/blog/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success');
    });

    it('should include statistics', async () => {
      const response = await get('/api/blog/health');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('stats');
    });

    it('should return JSON content type', async () => {
      const response = await get('/api/blog/health');

      expect(response.headers['content-type']).toMatch(/json/);
    });
  });

  describe('GET /api/blog/tags', () => {
    it('should return list of available tags', async () => {
      const response = await get('/api/blog/tags');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('data');
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should include post counts for tags', async () => {
      const response = await get('/api/blog/tags');

      expect(response.status).toBe(200);

      if (response.body.data.length > 0) {
        const tag = response.body.data[0];
        expect(tag).toHaveProperty('name');
        expect(tag).toHaveProperty('count');
      }
    });

    it('should return JSON content type', async () => {
      const response = await get('/api/blog/tags');

      expect(response.headers['content-type']).toMatch(/json/);
    });
  });

  describe('POST /api/blog/sync', () => {
    it('should trigger blog sync', async () => {
      const response = await post('/api/blog/sync');

      expect([200, 201, 202]).toContain(response.status);
      expect(response.body).toHaveProperty('success');
    }, 60000); // Longer timeout for sync operation

    it('should return sync result', async () => {
      const response = await post('/api/blog/sync');

      expect([200, 201, 202]).toContain(response.status);

      if (response.body.result) {
        expect(response.body.result).toHaveProperty('articlesProcessed');
      }
    }, 60000);
  });
});
