/**
 * Payment Processor - Simulates payment gateway integration
 * In production, this would integrate with Stripe, PayPal, etc.
 */
class PaymentProcessor {
  constructor(options = {}) {
    this.processingDelay = options.processingDelay || 2000;
    this.transactionCounter = 0;
    this.processedTransactions = new Set(); // Track processed transaction IDs
  }

  /**
   * Simulate payment processing with a delay
   * @param {Object} paymentRequest - Payment details
   * @returns {Promise<Object>} - Payment response
   */
  async processPayment(paymentRequest) {
    const { amount, currency, customerId, transactionReference } = paymentRequest;
    
    // Validate payment request
    if (!amount || amount <= 0) {
      throw new Error('Invalid amount: amount must be positive');
    }
    
    if (!currency || typeof currency !== 'string') {
      throw new Error('Invalid currency');
    }
    
    // Simulate network/processing delay
    await this.delay(this.processingDelay);
    
    // Generate unique transaction ID
    const transactionId = this.generateTransactionId();
    
    // Store that we processed this transaction (for audit)
    this.processedTransactions.add(transactionId);
    
    // Return successful response
    return {
      status: 'success',
      message: `Charged ${amount} ${currency}`,
      transactionId,
      timestamp: new Date().toISOString(),
      amount,
      currency,
      customerId: customerId || null
    };
  }

  /**
   * Utility method to simulate delay
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Generate unique transaction ID
   */
  generateTransactionId() {
    this.transactionCounter++;
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `TXN_${timestamp}_${random}_${this.transactionCounter}`;
  }

  /**
   * Get processor statistics
   */
  getStats() {
    return {
      totalTransactionsProcessed: this.processedTransactions.size,
      processingDelay: this.processingDelay
    };
  }
}

module.exports = PaymentProcessor;