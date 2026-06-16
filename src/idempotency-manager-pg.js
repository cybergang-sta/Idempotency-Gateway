const { Pool } = require('pg');
const crypto = require('crypto');

/**
 * PostgreSQL-based Idempotency Manager
 * Provides ACID compliance, persistence, and distributed transaction support
 */
class PostgresIdempotencyManager {
  constructor(config) {
    const poolConfig = {};
    if (config.DATABASE_URL || config.connectionString) {
      poolConfig.connectionString = config.DATABASE_URL || config.connectionString;
    } else {
      poolConfig.host = config.DB_HOST;
      poolConfig.port = config.DB_PORT;
      poolConfig.database = config.DB_NAME;
      poolConfig.user = config.DB_USER;
      poolConfig.password = config.DB_PASSWORD;
    }

    poolConfig.max = config.DB_POOL_MAX || 20;
    poolConfig.idleTimeoutMillis = config.DB_POOL_IDLE_TIMEOUT || 30000;
    poolConfig.connectionTimeoutMillis = config.DB_POOL_CONNECTION_TIMEOUT || 2000;

    this.pool = new Pool(poolConfig);
    
    this.ttlHours = config.IDEMPOTENCY_TTL_HOURS || 24;
    this.cleanupInterval = (config.CLEANUP_INTERVAL_HOURS || 1) * 60 * 60 * 1000;
    
    // Setup connection error handling
    this.pool.on('error', (err) => {
      console.error('Unexpected database error:', err);
    });
    
    // Start cleanup job
    if (this.cleanupInterval > 0) {
      this.intervalId = setInterval(() => this.cleanupExpired(), this.cleanupInterval);
    }
  }

  /**
   * Generate SHA256 hash of request body
   */
  hashRequestBody(body) {
    const normalized = JSON.stringify(body, Object.keys(body).sort());
    return crypto.createHash('sha256').update(normalized).digest('hex');
  }

