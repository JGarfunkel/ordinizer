// mockServer.test.ts

import request from 'supertest';
import app from './mockServer';

describe('Mock Server Route Tests', () => {
  it('should return the list of realms', async () => {
    const res = await request(app).get('/api/realms');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('realms');
    expect(Array.isArray(res.body.realms)).toBe(true);
    expect(res.body.realms[0].id).toBe('oz');
  });
});

describe('Entities Route Tests', () => {
  it('should return the list of entities', async () => {
    let res = await request(app).get('/api/realms/oz/entities');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    let count = res.body.length;
    expect(count).toBeGreaterThan(0);

    res = await request(app).get('/api/realms/oz/entities');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect (res.body.length).toBe(count); // Should be the same count as before
  });
});

describe("Matrix Route Tests", () => {
  it('should return the matrix for a domain', async () => {
    const res = await request(app).get('/api/domains/oz/D1/matrix');
    expect(res.status).toBe(200);
    expect(res.body.domain).toHaveProperty('id', 'D1');
    expect(Array.isArray(res.body.entities)).toBe(true);
    expect(res.body.entities[0]).toHaveProperty('id', 'E1');
    expect(Array.isArray(res.body.questions)).toBe(true);
  });
});
