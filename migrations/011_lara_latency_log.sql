-- ============================================================
-- MIGRATION 011: Lara Latency Log (Sprint 0 — Observabilidade)
-- Projeto: CLINICORE
-- Data: 2026-04-09
-- Descrição: Registra latência ponta-a-ponta de cada interação
--            WhatsApp da Lara (por clínica, por etapa).
-- ============================================================

CREATE TABLE IF NOT EXISTS lara_latency_log (
  id BIGSERIAL PRIMARY KEY,
  clinic_id UUID REFERENCES clinics(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Identificação
  whatsapp_message_id VARCHAR(100),
  conversation_stage VARCHAR(50),

  -- Latências por etapa (ms)
  total_latency_ms INTEGER NOT NULL,
  webhook_to_processing_ms INTEGER,
  context_load_ms INTEGER,
  openai_total_ms INTEGER,
  whatsapp_send_ms INTEGER,

  -- Resultado
  success BOOLEAN NOT NULL DEFAULT TRUE,
  error_stage VARCHAR(50),

  -- Quantas chamadas OpenAI esta interação fez
  openai_calls_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_lara_latency_clinic_date ON lara_latency_log(clinic_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lara_latency_date ON lara_latency_log(created_at DESC);

ALTER TABLE lara_latency_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "clinics_see_own_latency_logs" ON lara_latency_log;
CREATE POLICY "clinics_see_own_latency_logs" ON lara_latency_log
  FOR SELECT
  USING (clinic_id::text = current_setting('app.current_clinic_id', true));

COMMENT ON TABLE lara_latency_log IS 'Latência ponta-a-ponta de cada interação WhatsApp da Lara, por clínica.';

-- -------------------------------------------------------
-- Verificações pós-migration
-- -------------------------------------------------------
-- SELECT table_name FROM information_schema.tables WHERE table_name = 'lara_latency_log';
-- SELECT tablename, rowsecurity FROM pg_tables WHERE tablename = 'lara_latency_log';
