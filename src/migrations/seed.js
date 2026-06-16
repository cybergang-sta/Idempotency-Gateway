const { Pool } = require('pg');
const crypto = require('crypto');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'idempotency_gateway',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

/**
 * Generate a SHA256 hash of a request body
 */
function hashRequestBody(body) {
  const normalized = JSON.stringify(body, Object.keys(body).sort());
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Generate a random transaction ID
 */
function generateTransactionId() {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `TXN_${timestamp}_${random}`;
}

/**
 * Generate random payment data
 */
function generatePaymentData(index) {
  const currencies = ['GHS', 'USD', 'EUR', 'GBP', 'NGN', 'KES', 'ZAR'];
  const amounts = [10, 25, 50, 75, 100, 150, 200, 250, 500, 1000];
  const customers = [
    'cus_001', 'cus_002', 'cus_003', 'cus_004', 'cus_005',
    'cus_006', 'cus_007', 'cus_008', 'cus_009', 'cus_010'
  ];
  
  const amount = amounts[Math.floor(Math.random() * amounts.length)];
  const currency = currencies[Math.floor(Math.random() * currencies.length)];
  const customerId = customers[Math.floor(Math.random() * customers.length)];
  
  return {
    amount,
    currency,
    customerId,
    metadata: {
      orderId: `ORDER-${String(index).padStart(5, '0')}`,
      productId: `PROD-${String(Math.floor(Math.random() * 100)).padStart(3, '0')}`,
      source: 'seed_script'
    }
  };
}

/**
 * Generate sample response
 */
function generateResponse(requestBody) {
  return {
    status: 'success',
    message: `Charged ${requestBody.amount} ${requestBody.currency}`,
    transactionId: generateTransactionId(),
    timestamp: new Date().toISOString(),
    amount: requestBody.amount,
    currency: requestBody.currency,
    customerId: requestBody.customerId,
    metadata: requestBody.metadata
  };
}

/**
 * Seed the database with test data
 */
async function seedDatabase() {
  const client = await pool.connect();
  
  try {
    console.log('Starting database seed...');
    
    // Check if data already exists
    const checkResult = await client.query(
      'SELECT COUNT(*) FROM idempotency_store'
    );
    const existingCount = parseInt(checkResult.rows[0].count);
    
    if (existingCount > 0) {
      console.log(` Database already has ${existingCount} records.`);
      console.log(' To re-seed, run: npm run db:reset');
      return;
    }
    
    // Generate test scenarios
    const scenarios = [
      {
        // Scenario 1: Successful single transaction
        key: 'seed-order-001',
        body: { amount: 100, currency: 'GHS', customerId: 'cus_001' },
        status: 'completed',
        response: {
          status: 'success',
          message: 'Charged 100 GHS',
          transactionId: 'TXN_SEED_001',
          timestamp: new Date().toISOString(),
          amount: 100,
          currency: 'GHS',
          customerId: 'cus_001'
        },
        statusCode: 200,
        cacheHit: false
      },
      {
        // Scenario 2: Transaction with retry (cache hit)
        key: 'seed-order-002',
        body: { amount: 250, currency: 'USD', customerId: 'cus_002' },
        status: 'completed',
        response: {
          status: 'success',
          message: 'Charged 250 USD',
          transactionId: 'TXN_SEED_002',
          timestamp: new Date().toISOString(),
          amount: 250,
          currency: 'USD',
          customerId: 'cus_002'
        },
        statusCode: 200,
        cacheHit: true
      },
      {
        // Scenario 3: Large transaction
        key: 'seed-order-003',
        body: { amount: 1000, currency: 'EUR', customerId: 'cus_003' },
        status: 'completed',
        response: {
          status: 'success',
          message: 'Charged 1000 EUR',
          transactionId: 'TXN_SEED_003',
          timestamp: new Date().toISOString(),
          amount: 1000,
          currency: 'EUR',
          customerId: 'cus_003'
        },
        statusCode: 200,
        cacheHit: false
      },
      {
        // Scenario 4: Transaction with metadata
        key: 'seed-order-004',
        body: { 
          amount: 50, 
          currency: 'GBP', 
          customerId: 'cus_004',
          metadata: { 
            orderId: 'ORDER-12345',
            productId: 'PROD-999',
            subscription: 'premium'
          }
        },
        status: 'completed',
        response: {
          status: 'success',
          message: 'Charged 50 GBP',
          transactionId: 'TXN_SEED_004',
          timestamp: new Date().toISOString(),
          amount: 50,
          currency: 'GBP',
          customerId: 'cus_004',
          metadata: { 
            orderId: 'ORDER-12345',
            productId: 'PROD-999',
            subscription: 'premium'
          }
        },
        statusCode: 200,
        cacheHit: false
      },
      {
        // Scenario 5: Failed transaction (for testing error handling)
        key: 'seed-order-005',
        body: { amount: 75, currency: 'NGN', customerId: 'cus_005' },
        status: 'failed',
        response: {
          error: 'Payment processing failed',
          message: 'Insufficient funds'
        },
        statusCode: 400,
        cacheHit: false
      }
    ];
    
    // Insert scenarios
    for (const scenario of scenarios) {
      const requestHash = hashRequestBody(scenario.body);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      
      // Insert into idempotency_store
      await client.query(
        `INSERT INTO idempotency_store 
         (idempotency_key, request_hash, request_body, response_body, 
          status_code, status, expires_at, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          scenario.key,
          requestHash,
          JSON.stringify(scenario.body),
          JSON.stringify(scenario.response),
          scenario.statusCode,
          scenario.status,
          expiresAt,
          1
        ]
      );
      
      // Insert audit log entries
      const actions = scenario.cacheHit 
        ? ['PROCESSED', 'CACHE_HIT']
        : ['PROCESSED'];
      
      for (const action of actions) {
        await client.query(
          `INSERT INTO idempotency_audit_log 
           (idempotency_key, action, request_body, response_body, 
            cache_hit, processing_time_ms, client_ip, user_agent)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            scenario.key,
            action,
            JSON.stringify(scenario.body),
            action === 'CACHE_HIT' ? JSON.stringify(scenario.response) : null,
            action === 'CACHE_HIT',
            action === 'CACHE_HIT' ? 3 : 2012,
            '192.168.1.100',
            'Mozilla/5.0 (Test Client)'
          ]
        );
      }
    }
    
    // Generate 50 random transactions for load testing
    console.log(' Generating 50 random transactions...');
    
    for (let i = 0; i < 50; i++) {
      const key = `load-test-${String(i).padStart(3, '0')}`;
      const body = generatePaymentData(i);
      const requestHash = hashRequestBody(body);
      const response = generateResponse(body);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      
      await client.query(
        `INSERT INTO idempotency_store 
         (idempotency_key, request_hash, request_body, response_body, 
          status_code, status, expires_at, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          key,
          requestHash,
          JSON.stringify(body),
          JSON.stringify(response),
          200,
          'completed',
          expiresAt,
          1
        ]
      );
    }
    
    // Create duplicate entries for cache testing
    console.log(' Creating duplicate entries for cache testing...');
    const duplicateKeys = [
      'load-test-001', 'load-test-005', 'load-test-010', 
      'load-test-015', 'load-test-020'
    ];
    
    for (const key of duplicateKeys) {
      const result = await client.query(
        `SELECT request_body, response_body FROM idempotency_store WHERE idempotency_key = $1`,
        [key]
      );
      
      if (result.rows.length > 0) {
        const row = result.rows[0];
        await client.query(
          `INSERT INTO idempotency_audit_log 
           (idempotency_key, action, request_body, response_body, 
            cache_hit, processing_time_ms, client_ip, user_agent)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            key,
            'CACHE_HIT',
            row.request_body,
            row.response_body,
            true,
            2,
            '10.0.0.1',
            'Mozilla/5.0 (Duplicate Client)'
          ]
        );
      }
    }
    
    console.log(' Seed completed successfully!');
    
    // Display summary
    const summary = await client.query(`
      SELECT 
        COUNT(*) as total_records,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
        COUNT(CASE WHEN status = 'processing' THEN 1 END) as processing
      FROM idempotency_store
    `);
    
    console.log('\n Database Summary:');
    console.log(`   Total Records: ${summary.rows[0].total_records}`);
    console.log(`   Completed: ${summary.rows[0].completed}`);
    console.log(`   Failed: ${summary.rows[0].failed}`);
    console.log(`   Processing: ${summary.rows[0].processing}`);
    
    const auditSummary = await client.query(`
      SELECT 
        COUNT(*) as total_audits,
        SUM(CASE WHEN cache_hit THEN 1 ELSE 0 END) as cache_hits,
        ROUND(100.0 * SUM(CASE WHEN cache_hit THEN 1 ELSE 0 END) / COUNT(*), 2) as hit_rate
      FROM idempotency_audit_log
    `);
    
    console.log(`\nCache Performance:`);
    console.log(`   Total Audit Logs: ${auditSummary.rows[0].total_audits}`);
    console.log(`   Cache Hits: ${auditSummary.rows[0].cache_hits}`);
    console.log(`   Hit Rate: ${auditSummary.rows[0].hit_rate}%`);
    
  } catch (error) {
    console.error('Seed failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * Reset database (clear all data)
 */
async function resetDatabase() {
  const client = await pool.connect();
  try {
    console.log('Resetting database...');
    await client.query('DELETE FROM idempotency_audit_log');
    await client.query('DELETE FROM idempotency_store');
    console.log('Database reset complete');
  } finally {
    client.release();
    await pool.end();
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
if (args.includes('--reset')) {
  resetDatabase().then(() => seedDatabase());
} else if (args.includes('--help')) {
  console.log(`
Usage:
  npm run db:seed              # Seed database with test data
  npm run db:seed -- --reset   # Reset and re-seed database
  npm run db:seed -- --help    # Show this help
  `);
} else {
  seedDatabase();
}

module.exports = { seedDatabase, resetDatabase };