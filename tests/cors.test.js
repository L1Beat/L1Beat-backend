const request = require('supertest');
const app = require('../src/app');

describe('CORS', () => {
  it('allows the dev frontend origin', async () => {
    const res = await request(app).get('/health').set('Origin', 'https://dev.l1beat.io');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://dev.l1beat.io');
  });

  it('answers an unknown origin without CORS headers instead of a 500', async () => {
    const res = await request(app).get('/health').set('Origin', 'https://example.com');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
