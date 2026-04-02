/**
 * CRM V2 Service — Módulo Event-Centric para CLINICORE
 *
 * Arquitetura: Eventos imutáveis → Projeções derivadas → Tarefas
 *
 * REGRAS ABSOLUTAS:
 * - NUNCA faz throw — se falhar, retorna { success: false }
 * - Toda inserção usa ON CONFLICT DO NOTHING (idempotência)
 * - Prefixo [CRM] em todos os logs
 * - Recebe supabase client como parâmetro (não cria instância própria)
 *
 * EXCEÇÃO: startScoreDecayJob usa cliente próprio com service_role_key
 * pois roda como scheduler periódico sem contexto de request.
 */

import { createClient } from '@supabase/supabase-js';

// Cliente dedicado para o decay job (service_role_key — bypass RLS)
const _sbDecay = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ======================================================
// CATÁLOGO DE EVENTOS (referência — usado para validação)
// ======================================================
const VALID_EVENT_TYPES = [
  'first_contact',
  'triage_started',
  'intent_detected',
  'booking_requested',
  'booking_created',
  'booking_confirmed',
  'booking_canceled',
  'appointment_completed',
  'no_show',
  'follow_up_created',
  'follow_up_completed',
  'reactivation_started',
  'returning_patient_detected',
  'conversation_ended',
  'info_requested',
  'note_added',
  'tag_added',
  'stage_override',
];

// ======================================================
// CATÁLOGO DE TIPOS DE TAREFAS
// ======================================================
const VALID_TASK_TYPES = [
  'reminder_24h',
  'post_consultation',
  'reactivation',
  'no_show_recovery',
  'booking_confirmation',
  'custom',
];

// ======================================================
// 1. emitEvent — Função FUNDAMENTAL do CRM V2
// ======================================================

/**
 * Registra um evento imutável no CRM.
 * Toda ação relevante do paciente se torna um evento.
 * Idempotente: duplicatas são ignoradas silenciosamente.
 *
 * @param {object} supabase - Cliente Supabase
 * @param {string} clinicId - UUID da clínica
 * @param {string} patientId - UUID do paciente
 * @param {string} eventType - Tipo do evento (do catálogo)
 * @param {object} options - Opções adicionais
 * @param {string} [options.conversationId] - UUID da conversa
 * @param {string} [options.appointmentId] - UUID do agendamento
 * @param {string} [options.sourceSystem='agent'] - Sistema de origem
 * @param {string} [options.sourceReference] - Referência de origem
 * @param {string} [options.idempotencyQualifier] - Qualificador da chave de idempotência
 * @param {object} [options.payload={}] - Dados adicionais do evento
 * @returns {Promise<{success: boolean, eventId?: string, deduplicated?: boolean, error?: string}>}
 */
async function emitEvent(supabase, clinicId, patientId, eventType, options = {}) {
  try {
    // Validar event_type contra o catálogo
    if (!VALID_EVENT_TYPES.includes(eventType)) {
      console.warn(`[CRM] event_type desconhecido: '${eventType}' — registrando mesmo assim`);
    }

    const {
      conversationId = null,
      appointmentId = null,
      sourceSystem = 'agent',
      sourceReference = null,
      idempotencyQualifier = null,
      payload = {},
    } = options;

    // Montar chave de idempotência
    // Formato: event_type:clinic_id:qualifier
    const qualifier = idempotencyQualifier || patientId;
    const idempotencyKey = `${eventType}:${clinicId}:${qualifier}`;

    // Inserir evento — ON CONFLICT ignora duplicatas
    const { data, error } = await supabase
      .from('crm_events')
      .insert({
        clinic_id: clinicId,
        patient_id: patientId,
        conversation_id: conversationId,
        appointment_id: appointmentId,
        event_type: eventType,
        source_system: sourceSystem,
        source_reference: sourceReference,
        idempotency_key: idempotencyKey,
        occurred_at: new Date().toISOString(),
        payload: payload,
      })
      .select('id');

    // Verificar se é duplicata (unique_violation = código 23505)
    if (error) {
      if (error.code === '23505') {
        console.log(`[CRM] Evento deduplicado: ${eventType} (key: ${idempotencyKey})`);
        return { success: true, deduplicated: true };
      }
      console.error(`[CRM] Erro ao inserir evento ${eventType}:`, error.message);
      return { success: false, error: error.message };
    }

    const eventId = data?.[0]?.id || null;
    console.log(`[CRM] Evento registrado: ${eventType} (id: ${eventId})`);

    // Recalcular projeção do paciente a partir dos eventos
    try {
      await supabase.rpc('fn_recalculate_patient_projection', {
        p_patient_id: patientId,
      });
      console.log(`[CRM] Projeção recalculada para patient_id: ${patientId}`);
    } catch (rpcErr) {
      // Falha no recálculo não invalida o evento já registrado
      console.error(`[CRM] Erro ao recalcular projeção:`, rpcErr.message);
    }

    return { success: true, eventId, deduplicated: false };
  } catch (error) {
    console.error(`[CRM] Erro em emitEvent (${eventType}):`, error.message);
    return { success: false, error: error.message };
  }
}

