-- Migration 007: Adiciona filtro de lead score nas campanhas
-- Executar no Supabase SQL Editor

-- Adiciona coluna de score mínimo na tabela de campanhas
ALTER TABLE crm_campaigns
  ADD COLUMN IF NOT EXISTS min_lead_score INTEGER DEFAULT 0
    CHECK (min_lead_score >= 0 AND min_lead_score <= 100);

-- Adiciona coluna de label de score mínimo (para referência visual)
ALTER TABLE crm_campaigns
  ADD COLUMN IF NOT EXISTS min_score_label TEXT
    CHECK (min_score_label IN ('QUENTE', 'MORNO', 'FRIO', 'INATIVO', NULL));

-- Índice para facilitar consultas de pacientes elegíveis por score
CREATE INDEX IF NOT EXISTS idx_patient_projection_lead_score
  ON patient_crm_projection(clinic_id, lead_score DESC);

COMMENT ON COLUMN crm_campaigns.min_lead_score IS
  'Score mínimo para paciente ser elegível para a campanha (0 = sem filtro)';
COMMENT ON COLUMN crm_campaigns.min_score_label IS
  'Label semântico do score mínimo (QUENTE/MORNO/FRIO/INATIVO)';
