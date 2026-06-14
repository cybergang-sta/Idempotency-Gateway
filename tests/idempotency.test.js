const request = require('supertest');
const app = require('../src/server');

describe('Idempotency Gateway Tests', () => {
  describe('User Story 1: First Transaction (Happy Path)', () => {
    test('should process payment and return 200 with correct response', async () => {
      const uniqueKey = `test-key-${Date.now()}`;
      const paymentData = {
        amount: 100,
        currency: 'GHS'
      };
      
      const startTime = Date.now();
      const response = await request(app)
        .post('/process-payment')
        .set('Idempotency-Key', uniqueKey)
        .send(paymentData);
      
      const duration = Date.now() - startTime;
      
      expect(response.statusCode).toBe(200);
      expect(response.body.status).toBe('success');
      expect(response.body.message).toBe('Charged 100 GHS');
      expect(response.body.amount).toBe(100);
      expect(response.body.currency).toBe('GHS');
      expect(response.body.transactionId).toBeDefined();
      expect(duration).toBeGreaterThanOrEqual(2000); // Should have 2s delay
    });
  });
  
  describe('User Story 2: Duplicate Attempt (Idempotency Logic)', () => {
    test('should return cached response without reprocessing', async () => {
      const uniqueKey = `duplicate-test-${Date.now()}`;
      const paymentData = {
        amount: 200,
        currency: 'USD'
      };
      
      // First request
      const firstResponse = await request(app)
        .post('/process-payment')
        .set('Idempotency-Key', uniqueKey)
        .send(paymentData);
      
      const startTime = Date.now();
      // Second request with same key
      const secondResponse = await request(app)
        .post('/process-payment')
        .set('Idempotency-Key', uniqueKey)
        .send(paymentData);
      
      const duration = Date.now() - startTime;
      
      expect(secondResponse.statusCode).toBe(200);
      expect(secondResponse.body).toEqual(firstResponse.body);
      expect(secondResponse.headers['x-cache-hit']).toBe('true');
      expect(duration).toBeLessThan(100); // Should be nearly instant
    });
  });
  
  describe('User Story 3: Different Request, Same Key', () => {
    test('should reject with 409 when key reused with different body', async () => {
      const uniqueKey = `conflict-test-${Date.now()}`;
      
      // First request
      await request(app)
        .post('/process-payment')
        .set('Idempotency-Key', uniqueKey)
        .send({ amount: 100, currency: 'GHS' });
      
      // Second request with different amount
      const response = await request(app)
        .post('/process-payment')
        .set('Idempotency-Key', uniqueKey)
        .send({ amount: 500, currency: 'GHS' });
      
      expect(response.statusCode).toBe(409);
      expect(response.body.message).toContain('already used for a different request body');
    });
  });
  
  describe('Validation Tests', () => {
    test('should reject request without Idempotency-Key', async () => {
      const response = await request(app)
        .post('/process-payment')
        .send({ amount: 100, currency: 'GHS' });
      
      expect(response.statusCode).toBe(400);
      expect(response.body.message).toContain('Idempotency-Key header is required');
    });
    
    test('should reject invalid amount', async () => {
      const response = await request(app)
        .post('/process-payment')
        .set('Idempotency-Key', 'test-key')
        .send({ amount: -50, currency: 'GHS' });
      
      expect(response.statusCode).toBe(400);
    });
  });
});