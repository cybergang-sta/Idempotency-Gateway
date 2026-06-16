const request = require('supertest');
const app = require('../src/server');

describe('Seeded Data Tests', () => {
  test('Should return cached response for seed-order-002', async () => {
    const response = await request(app)
      .post('/process-payment')
      .set('Idempotency-Key', 'seed-order-002')
      .set('Content-Type', 'application/json')
      .send({ amount: 250, currency: 'USD', customerId: 'cus_002' });
    
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-cache-hit']).toBe('true');
    expect(response.body.transactionId).toBe('TXN_SEED_002');
  });

  test('Should return 409 for seed-order-001 with different body', async () => {
    const response = await request(app)
      .post('/process-payment')
      .set('Idempotency-Key', 'seed-order-001')
      .set('Content-Type', 'application/json')
      .send({ amount: 500, currency: 'USD', customerId: 'cus_001' });
    
    expect(response.statusCode).toBe(409);
    expect(response.body.message).toContain('already used for a different request body');
  });

  test('Should find seeded transactions in audit trail', async () => {
    const response = await request(app)
      .get('/audit/seed-order-001');
    
    expect(response.statusCode).toBe(200);
    expect(response.body.auditTrail.length).toBeGreaterThan(0);
    expect(response.body.auditTrail[0].action).toBe('PROCESSED');
  });

  test('Stats should show seeded data', async () => {
    const response = await request(app)
      .get('/stats');
    
    expect(response.statusCode).toBe(200);
    expect(response.body.database.activeKeys).toBeGreaterThan(50);
  });
});