# The Pay-Once Protocol

A production-ready idempotency layer for payment processing systems that prevents double charging and handles race conditions gracefully.

## 1. Architecture Diagram
┌─────────────────────────────────────────────────────────────────┐
│                     IDEMPOTENCY GATEWAY                         │
│                      REQUEST FLOWCHART                          │
└─────────────────────────────────────────────────────────────────┘

                              ┌─────────────┐
                              │   START     │
                              │ POST Request│
                              └──────┬──────┘
                                     │
                                     ▼
                              ┌─────────────┐
                              │ Extract     │
                              │Idempotency- │
                              │   Key       │
                              └──────┬──────┘
                                     │
                         ┌───────────┴───────────┐
                         │                       │
                         ▼                       ▼
                  ┌─────────────┐         ┌─────────────┐
                  │  Key exists │         │ Key missing │
                  │  in store?  │         │             │
                  └──────┬──────┘         └──────┬──────┘
                         │                       │
            ┌────────────┼────────────┐          │
            │            │            │          ▼
            ▼            ▼            ▼    ┌─────────────┐
      ┌──────────┐ ┌──────────┐ ┌────────┐  │ 400 Bad     │
      │  Same    │ │ Different│ │ In-    │  │ Request     │
      │  Body?   │ │  Body?   │ │ Flight?│  │ "Missing    │
      └────┬─────┘ └────┬─────┘ └───┬────┘  │ Idempotency │
           │            │           │       │   Key"      │
           ▼            ▼           ▼       └─────────────┘
      ┌──────────┐ ┌──────────┐ ┌────────┐
      │  Return  │ │ 409      │ │ Wait   │
      │  Cached  │ │ Conflict │ │ for    │
      │  Response│ │ "Key     │ │ First  │
      │  + Header│ │ already  │ │ Request│
      └────┬─────┘ │ used"    │ └───┬────┘
           │       └──────────┘     │
           │              │         │
           │              │         ▼
           │              │    ┌────────┐
           │              │    │ Return │
           │              │    │ First  │
           │              │    │Request's│
           │              │    │Response│
           │              │    └────────┘
           │              │
           ▼              ▼
      ┌────────────────────────────────┐
      │         END (Response)         │
      └────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    LEGEND                                        │
├─────────────────────────────────────────────────────────────────┤
│  → First Request: Process payment (2s delay), store response   │
│  → Duplicate Request: Return cached response (<5ms)            │
│  → Conflict: Return 409 error                                  │
│  → Race Condition: Second request waits for first to complete  │
└─────────────────────────────────────────────────────────────────┘




### 2. Setup Instructions

## Prerequisites
- Node.js (v16 or higher)
- PostgreSQL (v13 or higher)
- npm or yarn
- Git
- Docker for containerized setup

## Installation

## Option 1
# Local PostgreSQL Setup

```bash
# 1. Install PostgreSQL on your system
# macOS: brew install postgresql
# Ubuntu: sudo apt-get install postgresql
# Windows: Download from postgresql.org

# Create database
createdb idempotency_gateway

# Clone the repository
git clone https://github.com/cybergang-sta/idempotency-gateway.git
cd idempotency-gateway

# Install dependencies
npm install

# Update environment variables with your PostgreSQL credentials
cp .env.example .env

# Run migrations
npm run db:migrate

# Start the server
npm start

# For development with auto-reload
npm run dev

# Run all tests
npm test

# Run concurrency tests specifically
npm run test:concurrency

## Option 2: Docker Setup (Recommended)
# Start PostgreSQL and app together
docker-compose up -d

# Check logs
docker-compose logs -f app

# Stop services
docker-compose down


### Environment Variables
Variable	            Default	            Description
PORT	                 3000	            Server port
NODE_ENV	           development	        env mode
IDEMPOTENCY_TTL_HOURS	  24	        How long to store keys (hours)
PROCESSING_DELAY_MS	     2000	          Simulated payment delay (ms)

### API Documentation
# Endpoint: POST /process-payment
Processes a payment with idempotency guarantee.

# Headers
Header	         Type	Required	Description
Idempotency-Key	string	  Yes	Unique identifier for the request (UUID)
Content-Type	string    Yes	Must be application/json

# Request Body Schema
{
  amount: number;      
  currency: string;    
  customerId?: string; 
  metadata?: object;   
}
# Example Request
curl -X POST http://localhost:3000/process-payment \
  -H "Idempotency-Key: ord_12345_abc" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 100,
    "currency": "GHS",
    "customerId": "cus_67890"
  }'

# Success Response (200 OK)
    First Request (Cache Miss)
{
  "status": "success",
  "message": "Charged 100 GHS",
  "transactionId": "TXN_1702345678901_abc123_1",
  "timestamp": "2024-12-11T10:30:00.000Z",
  "amount": 100,
  "currency": "GHS",
  "customerId": "cus_67890"
}

### Response Headers
Header	            Description
X-Cache-Hit	true if response was from cache (duplicate), false if freshly processed

### Error Responses
Status	Code	                Description
400	Bad Request	            Missing required fields or invalid values
409	Conflict	            Idempotency key reused with different request body
500	Internal Server Error	Unexpected processing error

GET /health                 Health check endpoint for monitoring.

GET /stats                  Admin endpoint for system monitoring.

### Design Decisions

---

### 5. Design Decisions

### Decision 1: PostgreSQL over In-Memory Storage

**Choice:** PostgreSQL for production, in-memory Map for development

**Rationale:**
- **Persistence:** Survives server restarts (critical for FinTech)
- **ACID Compliance:** Atomic get-or-create operations prevent race conditions
- **Audit Trail:** Built-in logging with triggers for compliance
- **Scalability:** Can handle millions of keys, unlike RAM-limited Map
- **Query Capability:** SQL analytics for fraud detection

**Trade-off:** Slightly higher latency (~2-5ms vs <1ms for Map), but worth it for persistence

### Decision 2: Atomic Database Operation Pattern

**Implementation:** PostgreSQL function with `SELECT FOR UPDATE`

```sql
CREATE FUNCTION get_or_create_idempotency_record(...)
RETURNS TABLE(...) AS $$
BEGIN
  SELECT * FROM idempotency_store WHERE key = p_key FOR UPDATE;
  -- Atomic check-and-create
