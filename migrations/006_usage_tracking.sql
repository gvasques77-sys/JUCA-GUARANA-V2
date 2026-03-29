-- ============================================================
-- MIGRATION 006: Usage Tracking
-- Projeto: CLINICORE
-- Data: 2026-03-29
-- Descrição: Tabelas de rastreamento de uso para billing
-- ============================================================

-- -------------------------------------------------------
-- Tabela: clinic_ai_usage
-- Registra cada chamada à OpenAI API por clínica
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinic_ai_usage (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id         UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  usage_type        TEXT NOT NULL CHECK (usage_type IN (
                      'conversation',
                      'task_processing',
                      'report',
                      'other'
                    )),
  conversation_id   UUID,
  report_type       TEXT,
  model             TEXT NOT NULL DEFAULT 'gpt-4.1',
  tokens_input      INTEGER NOT NULL DEFAULT 0,
  tokens_output     INTEGER NOT NULL DEFAULT 0,
  tokens_total      INTEGER GENERATED ALWAYS AS (tokens_input + tokens_output) STORED,
  cost_usd          NUMERIC(10,6) NOT NULL DEFAULT 0,
  metadata          JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clinic_ai_usage_clinic_id
  ON clinic_ai_usage(clinic_id);

CREATE INDEX IF NOT EXISTS idx_clinic_ai_usage_created_at
  ON clinic_ai_usage(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_clinic_ai_usage_clinic_date
  ON clinic_ai_usage(clinic_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_clinic_ai_usage_type
  ON clinic_ai_usage(usage_type);

ALTER TABLE clinic_ai_usage ENABLE ROW LEVEL SECURITY;

-- -------------------------------------------------------
-- Tabela: clinic_template_usage
-- Registra cada template Meta enviado fora da janela 24h
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinic_template_usage (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id         UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  template_name     TEXT NOT NULL,
  template_category TEXT NOT NULL DEFAULT 'utility'
                    CHECK (template_category IN ('marketing', 'utility', 'authentication')),
  phone_hash        TEXT NOT NULL,
  message_sid       TEXT,
  campaign_id       UUID REFERENCES crm_campaigns(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'sent'
                    CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
  cost_usd          NUMERIC(10,4) NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clinic_template_usage_clinic_id
  ON clinic_template_usage(clinic_id);

CREATE INDEX IF NOT EXISTS idx_clinic_template_usage_created_at
  ON clinic_template_usage(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_clinic_template_usage_clinic_date
  ON clinic_template_usage(clinic_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_clinic_template_usage_campaign
  ON clinic_template_usage(campaign_id);

CREATE OR REPLACE TRIGGER trg_clinic_template_usage_updated_at
  BEFORE UPDATE ON clinic_template_usage
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE clinic_template_usage ENABLE ROW LEVEL SECURITY;

-- -------------------------------------------------------
-- Verificação final
-- -------------------------------------------------------
-- SELECT 'clinic_ai_usage' as tabela, count(*) as registros FROM clinic_ai_usage
-- UNION ALL
-- SELECT 'clinic_template_usage', count(*) FROM clinic_template_usage;