// ======================================================
// 2. scheduleTask — Agendar tarefa com idempotência
// ======================================================

/**
 * Cria uma tarefa no CRM (follow-up, lembrete, reativação, etc.).
 * Idempotente: duplicatas são ignoradas silenciosamente.
 *
 * @param {object} supabase - Cliente Supabase
 * @param {string} clinicId - UUID da clínica
 * @param {string} patientId - UUID do paciente
 * @param {string} taskType - Tipo da tarefa (do catálogo)
 * @param {string|Date} dueAt - Data/hora de execução
 * @param {object} options - Opções adicionais
 * @param {string} [options.reason] - Motivo da tarefa
 * @param {string} [options.sourceEventId] - UUID do evento que gerou a tarefa
 * @param {string} [options.messageTemplate] - Template de mensagem para envio
 * @param {string} [options.idempotencyQualifier] - Qualificador da chave
 * @returns {Promise<{success: boolean, taskId?: string, deduplicated?: boolean, error?: string}>}
 */
async function scheduleTask(supabase, clinicId, patientId, taskType, dueAt, options = {}) {
  try {
    // Validar task_type
    if (!VALID_TASK_TYPES.includes(taskType)) {
      console.warn(`[CRM] task_type desconhecido: '${taskType}' — registrando mesmo assim`);
    }

    const {
      reason = null,
      sourceEventId = null,
      messageTemplate = null,
      idempotencyQualifier = null,
    } = options;

    // Normalizar dueAt para ISO string
    const dueAtIso = dueAt instanceof Date ? dueAt.toISOString() : dueAt;
    const dueAtDatePart = dueAtIso.split('T')[0];

    // Montar chave de idempotência
    // Formato: task_type:patient_id:qualifier_ou_data
    const qualifier = idempotencyQualifier || dueAtDatePart;
    const idempotencyKey = `${taskType}:${patientId}:${qualifier}`;

    // Inserir tarefa — ON CONFLICT ignora duplicatas
    const { data, error } = await supabase
      .from('crm_tasks')
      .insert({
        clinic_id: clinicId,
        patient_id: patientId,
        task_type: taskType,
        reason: reason,
        due_at: dueAtIso,
        status: 'pending',
        source_event_id: sourceEventId,
        idempotency_key: idempotencyKey,
        message_template: messageTemplate,
      })
      .select('id');

    // Verificar duplicata
    if (error) {
      if (error.code === '23505') {
        console.log(`[CRM] Tarefa deduplicada: ${taskType} (key: ${idempotencyKey})`);
        return { success: true, deduplicated: true };
      }
      console.error(`[CRM] Erro ao inserir tarefa ${taskType}:`, error.message);
      return { success: false, error: error.message };
    }

    const taskId = data?.[0]?.id || null;
    console.log(`[CRM] Tarefa criada: ${taskType} para ${dueAtDatePart} (id: ${taskId})`);

    // Atualizar next_follow_up_at na projeção se esta tarefa é mais próxima
    try {
      const { data: projection } = await supabase
        .from('patient_crm_projection')
        .select('next_follow_up_at')
        .eq('patient_id', patientId)
        .eq('clinic_id', clinicId)
        .single();

      const currentNext = projection?.next_follow_up_at
        ? new Date(projection.next_follow_up_at)
        : null;
      const newDue = new Date(dueAtIso);

      if (!currentNext || newDue < currentNext) {
        await supabase
          .from('patient_crm_projection')
          .update({ next_follow_up_at: dueAtIso, updated_at: new Date().toISOString() })
          .eq('patient_id', patientId)
          .eq('clinic_id', clinicId);
        console.log(`[CRM] next_follow_up_at atualizado para ${dueAtDatePart}`);
      }
    } catch (projErr) {
      // Não crítico — a tarefa já foi criada
      console.warn(`[CRM] Erro ao atualizar next_follow_up_at:`, projErr.message);
    }

    return { success: true, taskId, deduplicated: false };
  } catch (error) {
    console.error(`[CRM] Erro em scheduleTask (${taskType}):`, error.message);
    return { success: false, error: error.message };
  }
}

