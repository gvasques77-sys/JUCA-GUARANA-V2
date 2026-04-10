// lib/latencyTracker.js
// Helper de medição de latência ponta-a-ponta da Lara.
// Uso:
//   const tracker = createLatencyTracker(clinicId, correlationId);
//   tracker.mark('context_loaded');
//   tracker.incrementOpenAI();
//   tracker.finish(true);  // success
//
// REGRAS:
// - Fire-and-forget na gravação — falha NUNCA bloqueia a resposta
// - NÃO armazena conteúdo de mensagens (LGPD)
//
// Sprint 0 — Observabilidade

import { createClient } from '@supabase/supabase-js';

// Lazy supabase client
let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  _supabase = createClient(
    process.env.SUPABASE_URL || 'missing',
    process.env.SUPABASE_SERVICE_ROLE_KEY || 'missing',
    { auth: { persistSession: false } }
  );
  return _supabase;
}

/**
 * Cria um rastreador de latência para uma interação da Lara.
 *
 * @param {string} clinicId - UUID da clínica (OBRIGATÓRIO)
 * @param {string} [whatsappMessageId] - ID da mensagem WhatsApp / correlation_id
 * @returns {object} tracker com mark/finish/incrementOpenAI
 */
export function createLatencyTracker(clinicId, whatsappMessageId) {
  const startedAt = Date.now();
  const marks = { start: startedAt };
  let openaiCallsCount = 0;
  let finished = false;

  return {
    /**
     * Registra o timestamp de uma etapa.
     * Stages esperados: 'context_loaded', 'openai_done', 'whatsapp_sent'
     */
    mark(stage) {
      if (!stage) return;
      marks[stage] = Date.now();
    },

    /**
     * Incrementa o contador de chamadas OpenAI desta interação.
     */
    incrementOpenAI() {
      openaiCallsCount++;
    },

    /**
     * Retorna a duração atual (ms) desde o início.
     */
    elapsed() {
      return Date.now() - startedAt;
    },

    /**
     * Finaliza o rastreador e grava o registro fire-and-forget.
     * Só grava uma vez — chamadas subsequentes viram no-op.
     *
     * @param {boolean} success
     * @param {object} [opts]
     * @param {string} [opts.errorStage] - etapa onde o erro ocorreu
     * @param {string} [opts.conversationStage] - estado da conversa (ex: BOOKING_ACTIVE)
     */
    finish(success, opts = {}) {
      if (finished) return;
      finished = true;

      if (!clinicId) {
        // Sem clinic_id não registramos — multi-tenancy obrigatória
        console.warn('[latencyTracker] finish chamado sem clinic_id — ignorando registro');
        return;
      }

      const now = Date.now();
      marks.finish = now;
      const totalLatencyMs = now - startedAt;

      // Calcular deltas por etapa
      const contextLoadMs = marks.context_loaded ? marks.context_loaded - startedAt : null;
      const openaiTotalMs = marks.openai_done && marks.context_loaded
        ? marks.openai_done - marks.context_loaded
        : (marks.openai_done ? marks.openai_done - startedAt : null);
      const whatsappSendMs = marks.whatsapp_sent && marks.openai_done
        ? marks.whatsapp_sent - marks.openai_done
        : null;

      const record = {
        clinic_id: clinicId,
        whatsapp_message_id: whatsappMessageId || null,
        conversation_stage: opts.conversationStage || null,
        total_latency_ms: totalLatencyMs,
        webhook_to_processing_ms: null, // reservado — webhook recebe antes de criar o tracker
        context_load_ms: contextLoadMs,
        openai_total_ms: openaiTotalMs,
        whatsapp_send_ms: whatsappSendMs,
        success: !!success,
        error_stage: success ? null : (opts.errorStage || null),
        openai_calls_count: openaiCallsCount,
      };

      try {
        getSupabase()
          .from('lara_latency_log')
          .insert(record)
          .then(({ error }) => {
            if (error) {
              console.error('[latencyTracker] insert failed:', error.message);
            }
          });
      } catch (e) {
        console.error('[latencyTracker] insert exception:', e?.message);
      }
    },
  };
}