END;
$$;

### Decision 3: Request Body Hashing with SHA256

**Implementation:**
```javascript
hashRequestBody(body) {
  const normalized = JSON.stringify(body, Object.keys(body).sort());
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

Why I donnot store full body?

Memory Efficiency

No accidental storage of sensitive customer data

Index Performance: Hash indexes are faster than JSONB comparisons

Security: Cannot reconstruct original request from hash alone


### Decision 4: In-Flight Request Handling with Row Locking

-- Status 'processing' indicates in-flight request
INSERT INTO idempotency_store (idempotency_key, status) 
VALUES ('key-123', 'processing');

-- Concurrent requests see 'processing' and wait
SELECT * FROM idempotency_store WHERE idempotency_key = 'key-123' FOR UPDATE;
-- This blocks until the first transaction completes

Why this prevents race conditions:

PostgreSQL SELECT FOR UPDATE creates a row-level lock

Second request cannot read the row until first commits

Eliminates the need for application-level mutexes

Works across multiple server instances

### Decision 5: 24-Hour TTL with Automated Cleanup

-- Set expiration when creating record
expires_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP + INTERVAL '24 hours'

-- Scheduled cleanup job (runs every hour)
DELETE FROM idempotency_store WHERE expires_at < CURRENT_TIMESTAMP;

Rationale for 24 hours:

Payment reconciliation cycles are typically daily

Long enough for all retry scenarios (network issues, timeouts)

Short enough to prevent unbounded database growth

Compliant with GDPR data minimization principles


### Decision 6: Separate Audit Log Table Design
Schema:
    CREATE TABLE idempotency_audit_log (
  id BIGSERIAL PRIMARY KEY,
  idempotency_key VARCHAR(255),
  action VARCHAR(50), -- 'PROCESSED', 'CACHE_HIT', 'CONFLICT'
  processing_time_ms INTEGER,
  cache_hit BOOLEAN,
  client_ip INET,
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

Benefits of separation:

Performance: Main table stays small for fast lookups

Compliance: Audit logs can be archived separately

Analytics: Query patterns without locking main table

### Decision 7: 409 Conflict vs 422 Unprocessable Entity
Choice: HTTP 409 Conflict

RFC 7231 specifies 409 for "request conflict with current state of the resource" - perfect for idempotency key mismatch where the key already maps to a different request body. 422 is for validation errors (e.g., invalid currency code).

### Decision 8: Graceful Shutdown with Connection Draining
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, closing server...');
  server.close(async () => {
    await idempotencyManager.shutdown(); // Close DB connections
    console.log('Server closed');
    process.exit(0);
  });
});

Why critical for production:

Prevents connection leaks to PostgreSQL

Allows in-flight transactions to complete

Enables zero-downtime deployments
----------------------------------------------------------------------------------------

### Developer's Choice (Additional Features)
Feature: Transaction Audit Trail & Idempotency Monitoring
Why this matters for FinTech:

In production payment systems, you need:

Auditability - Every charge must be traceable

Fraud Detection - Detect patterns of idempotency key abuse

Operational Visibility - Real-time monitoring of idempotency effectiveness



### Testing Strategy
Covered Scenarios
Happy Path - First request processes with 2s delay

Idempotency - Duplicate requests return cached response

Conflict Detection - Different body with same key → 409

Concurrent Requests - 5 simultaneous identical requests → 1 processes, 4 wait and cache

Validation - Missing headers/invalid data → proper 400 responses

Running Performance Tests

# Test concurrent request handling
npm run test:concurrency




# Contributing
This implementation follows:

All SOLID capstone principles

Clean Architecture patterns

Comprehensive error handling

Production-grade logging