// ======================================================
// 3. calculateLeadScore — Pontuação do lead
// ======================================================

/**
 * Calcula e atualiza o lead_score do paciente na projeção CRM.
 * Lógica granular por blocos: Agendamentos, Recência, Confiabilidade,
 * Engajamento e Penalidades.
 *
 * @param {object} supabase - Cliente Supabase
 * @param {string} patientId - UUID do paciente
 * @param {string} clinicId - UUID da clínica
 * @returns {Promise<{success: boolean, score?: number, error?: string}>}
 */
async function calculateLeadScore(supabase, patientId, clinicId) {
  try {
    // Única query trazendo event_type e occurred_at
    const { data: events, error: eventsErr } = await supabase
      .from('crm_events')
      .select('event_type, occurred_at')
      .eq('patient_id', patientId)
      .eq('clinic_id', clinicId);

    if (eventsErr) {
      console.error(`[CRM] Erro ao buscar eventos para lead_score:`, eventsErr.message);
      return { success: false, error: eventsErr.message };
    }

    const eventList = events || [];
    const eventTypes = eventList.map(e => e.event_type);
    const eventDates = eventList.map(e => new Date(e.occurred_at));
    const now = new Date();
    let score = 0;

    // ── BLOCO A: Agendamentos (max 35 pontos) ──────────────────────────
    const hasBooking = eventTypes.includes('booking_created') || eventTypes.includes('booking_confirmed');
    const attendedCount = eventTypes.filter(t => t === 'appointment_completed').length;

    let blockA = 0;
    if (hasBooking) blockA += 25;
    if (attendedCount >= 3) blockA += 35;
    else if (attendedCount === 2) blockA += 20;
    else if (attendedCount === 1) blockA += 10;
    score += Math.min(35, blockA);

    // ── BLOCO B: Recência (max 20 pontos) ──────────────────────────────
    if (eventDates.length > 0) {
      const lastEventDate = new Date(Math.max(...eventDates.map(d => d.getTime())));
      const hoursAgo = (now - lastEventDate) / (1000 * 60 * 60);

      if (hoursAgo < 48) score += 20;
      else if (hoursAgo < 7 * 24) score += 12;
      else if (hoursAgo < 14 * 24) score += 6;
      else if (hoursAgo < 30 * 24) score += 2;
      // > 30 dias → +0
    }

    // ── BLOCO C: Confiabilidade / No-show (max 15 pontos) ──────────────
    const noShowCount = eventTypes.filter(t => t === 'no_show').length;
    if (noShowCount === 0) score += 15;
    else if (noShowCount === 1) score += 5;
    // 2+ no-shows → +0

    // ── BLOCO D: Engajamento / Conversas (max 15 pontos) ───────────────
    const engagementCount = eventTypes.filter(t =>
      ['first_contact', 'conversation_ended', 'info_requested', 'booking_requested'].includes(t)
    ).length;
    if (engagementCount >= 6) score += 15;
    else if (engagementCount >= 3) score += 10;
    else if (engagementCount >= 1) score += 5;

    // ── BLOCO E: Penalidades ───────────────────────────────────────────
    if (eventTypes.includes('booking_canceled')) score -= 10;

    // ── FINAL ──────────────────────────────────────────────────────────
    score = Math.max(0, Math.min(100, score));

    // Atualizar na projeção
    const { error: updateErr } = await supabase
      .from('patient_crm_projection')
      .update({ lead_score: score, updated_at: new Date().toISOString() })
      .eq('patient_id', patientId)
      .eq('clinic_id', clinicId);

    if (updateErr) {
      console.error(`[CRM] Erro ao atualizar lead_score:`, updateErr.message);
      return { success: false, error: updateErr.message };
    }

    console.log(`[CRM] Lead score calculado: ${score} (patient_id: ${patientId})`);
    return { success: true, score };
  } catch (error) {
    console.error(`[CRM] Erro em calculateLeadScore:`, error.message);
    return { success: false, error: error.message };
  }
}

