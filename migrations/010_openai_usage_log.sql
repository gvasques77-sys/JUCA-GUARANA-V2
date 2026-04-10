-- ============================================================
-- MIGRATION 010: OpenAI Usage Log (Sprint 0 — Observabilidade)
-- Projeto: CLINICORE
-- Data: 2026-04-09
-- Descrição: Log de todas as chamadas OpenAI feitas pelo backend.
--            Grava tokens, custo USD, latência, clinic_id e purpose.
--            NÃO armazena conteúdo de mensagens (LGPD).
-- ============================================================

CREATE TABLE IF NOT EXISTS openai_usage_log (
  id BIGSERIAL PRIMARY KEY,
  clinic_id UUID REFERENCES clinics(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Identificação da chamada
  model VARCHAR(50) NOT NULL,
  purpose VARCHAR(50) NOT NULL,  -- 'lara_classification', 'lara_response', 'lara_summary', 'crm_insight', etc.

  -- Tokens
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER GENERATED ALWAYS AS (prompt_tokens + completion_tokens) STORED,

  -- Custo (USD, calculado no momento da gravação)
  estimated_cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0,

  -- Performance
  latency_ms INTEGER NOT NULL DEFAULT 0,

  -- Resultado
  success BOOLEAN NOT NULL DEFAULT TRUE,
  error_message TEXT,

  -- Contexto opcional (NÃO armazenar conteúdo de mensagens)
  request_id VARCHAR(100),  -- ID da request original (whatsapp message id, etc.)
  metadata JSONB
);

-- Índices para queries do dashboard
CREATE INDEX IF NOT EXISTS idx_openai_usage_clinic_date ON openai_usage_log(clinic_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_openai_usage_purpose ON openai_usage_log(purpose, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_openai_usage_date ON openai_usage_log(created_at DESC);

-- RLS: cada clínica só vê seus próprios logs
ALTER TABLE openai_usage_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "clinics_see_own_openai_logs" ON openai_usage_log;
CREATE POLICY "clinics_see_own_openai_logs" ON openai_usage_log
  FOR SELECT
  USING (clinic_id::text = current_setting('app.current_clinic_id', true));

-- GV Admins veem tudo (via service_role bypassa RLS automaticamente)
COMMENT ON TABLE openai_usage_log IS 'Log de todas chamadas OpenAI feitas pelo CLINICORE. Não armazena conteúdo de mensagens (LGPD).';

-- -------------------------------------------------------
-- Verificações pós-migration
-- -------------------------------------------------------
-- SELECT table_name FROM information_schema.tables WHERE table_name = 'openai_usage_log';
-- SELECT tablename, rowsecurity FROM pg_tables WHERE tablename = 'openai_usage_log';
