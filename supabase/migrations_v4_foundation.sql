-- =======================================================
-- CLINICORE — Migração v4: Foundation Fixes
-- Data: 2026-03-22
-- Executar no Supabase SQL Editor
-- =======================================================

-- =======================================================
-- PARTE 1: Tabela inbound_dedup
-- Deduplicação nativa de mensagens WhatsApp por wamid.
-- INSERT ON CONFLICT DO NOTHING garante idempotência atômica.
-- =======================================================

CREATE TABLE IF NOT EXISTS public.inbound_dedup (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     UUID        NOT NULL REFERENCES public.clinic_settings(clinic_id) ON DELETE CASCADE,
  wa_message_id TEXT        NOT NULL,
  received_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(clinic_id, wa_message_id)
);

-- Índice para limpeza periódica (manter apenas últimas 48h)
CREATE INDEX IF NOT EXISTS idx_inbound_dedup_received_at
  ON public.inbound_dedup(received_at);

-- RLS
ALTER TABLE public.inbound_dedup ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "inbound_dedup_isolation" ON public.inbound_dedup;
CREATE POLICY "inbound_dedup_isolation"
  ON public.inbound_dedup FOR ALL
  USING (
    auth.role() = 'service_role'
    OR clinic_id = (current_setting('app.clinic_id', true))::uuid
  );

-- =======================================================
-- PARTE 2: Correção do try_acquire_processing_lock
--
-- BUG ORIGINAL: Para novos usuários, dois requests simultâneos:
--   1) Ambos fazem UPDATE → 0 linhas afetadas (row não existe)
--   2) Ambos verificam NOT EXISTS → ambos encontram ausência
--   3) Ambos retornam TRUE → race condition passa sem proteção
--
-- FIX: INSERT ... ON CONFLICT atomicamente garante que apenas
-- um dos requests simultâneos cria a linha. O segundo cai no
-- ON CONFLICT e verifica o cooldown (que não passou → FALSE).
-- =======================================================

