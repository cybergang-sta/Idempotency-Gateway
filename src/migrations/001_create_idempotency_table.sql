-- Enable UUID extension for generating unique IDs
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Main idempotency store table
CREATE TABLE IF NOT EXISTS idempotency_store (
    idempotency_key VARCHAR(255) PRIMARY KEY,
    request_hash VARCHAR(64) NOT NULL,
    request_body JSONB NOT NULL,
    response_body JSONB NOT NULL,
    status_code INTEGER NOT NULL,
    status VARCHAR(20) DEFAULT 'completed',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    version INTEGER DEFAULT 1
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_idempotency_expires_at ON idempotency_store(expires_at);
CREATE INDEX IF NOT EXISTS idx_idempotency_request_hash ON idempotency_store(request_hash);
CREATE INDEX IF NOT EXISTS idx_idempotency_status ON idempotency_store(status);

-- Audit log table for compliance
CREATE TABLE IF NOT EXISTS idempotency_audit_log (
    id BIGSERIAL PRIMARY KEY,
    idempotency_key VARCHAR(255),
    action VARCHAR(50) NOT NULL,
    request_body JSONB,
    response_body JSONB,
    cache_hit BOOLEAN DEFAULT FALSE,
    processing_time_ms INTEGER,
    client_ip INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (idempotency_key) REFERENCES idempotency_store(idempotency_key) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_key ON idempotency_audit_log(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON idempotency_audit_log(created_at);

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_idempotency_store_updated_at
    BEFORE UPDATE ON idempotency_store
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Function for atomic get-or-create operation
CREATE OR REPLACE FUNCTION get_or_create_idempotency_record(
    p_key VARCHAR(255),
    p_request_hash VARCHAR(64),
    p_request_body JSONB,
    p_ttl_hours INTEGER
)
RETURNS TABLE(
    operation VARCHAR(20),
    response_body JSONB,
    status_code INTEGER,
    is_processing BOOLEAN
) LANGUAGE plpgsql AS $$
DECLARE
    existing_record RECORD;
    v_expires_at TIMESTAMP;
BEGIN
    v_expires_at := CURRENT_TIMESTAMP + (p_ttl_hours || ' hours')::INTERVAL;
    
    -- Try to get existing record with row lock
    SELECT * INTO existing_record
    FROM idempotency_store
    WHERE idempotency_key = p_key
    FOR UPDATE;
    
    -- If record exists
    IF FOUND THEN
        -- Check if request body matches
        IF existing_record.request_hash = p_request_hash THEN
            -- Return cached response
            RETURN QUERY SELECT 
                'cached'::VARCHAR,
                existing_record.response_body,
                existing_record.status_code,
                FALSE;
        ELSE
            -- Conflict - different body
            RETURN QUERY SELECT 
                'conflict'::VARCHAR,
                NULL::JSONB,
                409,
                FALSE;
        END IF;
    ELSE
        -- Create new record with 'processing' status
        INSERT INTO idempotency_store (
            idempotency_key,
            request_hash,
            request_body,
            response_body,
            status_code,
            status,
            expires_at,
            version
        ) VALUES (
            p_key,
            p_request_hash,
            p_request_body,
            '{}'::JSONB,
            0,
            'processing',
            v_expires_at,
            1
        );
        
        RETURN QUERY SELECT 
            'process'::VARCHAR,
            NULL::JSONB,
            0,
            TRUE;
    END IF;
END;
$$;

-- Cleanup expired records (run via scheduled job)
CREATE OR REPLACE FUNCTION cleanup_expired_records()
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM idempotency_store
    WHERE expires_at < CURRENT_TIMESTAMP;

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    
    RETURN deleted_count;
END;
$$;