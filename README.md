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


## 2. Setup Instructions
### Prerequisites
- Node.js (v16 or higher)
- PostgreSQL (v13 or higher)
- npm or yarn
- Git
- Docker for containerized setup

## 3. Installation

### Option 1: Local PostgreSQL Setup
```bash
# 1. Install PostgreSQL on your system
# macOS: brew install postgresql
# Ubuntu: sudo apt-get install postgresql
# Windows: Download from postgresql.org

# 2. Create database
createdb idempotency_gateway

# 3. Clone the repository
git clone https://github.com/cybergang-sta/idempotency-gateway.git
cd idempotency-gateway

# 4. Install dependencies
npm install

# 5. Update environment variables with your PostgreSQL credentials
cp .env.example .env

# 6. Run migrations
npm run db:migrate

# 7. Start the server
npm start

# For development with auto-reload
npm run dev

# Run all tests
npm test

# Run concurrency tests specifically
npm run test:concurrency
```

### Option 2: Docker Setup 
```
# Start PostgreSQL and app together
docker-compose up -d

# Check logs
docker-compose logs -f app

# Stop services
docker-compose down
```

## Environment Variables
```
| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3000 | Server port |
| NODE_ENV | development | environment mode |
| IDEMPOTENCY_TTL_HOURS | 24 hours | How long to store keys |
| PROCESSING_DELAY_MS | 2000ms | Simulated payment delay |
```

## API Documentation
### Endpoint: POST /process-payment
Processes a payment with idempotency guarantee.
# Headers
```
| Header | Type | Required | Description |
|--------|------|----------|-------------|
| Idempotency-Key | string | Yes | Unique identifier for the request (UUID) |
| Content-Type | string | Yes | Must be application/json |
```

# Request Body Schema
{
  "amount": number,
  "currency": string
}
# Example Request
curl -X POST http://localhost:3000/process-payment \
  -H "Idempotency-Key: ord_12345_abc" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 100,
    "currency": "GHS"
  }'

# Success Response (200 OK)
- First Request (Cache Miss)
{
  "status": "Charged 100 GHS"
}

### Response Headers
Header	            Description
X-Cache-Hit	true if response was from cache or duplicate, false if freshly processed

### Error Responses
- 400 Bad Request - Missing Idempotency Key
{
  "error": "Missing Idempotency-Key header"
}

- 409 Conflict - Different Body with Same Key
{
  "error": "Idempotency key already used for a different request body"
}

- 500 Internal Server Error
{
  "error": "Internal server error"
}

### Additional Endpoints
- GET /health
Health check endpoint for monitoring.
- GET /stats
Admin endpoint for system monitoring.


## 4. Design Decisions

### Decision 1: Migration from In-Memory Store to PostgreSQL

**Why I started with in-Memory Store**
    **Speed: Sub-millisecond lookups (<1ms)**

    **Simplicity: No external dependencies**

    **Development Speed: Quick prototyping**

    **Zero Configuration: No database setup needed**

**Why I Migrated:**
    **No Persistence: Thus, data Loss on Restart**
    **Unexpected crashes would cause double charges**
    **New instances start with empty memory**
    **No audit trail for transactions**

    
### Decision 2: PostgreSQL over In-Memory Storage

**Choice:** PostgreSQL for production, in-memory Map for development

**Rationale:**
- **Persistence:** Survives server restarts (critical for FinTech)
- **ACID Compliance:** Atomic get-or-create operations prevent race conditions
- **Audit Trail:** Built-in logging with triggers for compliance
- **Scalability:** Can handle millions of keys, unlike RAM-limited Map
- **Query Capability:** SQL analytics for fraud detection

**Trade-off:** Slightly higher latency 2-5ms, but worth it for persistence

### Decision 3: Atomic Database Operation Pattern

**Implementation:** PostgreSQL function with `SELECT FOR UPDATE`

```sql
CREATE FUNCTION get_or_create_idempotency_record(...)
RETURNS TABLE(...) AS $$
BEGIN
  SELECT * FROM idempotency_store WHERE key = p_key FOR UPDATE;
  -- Atomic check-and-create
END;
$$;
```

### Decision 4: In-Flight Request Handling with Row Locking
```sql
-- Status 'processing' indicates in-flight request
INSERT INTO idempotency_store (idempotency_key, status) 
VALUES ('key-123', 'processing');

-- Concurrent requests see 'processing' and wait
SELECT * FROM idempotency_store WHERE idempotency_key = 'key-123' FOR UPDATE;
-- This blocks until the first transaction completes
```
Why this prevents race conditions:

PostgreSQL SELECT FOR UPDATE creates a row-level lock

Second request cannot read the row until first commits

Eliminates the need for application-level mutexes

Works across multiple server instances

### Decision 5: 24-Hour TTL with Automated Cleanup
```sql
-- Set expiration when creating record
expires_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP + INTERVAL '24 hours'

-- Scheduled cleanup job (runs every hour)
DELETE FROM idempotency_store WHERE expires_at < CURRENT_TIMESTAMP;
```
Rationale for 24 hours:

