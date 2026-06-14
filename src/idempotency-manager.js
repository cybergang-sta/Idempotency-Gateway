const crypto = require('crypto');

/**
 * Idempotency Manager - Handles storage and retrieval of idempotent operations
 * Implements in-flight request tracking to prevent race conditions
 */
class IdempotencyManager {
  constructor(options = {}) {
    // Use Map for O(1) lookups (in-memory store)
    // In production, replace with Redis for distributed systems
    this.store = new Map();
    
    // TTL for stored transactions (default: 24 hours)
    this.ttl = options.ttl || 24 * 60 * 60 * 1000;
    
    // Cleanup interval (default: 1 hour)
    this.cleanupInterval = options.cleanupInterval || 60 * 60 * 1000;
    
    // Start automatic cleanup
    if (this.cleanupInterval > 0) {
      this.intervalId = setInterval(() => this.cleanup(), this.cleanupInterval);
    }
  }

  /**
   * Generate a hash of the request body for comparison
   * @param {Object} body - Request body
   * @returns {string} - SHA256 hash
   */
  hashRequestBody(body) {
    const normalizedBody = JSON.stringify(body, Object.keys(body).sort());
    return crypto.createHash('sha256').update(normalizedBody).digest('hex');
  }

  /**
   * Get or create a transaction record
   * @param {string} key - Idempotency key
   * @param {Object} requestBody - Payment request body
   * @param {Function} processor - Async function that processes the payment
   * @returns {Promise<Object>} - Payment response
   */
  async getOrCreate(key, requestBody, processor) {
    const existing = this.store.get(key);
    const requestHash = this.hashRequestBody(requestBody);

    // Case 1: Key exists
    if (existing) {
      // Check if request body matches
      if (existing.requestHash !== requestHash) {
        throw new Error('IDEMPOTENCY_MISMATCH');
      }
      
      // Check if transaction is still processing (in-flight)
      if (existing.isProcessing && existing.promise) {
        // Wait for the in-flight request to complete
        return existing.promise;
      }
      
      // Return cached response
      return { ...existing.response, cached: true };
    }

    // Case 2: New key - create processing record and execute
    const processingPromise = this.executeAndStore(key, requestBody, requestHash, processor);
    
    // Store the promise immediately for concurrent requests
    this.store.set(key, {
      isProcessing: true,
      promise: processingPromise,
      requestHash,
      requestBody,
      timestamp: Date.now()
    });

    try {
      const result = await processingPromise;
      return result;
    } catch (error) {
      // On failure, remove the record so the client can retry
      this.store.delete(key);
      throw error;
    }
  }

  /**
   * Execute payment processing and store result
   * @private
   */
  async executeAndStore(key, requestBody, requestHash, processor) {
    try {
      const response = await processor(requestBody);
      
      // Update store with completed transaction
      this.store.set(key, {
        response,
        requestHash,
        requestBody,
        timestamp: Date.now(),
        isProcessing: false,
        promise: null
      });
      
      return response;
    } catch (error) {
      // Clean up on failure
      this.store.delete(key);
      throw error;
    }
  }

  /**
   * Check if a key exists and if the request body matches
   * @returns {Object} - { exists, matches, cachedResponse }
   */
  check(key, requestBody) {
    const existing = this.store.get(key);
    if (!existing) {
      return { exists: false };
    }
    
    const requestHash = this.hashRequestBody(requestBody);
    const matches = existing.requestHash === requestHash;
    
    return {
      exists: true,
      matches,
      cachedResponse: matches ? existing.response : null,
      isProcessing: existing.isProcessing
    };
  }

  /**
   * Clean up expired entries
   */
  cleanup() {
    const now = Date.now();
    for (const [key, value] of this.store.entries()) {
      if (now - value.timestamp > this.ttl) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Get store statistics
   */
  getStats() {
    return {
      size: this.store.size,
      ttl: this.ttl,
      activeProcessing: Array.from(this.store.values()).filter(v => v.isProcessing).length
    };
  }

  /**
   * Shutdown cleanup interval
   */
  shutdown() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
  }
}

module.exports = IdempotencyManager;