// ======================================================
// 3b. getScoreLabel — Label semântico baseado no score
// ======================================================

/**
 * Retorna label semântico, emoji e cor para um dado lead_score.
 *
 * @param {number} score - Valor do lead_score (0-100)
 * @returns {{ label: string, emoji: string, color: string }}
 */
function getScoreLabel(score) {
  if (score >= 70) return { label: 'QUENTE',  emoji: '🔥', color: '#E74C3C' };
  if (score >= 40) return { label: 'MORNO',   emoji: '🟡', color: '#F39C12' };
  if (score >= 15) return { label: 'FRIO',    emoji: '❄️',  color: '#3498DB' };
  return           { label: 'INATIVO', emoji: '💀', color: '#7F8C8D' };
}

// ======================================================
// 3c. startScoreDecayJob — Decaimento temporal de scores
// ======================================================

/**
 * Inicia o job periódico de decaimento de lead_score.
 * Roda a cada 24 horas. Usa cliente próprio com service_role_key.
 * NÃO atualiza updated_at — preserva a data real do último evento.
 */
function startScoreDecayJob() {
  console.log('[DECAY] Score decay job iniciado (intervalo: 24h)');

  setInterval(async () => {
    try {
      console.log('[DECAY] Iniciando score decay...');
      const now = new Date();
      let totalUpdated = 0;
      let offset = 0;
      const batchSize = 100;

      while (true) {
        const { data: records, error } = await _sbDecay
          .from('patient_crm_projection')
          .select('patient_id, clinic_id, lead_score, updated_at')
          .gt('lead_score', 0)
          .range(offset, offset + batchSize - 1);

        if (error) {
          console.error('[DECAY] Erro ao buscar registros:', error.message);
          break;
        }

        if (!records || records.length === 0) break;

        const toUpdate = records
          .map(record => {
            const daysAgo = (now - new Date(record.updated_at)) / (1000 * 60 * 60 * 24);
            let decrement = 0;
            if (daysAgo > 60)      decrement = 30;
            else if (daysAgo >= 31) decrement = 20;
            else if (daysAgo >= 15) decrement = 10;
            else if (daysAgo >= 7)  decrement = 5;
            // < 7 dias → skip
            return { ...record, decrement };
          })
          .filter(r => r.decrement > 0);

        if (toUpdate.length > 0) {
          const results = await Promise.allSettled(
            toUpdate.map(r => {
              const newScore = Math.max(0, r.lead_score - r.decrement);
              return _sbDecay
                .from('patient_crm_projection')
                .update({ lead_score: newScore })
                // NÃO atualiza updated_at — preservar data real do último evento
                .eq('patient_id', r.patient_id)
                .eq('clinic_id', r.clinic_id);
            })
          );

          results.forEach((result, i) => {
            if (result.status === 'rejected') {
              console.error('[DECAY] Erro ao atualizar paciente:', toUpdate[i].patient_id, result.reason);
            }
          });

          totalUpdated += results.filter(r => r.status === 'fulfilled').length;
        }

        offset += batchSize;
        if (records.length < batchSize) break;
      }

      console.log(`[DECAY] Score decay aplicado em ${totalUpdated} pacientes`);
    } catch (err) {
      console.error('[DECAY] Erro no score decay job:', err.message);
    }
  }, 86400000); // 24 horas
}

