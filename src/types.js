// Type definitions for JavaScript (using JSDoc comments)

/**
 * @typedef {Object} PaymentRequest
 * @property {number} amount
 * @property {string} currency
 * @property {string} [customerId]
 * @property {string} [transactionReference]
 */

/**
 * @typedef {Object} PaymentResponse
 * @property {string} status
 * @property {string} message
 * @property {string} transactionId
 * @property {string} timestamp
 * @property {number} amount
 * @property {string} currency
 * @property {string} [customerId]
 */

/**
 * @typedef {Object} StoredTransaction
 * @property {PaymentResponse} response
 * @property {PaymentRequest} requestBody
 * @property {number} timestamp
 * @property {boolean} isProcessing
 * @property {Promise<PaymentResponse>} [promise]
 */

export default {};