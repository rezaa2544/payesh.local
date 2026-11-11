-- phase: expand
-- Sample table for the row-86 expand/migrate/contract drill (release N-1 schema).
CREATE TABLE IF NOT EXISTS m86_students (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  full_name text NOT NULL,
  phone text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS m86_students_tenant_idx ON m86_students (tenant_id, id);
