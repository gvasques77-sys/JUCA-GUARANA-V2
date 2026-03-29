-- ============================================================
-- MIGRATION 005: GV Backoffice Foundation
-- Projeto: CLINICORE
-- Data: 2026-03-29
-- Descrição: Tabelas base para o backoffice GV AUTOMAÇÕES
-- ============================================================

-- -------------------------------------------------------
-- Tabela: gv_admins
-- Usuários do backoffice GV (superadmins da plataforma)
-- SEPARADA de auth.users das clínicas
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS gv_admins (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'admin'
                  CHECK (role IN ('superadmin', 'admin', 'viewer')),
  is_active       BOOLEAN NOT NULL DEFAULT true,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índice para lookup por email (login)
CREATE INDEX IF NOT EXISTS idx_gv_admins_email ON gv_admins(email);

-- Trigger de updated_at
CREATE OR REPLACE TRIGGER trg_gv_admins_updated_at
  BEFORE UPDATE ON gv_admins
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS: tabela acessível apenas via service_role (backend)
ALTER TABLE gv_admins ENABLE ROW LEVEL SECURITY;
-- Nenhuma policy pública — acesso somente via service key no backend

-- -------------------------------------------------------
-- Tabela: clinic_billing_config
-- Configuração de cobrança por clínica (base para F8C)
-- Criada agora para evitar migration futura com ALTER TABLE
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinic_billing_config (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id                    UUID UNIQUE NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  asaas_customer_id            TEXT,
  plan                         TEXT NOT NULL DEFAULT 'starter'
                               CHECK (plan IN ('starter', 'pro', 'enterprise')),
  monthly_fee                  NUMERIC(10,2) NOT NULL DEFAULT 0,
  price_per_1k_tokens_input    NUMERIC(10,6) NOT NULL DEFAULT 0,
  price_per_1k_tokens_output   NUMERIC(10,6) NOT NULL DEFAULT 0,
  price_per_template           NUMERIC(10,4) NOT NULL DEFAULT 0,
  billing_day                  INTEGER NOT NULL DEFAULT 1
                               CHECK (billing_day BETWEEN 1 AND 28),
  is_active                    BOOLEAN NOT NULL DEFAULT true,
  notes                        TEXT,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE TRIGGER trg_clinic_billing_config_updated_at
  BEFORE UPDATE ON clinic_billing_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE clinic_billing_config ENABLE ROW LEVEL SECURITY;
-- Sem policy pública — somente backend com service key

-- -------------------------------------------------------
-- Tabela: system_alerts
-- Alertas da plataforma (erros, warnings, infos)
-- -------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_alerts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type      TEXT NOT NULL CHECK (alert_type IN ('error', 'warning', 'info')),
  source          TEXT NOT NULL CHECK (source IN ('railway', 'openai', 'meta', 'supabase', 'internal')),
  clinic_id       UUID REFERENCES clinics(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  message         TEXT NOT NULL,
  metadata        JSONB,
  is_resolved     BOOLEAN NOT NULL DEFAULT false,
  resolved_at     TIMESTAMPTZ,
  resolved_by     UUID REFERENCES gv_admins(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_system_alerts_is_resolved ON system_alerts(is_resolved);
CREATE INDEX IF NOT EXISTS idx_system_alerts_clinic_id ON system_alerts(clinic_id);
CREATE INDEX IF NOT EXISTS idx_system_alerts_created_at ON system_alerts(created_at DESC);

ALTER TABLE system_alerts ENABLE ROW LEVEL SECURITY;

-- -------------------------------------------------------
-- Inserir primeiro superadmin GV
-- ATENÇÃO: trocar o hash antes de executar!
-- Gerar hash bcrypt do password desejado com rounds=12
-- Comando: node -e "import('bcrypt').then(b=>b.default.hash('SUA_SENHA',12).then(h=>console.log(h)))"
-- -------------------------------------------------------
INSERT INTO gv_admins (email, password_hash, name, role)
VALUES (
  'gabriel@gvautomacoes.com.br',
  '$2b$12$SUBSTITUIR_PELO_HASH_REAL_GERADO_COM_BCRYPT',
  'Gabriel',
  'superadmin'
)
ON CONFLICT (email) DO NOTHING;

-- -------------------------------------------------------
-- Verificações pós-migration
-- -------------------------------------------------------
-- SELECT table_name FROM information_schema.tables WHERE table_name IN ('gv_admins','clinic_billing_config','system_alerts');
-- SELECT id, email, role, is_active FROM gv_admins;
-- SELECT tablename, rowsecurity FROM pg_tables WHERE tablename IN ('gv_admins','clinic_billing_config','system_alerts');