// ======================================================
// 4. processPostConversation — Orquestrador principal
// ======================================================

/**
 * Função PRINCIPAL chamada após o agente terminar de processar.
 * Orquestra emitEvent e scheduleTask baseado no outcome da conversa.
 * 
 * IMPORTANTE: Esta função é fire-and-forget. Nunca deve bloquear
 * a resposta ao paciente nem derrubar o agente.
 *
 * @param {object} supabase - Cliente Supabase
 * @param {string} patientPhone - Telefone do paciente
 * @param {string} clinicId - UUID da clínica
 * @param {string} conversationOutcome - Outcome: booked, completed, cancelled, no_show, abandoned, info_provided, conversation
 * @param {string|null} conversationId - UUID da conversa (tabela conversations)
 * @param {string|null} appointmentId - UUID do agendamento (se houver)
 * @returns {Promise<{success: boolean, skipped?: boolean, outcome?: string, error?: string}>}
 */
async function processPostConversation(supabase, patientPhone, clinicId, conversationOutcome, conversationId = null, appointmentId = null) {
  try {
    // 1. Buscar patient_id pelo telefone
    const { data: patientData, error: patientErr } = await supabase
      .from('patients')
      .select('id')
      .eq('clinic_id', clinicId)
      .eq('phone', patientPhone)
      .limit(1)
      .single();

    if (patientErr || !patientData) {
      // Paciente não encontrado — não é erro, pode ser um contato novo sem cadastro
      console.log(`[CRM] Paciente não encontrado para phone: ${patientPhone} — pulando CRM hooks`);
      return { success: true, skipped: true, reason: 'patient_not_found' };
    }

    const patientId = patientData.id;
    console.log(`[CRM] processPostConversation: outcome=${conversationOutcome}, patient_id=${patientId}`);

    // 2. Orquestrar por outcome
    switch (conversationOutcome) {
      case 'booked': {
        // Agendamento criado com sucesso
        const eventResult = await emitEvent(supabase, clinicId, patientId, 'booking_created', {
          conversationId,
          appointmentId,
          idempotencyQualifier: appointmentId || conversationId || patientId,
          payload: { outcome: 'booked' },
        });

        // Agendar lembrete 24h antes (se tiver appointmentId, buscar data)
        if (appointmentId) {
          try {
            const { data: appt } = await supabase
              .from('appointments')
              .select('appointment_date, start_time')
              .eq('id', appointmentId)
              .single();

            if (appt?.appointment_date) {
              const apptDateTime = new Date(`${appt.appointment_date}T${appt.start_time || '08:00'}:00`);
              const reminder24h = new Date(apptDateTime.getTime() - 24 * 60 * 60 * 1000);

              // Só agendar se o lembrete for no futuro
              if (reminder24h > new Date()) {
                await scheduleTask(supabase, clinicId, patientId, 'reminder_24h', reminder24h, {
                  reason: 'Lembrete automático 24h antes da consulta',
                  sourceEventId: eventResult.eventId || null,
                  idempotencyQualifier: appointmentId,
                  messageTemplate: 'Olá! Lembrando da sua consulta amanhã. Confirma presença?',
                });
              }
            }
          } catch (apptErr) {
            console.warn(`[CRM] Erro ao buscar appointment para reminder:`, apptErr.message);
          }
        }

        // Agendar confirmação 2h depois
        const confirmation2h = new Date(Date.now() + 2 * 60 * 60 * 1000);
        await scheduleTask(supabase, clinicId, patientId, 'booking_confirmation', confirmation2h, {
          reason: 'Confirmação de agendamento pós-conversa',
          sourceEventId: eventResult.eventId || null,
          idempotencyQualifier: appointmentId || conversationId || patientId,
        });

        await calculateLeadScore(supabase, patientId, clinicId);
        break;
      }

      case 'completed': {
        // Paciente compareceu à consulta
        await emitEvent(supabase, clinicId, patientId, 'appointment_completed', {
          conversationId,
          appointmentId,
          idempotencyQualifier: appointmentId || conversationId || patientId,
          payload: { outcome: 'completed' },
        });

        // Agendar follow-up pós-consulta (48h depois)
        const followUp48h = new Date(Date.now() + 48 * 60 * 60 * 1000);
        await scheduleTask(supabase, clinicId, patientId, 'post_consultation', followUp48h, {
          reason: 'Follow-up automático pós-consulta',
          idempotencyQualifier: appointmentId || conversationId || patientId,
          messageTemplate: 'Olá! Como você está se sentindo após a consulta? Posso ajudar com algo?',
        });

        await calculateLeadScore(supabase, patientId, clinicId);
        break;
      }

      case 'cancelled': {
        // Agendamento cancelado
        await emitEvent(supabase, clinicId, patientId, 'booking_canceled', {
          conversationId,
          appointmentId,
          idempotencyQualifier: appointmentId || conversationId || patientId,
          payload: { outcome: 'cancelled' },
        });

        await calculateLeadScore(supabase, patientId, clinicId);
        break;
      }

      case 'no_show': {
        // Paciente não compareceu
        await emitEvent(supabase, clinicId, patientId, 'no_show', {
          conversationId,
          appointmentId,
          idempotencyQualifier: appointmentId || conversationId || patientId,
          payload: { outcome: 'no_show' },
        });

        // Agendar recuperação 2h depois
        const recovery2h = new Date(Date.now() + 2 * 60 * 60 * 1000);
        await scheduleTask(supabase, clinicId, patientId, 'no_show_recovery', recovery2h, {
          reason: 'Recuperação automática pós no-show',
          idempotencyQualifier: appointmentId || conversationId || patientId,
          messageTemplate: 'Olá! Notamos que você não compareceu à consulta. Gostaria de reagendar?',
        });

        await calculateLeadScore(supabase, patientId, clinicId);
        break;
      }

      case 'abandoned': {
        // Conversa abandonada (paciente não completou o fluxo)
        await emitEvent(supabase, clinicId, patientId, 'conversation_ended', {
          conversationId,
          idempotencyQualifier: conversationId || patientId,
          payload: { outcome: 'abandoned', reason: 'flow_not_completed' },
        });

        // Agendar reativação em 7 dias
        const reactivation7d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await scheduleTask(supabase, clinicId, patientId, 'reactivation', reactivation7d, {
          reason: 'Reativação automática — conversa abandonada',
          idempotencyQualifier: conversationId || patientId,
          messageTemplate: 'Olá! Vi que você entrou em contato conosco recentemente. Posso ajudar com algo?',
        });

        await calculateLeadScore(supabase, patientId, clinicId);
        break;
      }

      case 'info_provided': {
        // Paciente pediu informação sem intenção de agendar
        await emitEvent(supabase, clinicId, patientId, 'info_requested', {
          conversationId,
          idempotencyQualifier: conversationId || patientId,
          payload: { outcome: 'info_provided' },
        });

        await calculateLeadScore(supabase, patientId, clinicId);
        break;
      }

      default: {
        // Conversa genérica (small talk, encerramento, etc.)
        await emitEvent(supabase, clinicId, patientId, 'conversation_ended', {
          conversationId,
          idempotencyQualifier: conversationId || `${patientId}:${new Date().toISOString().split('T')[0]}`,
          payload: { outcome: conversationOutcome || 'conversation' },
        });
        break;
      }
    }

    console.log(`[CRM] processPostConversation concluído: outcome=${conversationOutcome}`);
    return { success: true, outcome: conversationOutcome };
  } catch (error) {
    console.error(`[CRM] Erro em processPostConversation:`, error.message);
    return { success: false, error: error.message };
  }
}

