const express = require('express');
const IdempotencyManager = require('./idempotency-manager');
const PaymentProcessor = require('./payment-processor');

const app = express();
app.use(express.json());

// Initialize services
const idempotencyManager = new IdempotencyManager({
  ttl: 24 * 60 * 60 * 1000, // 24 hours
  cleanupInterval: 60 * 60 * 1000 // 1 hour
});

const paymentProcessor = new PaymentProcessor({
  processingDelay: 2000 // 2 seconds as per requirements
});

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - Idempotency-Key: ${req.headers['idempotency-key'] || 'missing'}`);
  next();
});

/**
 * POST /process-payment
 * Handles payment requests with idempotency guarantee
 */
app.post('/process-payment', async (req, res) => {
  try {
    // Extract idempotency key from headers
    const idempotencyKey = req.headers['idempotency-key'];
    
    // Validate idempotency key presence
    if (!idempotencyKey) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Idempotency-Key header is required'
      });
    }
    
    // Validate request body
    const { amount, currency } = req.body;
    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Valid amount (positive number) is required'
      });
    }
    
    if (!currency || typeof currency !== 'string' || currency.length !== 3) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Valid 3-letter currency code is required (e.g., GHS, USD, EUR)'
      });
    }
    
    // Process with idempotency
    const result = await idempotencyManager.getOrCreate(
      idempotencyKey,
      req.body,
      async (body) => paymentProcessor.processPayment(body)
    );
    
    // Add cache hit header if this was a cached response
    if (result.cached) {
      delete result.cached;
      res.setHeader('X-Cache-Hit', 'true');
    } else {
      res.setHeader('X-Cache-Hit', 'false');
    }
    
    // Return response
    return res.status(200).json(result);
    
  } catch (error) {
    // Handle specific error types
    if (error.message === 'IDEMPOTENCY_MISMATCH') {
      return res.status(409).json({
        error: 'Conflict',
        message: 'Idempotency key already used for a different request body.',
        code: 'IDEMPOTENCY_KEY_MISMATCH'
      });
    }
    
    // Handle payment processing errors
    if (error.message.includes('Invalid')) {
      return res.status(400).json({
        error: 'Bad Request',
        message: error.message
      });
    }
    
    // Generic server error
    console.error('Unhandled error:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'An unexpected error occurred. Please try again.'
    });
  }
});

/**
 * GET /health - Health check endpoint
 */
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {
      idempotency: idempotencyManager.getStats(),
      payment: paymentProcessor.getStats()
    }
  });
});

/**
 * GET /stats - Admin endpoint for monitoring
 */
app.get('/stats', (req, res) => {
  res.status(200).json({
    idempotencyStore: idempotencyManager.getStats(),
    paymentProcessor: paymentProcessor.getStats(),
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  idempotencyManager.shutdown();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  idempotencyManager.shutdown();
  process.exit(0);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Idempotency Gateway running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Stats endpoint: http://localhost:${PORT}/stats`);
});

module.exports = app;