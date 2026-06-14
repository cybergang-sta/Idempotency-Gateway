const request = require('supertest');
const app = require('../src/server');

describe('Bonus: In-Flight Request Handling', () => {
  test('should handle concurrent identical requests without double processing', async () => {
    const uniqueKey = `concurrent-test-${Date.now()}`;
    const paymentData = {
      amount: 300,
      currency: 'EUR'
    };
    
    // Launch 5 concurrent requests
    const requests = Array(5).fill().map(() => 
      request(app)
        .post('/process-payment')
        .set('Idempotency-Key', uniqueKey)
        .send(paymentData)
    );
    
    const startTime = Date.now();
    const responses = await Promise.all(requests);
    const totalDuration = Date.now() - startTime;
    
    // All requests should succeed
    responses.forEach(response => {
      expect(response.statusCode).toBe(200);
    });
    
    // All responses should have the same transaction ID
    const firstTransactionId = responses[0].body.transactionId;
    responses.forEach(response => {
      expect(response.body.transactionId).toBe(firstTransactionId);
    });
    
    // Only the first request should be a cache miss (others should be hits)
    const cacheHits = responses.filter(r => r.headers['x-cache-hit'] === 'true');
    const cacheMisses = responses.filter(r => r.headers['x-cache-hit'] === 'false');
    
    expect(cacheMisses.length).toBe(1); // Only one actual processing
    expect(cacheHits.length).toBe(4); // Four cache hits
    
    // Total time should be ~2 seconds (not 10 seconds)
    expect(totalDuration).toBeLessThan(3000);
  });
});