// ======================================================
// NO-SHOW RISK PREDICTION
// ======================================================

/**
 * Calcula o risco de falta (no-show) para um agendamento específico.
 * Score 0–100: quanto maior, maior o risco.
 *
 * Fórmula:
 *   Fator A (40%) — Histórico de no-shows do paciente
 *   Fator B (20%) — Cancelamentos de última hora
 *   Fator C (20%) — Antecedência do agendamento
 *   Fator D (20%) — Status de confirmação
 *
 * Persiste o resultado em appointments.noshowrisk_*.
 * NUNCA faz throw — se falhar, retorna { success: false }.
 *
 * @param {object} supabase  - Cliente Supabase
 * @param {string} appointmentId - UUID do agendamento
 * @param {string} clinicId      - UUID da clínica
 */
export async function calcularRiscoFalta(supabase, appointmentId, clinicId) {
  try {
    const { data: appt } = await supabase
      .from('appointments')
      .select('id, patient_id, status, appointment_date, start_time, created_at')
      .eq('id', appointmentId)
      .eq('clinic_id', clinicId)
      .single();

    if (!appt) return { success: false, error: 'Agendamento não encontrado' };

    const { data: events } = await supabase
      .from('crm_events')
      .select('event_type, occurred_at, metadata')
      .eq('patient_id', appt.patient_id)
      .eq('clinic_id', clinicId)
      .order('occurred_at', { ascending: false });

    const eventList = events || [];

    // Fator A: No-shows históricos (max 40)
    const noShowCount = eventList.filter(e => e.event_type === 'no_show').length;
    const fatorA = noShowCount === 0 ? 0
                 : noShowCount === 1 ? 20
                 : noShowCount === 2 ? 35
                 : 40;

    // Fator B: Cancelamentos de última hora (max 20)
    const cancelEvents = eventList.filter(e => e.event_type === 'booking_canceled');
    let fatorB = 0;
    for (const cancel of cancelEvents) {
      const apptDateStr = cancel.metadata?.appointment_date;
      if (!apptDateStr) continue;
      const canceledAt = new Date(cancel.occurred_at);
      const apptDate   = new Date(apptDateStr);
      const horasAntes = (apptDate - canceledAt) / (1000 * 60 * 60);
      if (horasAntes < 2)  { fatorB = 20; break; }
      if (horasAntes < 24) { fatorB = Math.max(fatorB, 10); }
    }

    // Fator C: Antecedência do agendamento (max 20)
    const agendadoHa = (Date.now() - new Date(appt.created_at)) / (1000 * 60 * 60);
    const fatorC = agendadoHa < 2  ? 20
                 : agendadoHa < 48 ? 5
                 : 10;

    // Fator D: Status de confirmação (max 20)
    const agora = new Date();
    const apptDateTime = new Date(`${appt.appointment_date}T${appt.start_time}`);
    const minutosParaConsulta = (apptDateTime - agora) / (1000 * 60);

    let fatorD = 0;
    if (appt.status === 'scheduled') {
      fatorD = minutosParaConsulta < 60 ? 20 : 15;
    }

    const score = Math.min(100, fatorA + fatorB + fatorC + fatorD);
    const label = score >= 70 ? 'ALTO' : score >= 40 ? 'MEDIO' : 'BAIXO';

    await supabase
      .from('appointments')
      .update({
        noshowrisk_score:         score,
        noshowrisk_label:         label,
        noshowrisk_calculated_at: new Date().toISOString(),
      })
      .eq('id', appointmentId)
      .eq('clinic_id', clinicId);

    console.log(`[NOSHOWRISK] appointment=${appointmentId} score=${score} label=${label}`);
    return { success: true, score, label };

  } catch (err) {
    console.error('[NOSHOWRISK] Erro:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Converte score numérico em label semântica com cor e emoji.
 * @param {number} score
 */
export function getNoShowRiskLabel(score) {
  if (score >= 70) return { label: 'ALTO',  emoji: '🔴', color: '#E74C3C' };
  if (score >= 40) return { label: 'MÉDIO', emoji: '🟡', color: '#F39C12' };
  return             { label: 'BAIXO', emoji: '🟢', color: '#27AE60' };
}

// ======================================================
// EXPORTS (ESM)
// ======================================================
export {
  emitEvent,
  scheduleTask,
  calculateLeadScore,
  getScoreLabel,
  startScoreDecayJob,
  processPostConversation,
  VALID_EVENT_TYPES,
  VALID_TASK_TYPES,
};