CREATE OR REPLACE FUNCTION try_acquire_processing_lock(
  p_clinic_id       UUID,
  p_from_number     TEXT,
  p_cooldown_seconds INT DEFAULT 10
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_rows_affected INT;
BEGIN
  -- Tenta INSERIR (novo usuário) OU ATUALIZAR (usuário existente com cooldown expirado).
  -- Para novo usuário: INSERT bem-sucedido → ROW_COUNT = 1 → retorna TRUE.
  -- Para dois requests simultâneos de novo usuário: apenas um INSERT vence;
  --   o segundo cai no ON CONFLICT e tenta UPDATE → cooldown não passou → ROW_COUNT = 0 → FALSE.
  -- Para usuário existente: UPDATE condicional (só atualiza se cooldown passou).
  INSERT INTO conversation_state (clinic_id, from_number, state_json)
  VALUES (
    p_clinic_id,
    p_from_number,
    jsonb_build_object('last_processed_at', NOW()::TEXT)
  )
  ON CONFLICT (clinic_id, from_number) DO UPDATE
    SET state_json = jsonb_set(
        COALESCE(conversation_state.state_json, '{}'::jsonb),
        '{last_processed_at}',
        to_jsonb(NOW()::TEXT)
      )
  WHERE (
    conversation_state.state_json->>'last_processed_at' IS NULL
    OR (NOW() - (conversation_state.state_json->>'last_processed_at')::TIMESTAMPTZ) >
        (p_cooldown_seconds || ' seconds')::INTERVAL
  );

  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  RETURN v_rows_affected > 0;
END;
$$;

-- =======================================================
-- PARTE 3: merge_conversation_state — atualização atômica de JSONB
--
-- Substitui o padrão read-modify-write do Node.js:
--   const { data } = await supabase.select('state_json') ...
--   await supabase.update({ state_json: { ...old, ...updates } }) ...
--
-- Dois requests simultâneos sobrescreviam o estado um do outro.
-- Esta função faz o merge atomicamente no banco com JSONB ||.
-- =======================================================

CREATE OR REPLACE FUNCTION merge_conversation_state(
  p_clinic_id   UUID,
  p_from_number TEXT,
  p_updates     JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_new_state JSONB;
BEGIN
  UPDATE conversation_state
  SET
    state_json = COALESCE(state_json, '{}'::jsonb)
                 || p_updates
                 || jsonb_build_object('last_activity_at', NOW()::TEXT),
    updated_at = NOW(),
    expires_at = NOW() + INTERVAL '24 hours'
  WHERE
    clinic_id   = p_clinic_id
    AND from_number = p_from_number
  RETURNING state_json INTO v_new_state;

  RETURN v_new_state;
END;
$$;

-- =======================================================
-- PARTE 4: increment_conversation_turn — RPC para conversationTracker.js
--
-- Incrementa contadores da tabela conversations atomicamente.
-- Substitui o UPDATE com undefined que era no-op no fallback.
-- =======================================================

CREATE OR REPLACE FUNCTION increment_conversation_turn(
  p_conversation_id UUID,
  p_tokens_input    INT     DEFAULT 0,
  p_tokens_output   INT     DEFAULT 0,
  p_cost_estimated  NUMERIC DEFAULT 0
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE conversations
  SET
    total_turns          = COALESCE(total_turns, 0)          + 1,
    total_messages_user  = COALESCE(total_messages_user, 0)  + 1,
    total_messages_agent = COALESCE(total_messages_agent, 0) + 1,
    total_tokens_input   = COALESCE(total_tokens_input, 0)   + p_tokens_input,
    total_tokens_output  = COALESCE(total_tokens_output, 0)  + p_tokens_output,
    total_cost_estimated = COALESCE(total_cost_estimated, 0) + p_cost_estimated
  WHERE id = p_conversation_id;
END;
$$;

-- =======================================================
-- PARTE 5: Índice em conversation_history para dedup por correlation_id
-- Evita duplicatas na tabela de histórico.
-- =======================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_history_correlation_id
  ON public.conversation_history(clinic_id, correlation_id)
  WHERE correlation_id IS NOT NULL;

-- =======================================================
-- PARTE 6: Limpeza automática da inbound_dedup (>48h)
-- =======================================================
-- Agendar via pg_cron (se disponível no Supabase):
-- SELECT cron.schedule('cleanup-inbound-dedup', '0 */6 * * *',
--   $$DELETE FROM public.inbound_dedup WHERE received_at < NOW() - INTERVAL '48 hours'$$);

-- =======================================================
-- PARTE 7: Constraint anti double-booking em appointments
--
-- Impede dois agendamentos no mesmo (clinic_id, doctor_id, date, start_time)
-- enquanto pelo menos um não estiver cancelado.
-- É um índice parcial (WHERE) — o único jeito de fazer UNIQUE condicional no PostgreSQL.
--
-- O backend já captura createError.code === '23505' e retorna:
--   "Este horário acabou de ser reservado."
-- Sem esta constraint, o código nunca chegava ao catch 23505.
-- =======================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_no_double_booking
  ON public.appointments(clinic_id, doctor_id, appointment_date, start_time)
  WHERE status NOT IN ('cancelled', 'no_show');

-- =======================================================
-- PARTE 8: Constraint + função para getOrCreateConversation atômico
--
-- Permite usar INSERT ON CONFLICT para eliminar TOCTOU
-- (SELECT → INSERT que cria 2 conversas simultâneas para usuário novo).
-- =======================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_open_per_phone
  ON public.conversations(clinic_id, patient_phone)
  WHERE status = 'open';

-- Função auxiliar: upsert atômico de conversa aberta.
-- Substitui o pattern SELECT maybeSingle + INSERT em conversationTracker.js.
CREATE OR REPLACE FUNCTION get_or_create_open_conversation(
  p_clinic_id              UUID,
  p_patient_phone          TEXT,
  p_conversation_state_id  UUID DEFAULT NULL
)
RETURNS SETOF conversations
LANGUAGE plpgsql
AS $$
BEGIN
  -- Tenta inserir. Se já existe (status=open), ON CONFLICT não faz nada.
  INSERT INTO conversations (
    clinic_id, patient_phone, conversation_state_id,
    channel, status,
    total_turns, total_messages_user, total_messages_agent,
    total_tokens_input, total_tokens_output, total_cost_estimated
  )
  VALUES (
    p_clinic_id, p_patient_phone, p_conversation_state_id,
    'whatsapp', 'open',
    0, 0, 0, 0, 0, 0
  )
  ON CONFLICT (clinic_id, patient_phone)
  WHERE status = 'open'
  DO NOTHING;

  -- Retorna a linha (seja a recém-inserida ou a que já existia)
  RETURN QUERY
    SELECT * FROM conversations
    WHERE clinic_id    = p_clinic_id
      AND patient_phone = p_patient_phone
      AND status        = 'open'
    LIMIT 1;
END;
$$;

-- =======================================================
-- VERIFICAÇÃO PÓS-MIGRAÇÃO
-- =======================================================
-- SELECT 'inbound_dedup' AS tabela, COUNT(*) FROM public.inbound_dedup;
-- SELECT proname FROM pg_proc WHERE proname IN (
--   'try_acquire_processing_lock', 'merge_conversation_state',
--   'increment_conversation_turn', 'get_or_create_open_conversation'
-- );
-- -- Confirmar índice anti double-booking:
-- SELECT indexname FROM pg_indexes WHERE tablename = 'appointments'
--   AND indexname = 'idx_appointments_no_double_booking';
