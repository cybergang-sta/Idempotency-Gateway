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
- npm or yarn
- Git

## Installation
# Clone the repository
git clone https://github.com/cybergang-sta/idempotency-gateway.git
cd idempotency-gateway

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Start the server
npm start

# For development with auto-reload
npm run dev

# Run all tests
npm test

# Run concurrency tests specifically
npm run test:concurrency

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