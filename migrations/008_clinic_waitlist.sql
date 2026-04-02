-- Migration 008: clinic_waitlist — Lista de espera / encaixe
-- Criado para suportar o fluxo de lista de espera da Lara quando não há horários disponíveis

CREATE TABLE IF NOT EXISTS clinic_waitlist (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id        UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id       UUID REFERENCES patients(id) ON DELETE SET NULL,
  patient_name     TEXT NOT NULL,
  patient_phone    TEXT NOT NULL,
  doctor_id        UUID REFERENCES doctors(id) ON DELETE SET NULL,
  specialty        TEXT,
  preferred_dates  TEXT[],          -- datas de preferência do paciente (array de strings)
  preferred_period TEXT             -- 'manha', 'tarde', 'qualquer'
                     CHECK (preferred_period IN ('manha', 'tarde', 'qualquer')),
  notes            TEXT,
  status           TEXT NOT NULL DEFAULT 'waiting'
                     CHECK (status IN ('waiting', 'contacted', 'scheduled', 'cancelled')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índice para busca rápida por clínica e status
CREATE INDEX IF NOT EXISTS idx_clinic_waitlist_clinic_status
  ON clinic_waitlist (clinic_id, status, created_at DESC);

-- Row Level Security
ALTER TABLE clinic_waitlist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "clinic_waitlist_clinic_isolation" ON clinic_waitlist
  USING (clinic_id = current_setting('app.clinic_id', true)::uuid);

-- Trigger para atualizar updated_at automaticamente
CREATE OR REPLACE FUNCTION update_clinic_waitlist_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_clinic_waitlist_updated_at ON clinic_waitlist;
CREATE TRIGGER trg_clinic_waitlist_updated_at
  BEFORE UPDATE ON clinic_waitlist
  FOR EACH ROW EXECUTE FUNCTION update_clinic_waitlist_updated_at();
