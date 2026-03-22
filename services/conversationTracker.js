// services/conversationTracker.js
// Gerencia o ciclo de vida da tabela 'conversations'.
// Funções puras que recebem o client Supabase como parâmetro.

/**
 * Busca uma conversa aberta (status='open') para este clinic_id + phone.
 * Se não existir, cria uma nova.
 * Retorna o objeto da conversa (id, started_at, total_turns, etc).
 */
async function getOrCreateConversation(supabase, clinicId, patientPhone, conversationStateId = null) {
  // Usar RPC get_or_create_open_conversation: atômico via INSERT ON CONFLICT DO NOTHING.
  // Elimina TOCTOU onde dois requests simultâneos para usuário novo ambos faziam SELECT
  // (encontravam null) e ambos tentavam INSERT, criando duas conversas.
  try {
    const { data: rows, error: rpcError } = await supabase
      .rpc('get_or_create_open_conversation', {
        p_clinic_id:             clinicId,
        p_patient_phone:         patientPhone,
        p_conversation_state_id: conversationStateId,
      });

    if (!rpcError && rows && rows.length > 0) {
      const conv = rows[0];
      console.log(`[ConversationTracker] Conversa via RPC: ${conv.id}`);
      return conv;
    }

    // RPC não existe ainda (migration pendente) → fallback com tratamento de 23505
    if (rpcError) {
      console.warn('[ConversationTracker] RPC get_or_create_open_conversation indisponível — usando fallback:', rpcError.message);
    }
  } catch (rpcEx) {
    console.warn('[ConversationTracker] Exceção na RPC — usando fallback:', rpcEx.message);
  }

  // Fallback: SELECT + INSERT com captura de 23505 (unique_violation)
  const { data: existing } = await supabase
    .from('conversations')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('patient_phone', patientPhone)
    .eq('status', 'open')
    .maybeSingle();

  if (existing) return existing;

  const { data: created, error: createError } = await supabase
    .from('conversations')
    .insert({
      clinic_id: clinicId,
      patient_phone: patientPhone,
      conversation_state_id: conversationStateId,
      channel: 'whatsapp',
      status: 'open',
      total_turns: 0,
      total_messages_user: 0,
      total_messages_agent: 0,
      total_tokens_input: 0,
      total_tokens_output: 0,
      total_cost_estimated: 0,
    })
    .select()
    .single();

  if (createError) {
    if (createError.code === '23505') {
      // Outro request venceu a corrida — buscar a conversa que ele criou
      const { data: raceWinner } = await supabase
        .from('conversations')
        .select('*')
        .eq('clinic_id', clinicId)
        .eq('patient_phone', patientPhone)
        .eq('status', 'open')
        .maybeSingle();
      console.log(`[ConversationTracker] Race condition resolvida — conversa: ${raceWinner?.id}`);
      return raceWinner || null;
    }
    console.error('[ConversationTracker] Erro ao criar conversa:', createError.message);
    return null;
  }

  console.log(`[ConversationTracker] Nova conversa criada: ${created.id}`);
  return created;
}

/**
 * Atualiza métricas incrementais da conversa após cada turno.
 * Chamada após cada resposta do agente.
 *
 * @param {object} supabase - Client Supabase
 * @param {string} conversationId - UUID da conversa
 * @param {object} turnData - Dados do turno:
 *   - tokensInput: number (tokens de entrada da chamada OpenAI)
 *   - tokensOutput: number (tokens de saída da chamada OpenAI)
 *   - costEstimated: number (custo estimado em USD)
 */
async function updateConversationTurn(supabase, conversationId, turnData = {}) {
  const { tokensInput = 0, tokensOutput = 0, costEstimated = 0 } = turnData;

  const { error } = await supabase.rpc('increment_conversation_turn', {
    p_conversation_id: conversationId,
    p_tokens_input: tokensInput,
    p_tokens_output: tokensOutput,
    p_cost_estimated: costEstimated,
  });

  if (error) {
    // Fallback: buscar valores atuais e incrementar (RPC increment_conversation_turn não existe ainda)
    console.warn('[ConversationTracker] RPC falhou, usando fallback com leitura prévia:', error.message);

    const { data: current, error: fetchErr } = await supabase
      .from('conversations')
      .select('total_turns, total_messages_user, total_messages_agent, total_tokens_input, total_tokens_output, total_cost_estimated')
      .eq('id', conversationId)
      .single();

    if (fetchErr) {
      console.error('[ConversationTracker] Erro ao buscar conversa para fallback:', fetchErr.message);
      return;
    }

    const { error: updateError } = await supabase
      .from('conversations')
      .update({
        total_turns:          (current.total_turns          || 0) + 1,
        total_messages_user:  (current.total_messages_user  || 0) + 1,
        total_messages_agent: (current.total_messages_agent || 0) + 1,
        total_tokens_input:   (current.total_tokens_input   || 0) + tokensInput,
        total_tokens_output:  (current.total_tokens_output  || 0) + tokensOutput,
        total_cost_estimated: (current.total_cost_estimated || 0) + costEstimated,
      })
      .eq('id', conversationId);

    if (updateError) {
      console.error('[ConversationTracker] Erro no fallback direto:', updateError.message);
    }
  }
}

/**
 * Finaliza uma conversa com o resultado.
 * Chamada quando: agendamento concluído, paciente abandona, erro, ou escalonamento.
 *
 * @param {object} supabase - Client Supabase
 * @param {string} conversationId - UUID da conversa
 * @param {string} status - 'completed' | 'abandoned' | 'escalated_human' | 'error'
 * @param {string} finalOutcome - 'booked' | 'rescheduled' | 'cancelled' | 'info_provided' | 'human_requested' | 'abandoned' | 'no_answer' | 'error'
 * @param {string|null} appointmentId - UUID do appointment criado (se houver)
 * @param {string|null} patientId - UUID do paciente (se identificado)
 */
async function finalizeConversation(supabase, conversationId, status, finalOutcome, appointmentId = null, patientId = null) {
  const updateData = {
    status,
    final_outcome: finalOutcome,
    ended_at: new Date().toISOString(),
  };

  if (appointmentId) {
    updateData.appointment_id = appointmentId;
  }
  if (patientId) {
    updateData.patient_id = patientId;
  }

  // Calcular duração
  const { data: conv } = await supabase
    .from('conversations')
    .select('started_at')
    .eq('id', conversationId)
    .single();

  if (conv) {
    const durationMs = Date.now() - new Date(conv.started_at).getTime();
    updateData.duration_seconds = Math.round(durationMs / 1000);
  }

  const { error } = await supabase
    .from('conversations')
    .update(updateData)
    .eq('id', conversationId);

  if (error) {
    console.error('[ConversationTracker] Erro ao finalizar conversa:', error.message);
  } else {
    console.log(`[ConversationTracker] Conversa ${conversationId} finalizada: ${status} / ${finalOutcome}`);
  }
}

export {
  getOrCreateConversation,
  updateConversationTurn,
  finalizeConversation,
};
