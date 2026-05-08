CREATE TABLE alert_comments (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_id   UUID        NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    tenant_id  UUID        NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    body       TEXT        NOT NULL CHECK (char_length(body) > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alert_comments_alert ON alert_comments(alert_id);
