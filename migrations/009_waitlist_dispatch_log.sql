-- Migration 009: waitlist_dispatch_log + no-show risk columns
-- CLINICORE | Latency + No-Show Prediction + Waitlist Dispatch

-- ============================================================
-- 1. Tabela de log de disparos para lista de espera
-- ============================================================
CREATE TABLE IF NOT EXISTS waitlist_dispatch_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id           UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  appointment_id      UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  waitlist_entry_id   UUID NOT NULL REFERENCES clinic_waitlist(id) ON DELETE CASCADE,
  dispatched_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  message_sent        TEXT,
  response            TEXT CHECK (response IN ('interested', 'declined', 'no_response', NULL)),
  resulted_in_booking BOOLEAN DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_log_appointment
  ON waitlist_dispatch_log(appointment_id);

CREATE INDEX IF NOT EXISTS idx_dispatch_log_clinic_date
  ON waitlist_dispatch_log(clinic_id, dispatched_at DESC);

-- ============================================================
-- 2. Colunas de no-show risk em appointments
-- ============================================================
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS noshowrisk_score INTEGER DEFAULT NULL
    CHECK (noshowrisk_score >= 0 AND noshowrisk_score <= 100),
  ADD COLUMN IF NOT EXISTS noshowrisk_label TEXT DEFAULT NULL
    CHECK (noshowrisk_label IN ('ALTO', 'MEDIO', 'BAIXO')),
  ADD COLUMN IF NOT EXISTS noshowrisk_calculated_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_appointments_noshowrisk
  ON appointments(clinic_id, appointment_date, noshowrisk_score DESC)
  WHERE noshowrisk_score IS NOT NULL;

-- ============================================================
-- 3. Índice em clinic_kb(clinic_id) — melhora busca RAG
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_clinic_kb_clinic_id
  ON clinic_kb(clinic_id);

-- ============================================================
-- 4. Remover índices duplicados de conversation_state
-- (manter os com nome mais descritivo)
-- ============================================================
DROP INDEX IF EXISTS idx_conv_state_lookup;
DROP INDEX IF EXISTS idx_conv_state_expires;