  /**
   * Atomic get-or-create operation using PostgreSQL advisory locks
   */
  async getOrCreate(key, requestBody, processor, clientInfo = {}) {
    const client = await this.pool.connect();
    const requestHash = this.hashRequestBody(requestBody);
    const startTime = Date.now();
    
    try {
      // Start transaction
      await client.query('BEGIN');
      
      // Use atomic database operation
      const getOrCreateResult = await client.query(
        `SELECT * FROM get_or_create_idempotency_record($1, $2, $3, $4)`,
        [key, requestHash, JSON.stringify(requestBody), this.ttlHours]
      );
      
      const result = getOrCreateResult.rows[0];
      
      // Case 1: Conflict - different body with same key
      if (result.operation === 'conflict') {
        await client.query('ROLLBACK');
        await this.auditLog({
          client,
          key,
          action: 'CONFLICT',
          requestBody,
          cacheHit: false,
          processingTimeMs: Date.now() - startTime,
          clientInfo
        });
        throw new Error('IDEMPOTENCY_MISMATCH');
      }
      
      // Case 2: Cache hit - return stored response
      if (result.operation === 'cached') {
        await client.query('COMMIT');
        await this.auditLog({
          client,
          key,
          action: 'CACHE_HIT',
          requestBody,
          responseBody: result.response_body,
          cacheHit: true,
          processingTimeMs: Date.now() - startTime,
          clientInfo
        });
        return {
          ...result.response_body,
          cached: true
        };
      }
      
      // Case 3: New request - process payment
      if (result.operation === 'process') {
        let paymentResponse;
        let statusCode = 200;
        
        try {
          // Process the payment
          paymentResponse = await processor(requestBody);
          
          // Update database with successful response
          await client.query(
            `UPDATE idempotency_store 
             SET response_body = $1, 
                 status_code = $2, 
                 status = 'completed',
                 version = version + 1
             WHERE idempotency_key = $3`,
            [JSON.stringify(paymentResponse), statusCode, key]
          );
          
          await client.query('COMMIT');
          
          await this.auditLog({
            client,
            key,
            action: 'PROCESSED',
            requestBody,
            responseBody: paymentResponse,
            cacheHit: false,
            processingTimeMs: Date.now() - startTime,
            clientInfo
          });
          
          return paymentResponse;
          
        } catch (error) {
          // On failure, mark as failed and allow retry
          await client.query(
            `UPDATE idempotency_store 
             SET status = 'failed',
                 response_body = $1
             WHERE idempotency_key = $2`,
            [JSON.stringify({ error: error.message }), key]
          );
          await client.query('COMMIT');
          throw error;
        }
      }
      
      await client.query('COMMIT');
      throw new Error('Unknown operation result');
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Audit logging for compliance
   */
  async auditLog({ client, key, action, requestBody, responseBody, cacheHit, processingTimeMs, clientInfo }) {
    try {
      await client.query(
        `INSERT INTO idempotency_audit_log 
         (idempotency_key, action, request_body, response_body, cache_hit, processing_time_ms, client_ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          key,
          action,
          JSON.stringify(requestBody),
          responseBody ? JSON.stringify(responseBody) : null,
          cacheHit,
          processingTimeMs,
          clientInfo.ip || null,
          clientInfo.userAgent || null
        ]
      );
    } catch (err) {
      console.error('Failed to write audit log:', err);
      // Don't throw - audit logging shouldn't break the main flow
    }
  }

  /**
   * Clean up expired records
   */
  async cleanupExpired() {
    const client = await this.pool.connect();
    try {
      const result = await client.query('SELECT cleanup_expired_records()');
      const deletedCount = result.rows[0].cleanup_expired_records;
      if (deletedCount > 0) {
        console.log(`🧹 Cleaned up ${deletedCount} expired idempotency records`);
      }
    } catch (error) {
      console.error('Cleanup failed:', error);
    } finally {
      client.release();
    }
  }

  /**
   * Get store statistics
   */
  async getStats() {
    const client = await this.pool.connect();
    try {
      const results = await Promise.all([
        client.query(`
          SELECT 
            COUNT(*) as total_keys,
            COUNT(CASE WHEN status = 'processing' THEN 1 END) as active_processing,
            COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
            COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed
          FROM idempotency_store
          WHERE expires_at > NOW()
        `),
        client.query(`
          SELECT 
            COUNT(*) as total_audit_logs,
            COUNT(CASE WHEN cache_hit = true THEN 1 END) as cache_hits,
            AVG(processing_time_ms)::INTEGER as avg_processing_time_ms
          FROM idempotency_audit_log
          WHERE created_at > NOW() - INTERVAL '1 hour'
        `)
      ]);
      
      const storeStats = results[0].rows[0];
      const auditStats = results[1].rows[0];
      
      return {
        idempotencyStore: {
          size: parseInt(storeStats.total_keys),
          processing: parseInt(storeStats.active_processing),
          completed: parseInt(storeStats.completed),
          failed: parseInt(storeStats.failed),
          ttl_hours: this.ttlHours
        },
        cachePerformance: {
          hitRate: auditStats.cache_hits && auditStats.total_audit_logs > 0
            ? (auditStats.cache_hits / auditStats.total_audit_logs).toFixed(2)
            : 0,
          avgProcessingTimeMs: auditStats.avg_processing_time_ms || 0,
          lastHourRequests: parseInt(auditStats.total_audit_logs)
        }
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get audit trail for a specific key
   */
  async getAuditTrail(key) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT action, created_at, cache_hit, processing_time_ms
         FROM idempotency_audit_log
         WHERE idempotency_key = $1
         ORDER BY created_at DESC
         LIMIT 100`,
        [key]
      );
      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * Shutdown - close database connections
   */
  async shutdown() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    await this.pool.end();
    console.log('Database connections closed');
  }
}

module.exports = PostgresIdempotencyManager;