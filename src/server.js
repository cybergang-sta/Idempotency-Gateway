const express = require('express');
const PostgresIdempotencyManager = require('./idempotency-manager-pg');
const PaymentProcessor = require('./payment-processor');

const app = express();
app.use(express.json());

// Initialize PostgreSQL-backed services
const idempotencyManager = new PostgresIdempotencyManager({
  DB_HOST: process.env.DB_HOST || 'localhost',
  DB_PORT: process.env.DB_PORT || 5432,
  DB_NAME: process.env.DB_NAME || 'idempotency_gateway',
  DB_USER: process.env.DB_USER || 'postgres',
  DB_PASSWORD: process.env.DB_PASSWORD || 'postgres',
  IDEMPOTENCY_TTL_HOURS: parseInt(process.env.IDEMPOTENCY_TTL_HOURS) || 24,
  CLEANUP_INTERVAL_HOURS: parseInt(process.env.CLEANUP_INTERVAL_HOURS) || 1,
});

const paymentProcessor = new PaymentProcessor({
  processingDelay: parseInt(process.env.PROCESSING_DELAY_MS) || 2000
});

// Middleware to capture client info for audit
app.use((req, res, next) => {
  req.clientInfo = {
    ip: req.ip || req.connection.remoteAddress,
    userAgent: req.headers['user-agent']
  };
  next();
});

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - Key: ${req.headers['idempotency-key'] || 'missing'}`);
  next();
});

/**
 * POST /process-payment - With PostgreSQL persistence
 */
app.post('/process-payment', async (req, res) => {
  try {
    const idempotencyKey = req.headers['idempotency-key'];
    
    // Validation
    if (!idempotencyKey) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Idempotency-Key header is required'
      });
    }
    
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
    
    // Process with PostgreSQL idempotency
    const result = await idempotencyManager.getOrCreate(
      idempotencyKey,
      req.body,
      async (body) => paymentProcessor.processPayment(body),
      req.clientInfo
    );
    
    // Add cache hit header
    if (result.cached) {
      delete result.cached;
      res.setHeader('X-Cache-Hit', 'true');
    } else {
      res.setHeader('X-Cache-Hit', 'false');
    }
    
    return res.status(200).json(result);
    
  } catch (error) {
    if (error.message === 'IDEMPOTENCY_MISMATCH') {
      return res.status(409).json({
        error: 'Conflict',
        message: 'Idempotency key already used for a different request body.',
        code: 'IDEMPOTENCY_KEY_MISMATCH'
      });
    }
    
    console.error('Unhandled error:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'An unexpected error occurred. Please try again.'
    });
  }
});

/**
 * GET /stats - Enhanced with PostgreSQL metrics
 */
app.get('/stats', async (req, res) => {
  try {
    const stats = await idempotencyManager.getStats();
    res.status(200).json({
      ...stats,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /audit/:key - View audit trail for specific idempotency key
 */
app.get('/audit/:key', async (req, res) => {
  try {
    const auditTrail = await idempotencyManager.getAuditTrail(req.params.key);
    res.status(200).json({
      idempotencyKey: req.params.key,
      auditTrail,
      count: auditTrail.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /health - Health check with database status
 */
app.get('/health', async (req, res) => {
  try {
    // Test database connection
    await idempotencyManager.pool.query('SELECT 1');
    
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: 'connected',
      services: {
        idempotency: 'operational',
        payment: 'operational'
      }
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      database: 'disconnected',
      error: error.message
    });
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await idempotencyManager.shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  await idempotencyManager.shutdown();
  process.exit(0);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Idempotency Gateway (PostgreSQL) running on port ${PORT}`);
  console.log(`Stats endpoint: http://localhost:${PORT}/stats`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Audit trail: http://localhost:${PORT}/audit/:key`);
});

module.exports = app;