const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const poolConfig = {};
if (process.env.DATABASE_URL) {
  poolConfig.connectionString = process.env.DATABASE_URL;
  poolConfig.ssl = { rejectUnauthorized: false };
} else {
  poolConfig.host = process.env.DB_HOST || 'localhost';
  poolConfig.port = process.env.DB_PORT || 5432;
  poolConfig.database = process.env.DB_NAME || 'idempotency_gateway';
  poolConfig.user = process.env.DB_USER || 'postgres';
  poolConfig.password = process.env.DB_PASSWORD || 'postgres';
}

const pool = new Pool(poolConfig);

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Starting database migration...');
    
    const schema = fs.readFileSync(
      path.join(__dirname, '001_create_idempotency_table.sql'),
      'utf8'
    );
    
    await client.query(schema);
    console.log('Migration completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();