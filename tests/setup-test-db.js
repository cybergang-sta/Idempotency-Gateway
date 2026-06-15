const { Pool } = require('pg');

const testPool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'idempotency_gateway_test',
  user: 'postgres',
  password: 'postgres',
});

async function setupTestDatabase() {
  await testPool.query(`
    DROP TABLE IF EXISTS idempotency_audit_log;
    DROP TABLE IF EXISTS idempotency_store;
    DROP EXTENSION IF EXISTS "uuid-ossp";
  `);
  
  // Re-run migrations
  const fs = require('fs');
  const path = require('path');
  const schema = fs.readFileSync(
    path.join(__dirname, '../src/migrations/001_create_idempotency_table.sql'),
    'utf8'
  );
  await testPool.query(schema);
}

async function teardownTestDatabase() {
  await testPool.query(`
    DROP TABLE IF EXISTS idempotency_audit_log;
    DROP TABLE IF EXISTS idempotency_store;
  `);
  await testPool.end();
}

module.exports = { setupTestDatabase, teardownTestDatabase, testPool };