Payment reconciliation cycles are typically daily

Long enough for all retry scenarios (network issues, timeouts)

Short enough to prevent unbounded database growth

Compliant with regulations for data minimization principles


### Decision 6: Request Body Hashing with SHA256
Implementation:
```javascript
hashRequestBody(body) {
  const normalized = JSON.stringify(body, Object.keys(body).sort());
  return crypto.createHash('sha256').update(normalized).digest('hex');
}
```
Why its not ideal to store full body:

Memory Efficiency: 64 bytes vs potentially KBs of JSON

Personal Identifiable Information Compliance: Protects sensitive customer data

Index Performance: Hash indexes are faster than JSONB comparisons

Security: Cannot reconstruct original request from hash alone



## 5. Developer's Choice 

### Transaction Audit Trail System

**Why this matters for FinTech:**

In real-world FinTech, you can't just prevent double charging - you must be able to prove you prevented it. When a customer disputes a charge, regulators ask: "Show us every request and what you did with it."

In production payment systems, you need:

- **Auditability** - Every charge must be traceable for compliance
- **Fraud Detection** - Detect patterns of idempotency key abuse
- **Operational Visibility** - Real-time monitoring of system health

**Complete Implementation:**
The system logs every idempotency event with full context:
```sql
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
```
#### Business Value
```markdown
| Metric | Before | After Implementation |
|--------|--------|----------------------|
| Fraud detection time | Days | Minutes |
| Debugging duplicate charges | Hours | 30 seconds via /audit endpoint |
| Compliance audit preparation | Weeks | Minutes to export audit logs |
| Cache effectiveness visibility | None | Real-time hit ratio |


#### How to Use
```bash
# View audit trail for a specific transaction
curl http://localhost:3000/audit/ord_12345

# Response
{
  "idempotencyKey": "ord_12345",
  "auditTrail": [
    {
      "action": "PROCESSED",
      "created_at": "2024-12-11T10:30:00Z",
      "cache_hit": false,
      "processing_time_ms": 2012,
      "client_ip": "192.168.1.100"
    },
    {
      "action": "CACHE_HIT", 
      "created_at": "2024-12-11T10:30:05Z",
      "cache_hit": true,
      "processing_time_ms": 3
    }
  ]
}
```

## 6. Testing Strategy
```bash
# Run the complete test suite
npm test

# Run specific test groups
npm test -- --testNamePattern="Happy Path"
npm test -- --testNamePattern="Idempotency"
npm test -- --testNamePattern="Concurrent"

# Run concurrency race condition test
npm run test:concurrency

# Run with coverage report
npm test -- --coverage
```

### Manual Test Commands
```bash
# 1. Health check
curl http://localhost:3000/health

# 2. First payment (should take ~2 seconds)
time curl -X POST http://localhost:3000/process-payment \
  -H "Idempotency-Key: test-001" \
  -H "Content-Type: application/json" \
  -d '{"amount": 100, "currency": "GHS"}'

# 3. Duplicate request (should be <10ms)
time curl -X POST http://localhost:3000/process-payment \
  -H "Idempotency-Key: test-001" \
  -H "Content-Type: application/json" \
  -d '{"amount": 100, "currency": "GHS"}'
# Expected: X-Cache-Hit: true, ~3ms response time

# 4. Conflict test (different body, same key)
curl -X POST http://localhost:3000/process-payment \
  -H "Idempotency-Key: test-001" \
  -H "Content-Type: application/json" \
  -d '{"amount": 500, "currency": "GHS"}'
# Expected: 409 Conflict with error message

# 5. View monitoring stats
curl http://localhost:3000/stats

# 6. View audit trail
curl http://localhost:3000/audit/test-001

# 7. Test race condition (5 simultaneous requests)
for i in {1..5}; do
  curl -X POST http://localhost:3000/process-payment \
    -H "Idempotency-Key: race-test-001" \
    -H "Content-Type: application/json" \
    -d '{"amount": 100, "currency": "USD"}' &
done
wait
# Expected: Only 1 processes, 4 cache hits, no duplicate processing

# 8. Verify persistence (restart server)
npm start
curl -X POST http://localhost:3000/process-payment \
  -H "Idempotency-Key: test-001" \
  -H "Content-Type: application/json" \
  -d '{"amount": 100, "currency": "GHS"}'
# Expected: Still returns cached response (X-Cache-Hit: true)
```

## 7. Covered Scenarios
- Happy Path - First request processes with 2s delay

- Idempotency - Duplicate requests return cached response

- Conflict Detection - Different body with same key → 409

- Concurrent Requests - 5 simultaneous identical requests → 1 processes, 4 wait and cache

- Validation - Missing headers/invalid data → proper 400 responses

- Persistence - Server restart doesn't lose idempotency data

- Audit Trail - All actions logged with timestamps

## 8. Contribution
**This implementation follows:**
- All SOLID principles
- Clean Architecture patterns
- Comprehensive error handling
- Production-grade logging