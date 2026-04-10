// lib/openaiTracker.js
// Wrapper único para todas as chamadas OpenAI do CLINICORE.
// Registra tokens, custo, latência e clinic_id na tabela openai_usage_log.
//
// REGRAS ABSOLUTAS:
// - clinic_id e purpose são OBRIGATÓRIOS (multi-tenant + LGPD)
// - Fire-and-forget na gravação — falha de log NUNCA bloqueia a resposta
// - NÃO logar conteúdo de mensagens (LGPD)
// - Se a chamada OpenAI falhar, ainda assim gravamos o registro com success=false
//
// Sprint 0 — Observabilidade

import { createClient } from '@supabase/supabase-js';

// -------------------------------------------------------
// Preços por modelo (USD por 1M tokens)
// Fonte: https://openai.com/api/pricing/
// ATUALIZAR conforme OpenAI alterar preços.
// -------------------------------------------------------
const PRICING = {
  // GPT-4.1 family
  'gpt-4.1':           { input: 2.00,  cached: 0.50,  output: 8.00  },
  'gpt-4.1-mini':      { input: 0.40,  cached: 0.10,  output: 1.60  },
  'gpt-4.1-nano':      { input: 0.10,  cached: 0.025, output: 0.40  },
  // GPT-4o family
  'gpt-4o':            { input: 2.50,  cached: 1.25,  output: 10.00 },
  'gpt-4o-mini':       { input: 0.15,  cached: 0.075, output: 0.60  },
  // o1 / o3 reasoning
  'o1':                { input: 15.00, cached: 7.50,  output: 60.00 },
  'o1-mini':           { input: 3.00,  cached: 1.50,  output: 12.00 },
  'o3-mini':           { input: 1.10,  cached: 0.55,  output: 4.40  },
};

const DEFAULT_PRICING = { input: 2.00, cached: 0.50, output: 8.00 };

function resolvePricing(model) {
  if (!model) return DEFAULT_PRICING;
  if (PRICING[model]) return PRICING[model];
  // Matching por prefixo (ex: 'gpt-4o-mini-2024-07-18' → 'gpt-4o-mini')
  for (const key of Object.keys(PRICING)) {
    if (model.startsWith(key)) return PRICING[key];
  }
  return DEFAULT_PRICING;
}

/**
 * Calcula custo estimado em USD.
 * @param {string} model
 * @param {number} promptTokens total de prompt tokens
 * @param {number} cachedTokens fração cached do prompt (prompt_tokens_details.cached_tokens)
 * @param {number} completionTokens
 * @returns {number} custo em USD (6 casas decimais)
 */
export function calculateCost(model, promptTokens, cachedTokens, completionTokens) {
  const p = resolvePricing(model);
  const uncachedPrompt = Math.max(0, (promptTokens || 0) - (cachedTokens || 0));
  const cost =
    (uncachedPrompt / 1_000_000) * p.input +
    ((cachedTokens || 0) / 1_000_000) * p.cached +
    ((completionTokens || 0) / 1_000_000) * p.output;
  return parseFloat(cost.toFixed(6));
}

// -------------------------------------------------------
// Supabase client lazy — service_role bypassa RLS.
// Usa o mesmo padrão dos demais módulos (usageTracker, reportService).
// -------------------------------------------------------
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
 * Grava um registro em openai_usage_log fire-and-forget.
 * Nunca lança — falhas são apenas logadas.
 */
function logUsageFireAndForget(record) {
  try {
    getSupabase()
      .from('openai_usage_log')
      .insert(record)
      .then(({ error: insertErr }) => {
        if (insertErr) {
          console.error('[openaiTracker] log insert failed:', insertErr.message);
        }
      });
  } catch (e) {
    console.error('[openaiTracker] log insert exception:', e?.message);
  }
}

/**
 * Wrapper para chat.completions.create com instrumentação.
 *
 * @param {object} args
 * @param {object} args.client - instância OpenAI (new OpenAI(...))
 * @param {string} args.clinicId - UUID da clínica (OBRIGATÓRIO)
 * @param {string} args.purpose - identificador semântico (OBRIGATÓRIO)
 *   ex: 'lara_classification', 'lara_response', 'lara_summary',
 *       'crm_report_overview', 'crm_report_patient', 'prontuario_assist'
 * @param {string} [args.requestId] - ID original (ex: whatsapp message id)
 * @param {object} [args.metadata] - metadados adicionais (NÃO incluir conteúdo de mensagens)
 * @param {object} [args.requestOptions] - opções OpenAI SDK (signal, headers, etc.)
 * @param {...object} openaiParams - model, messages, temperature, max_tokens, tools, etc.
 * @returns {Promise<object>} response da OpenAI
 */
export async function trackedChatCompletion({
  client,
  clinicId,
  purpose,
  requestId,
  metadata,
  requestOptions,
  ...openaiParams
}) {
  if (!client) throw new Error('openaiTracker: client é obrigatório');
  if (!clinicId) throw new Error('openaiTracker: clinicId é obrigatório');
  if (!purpose) throw new Error('openaiTracker: purpose é obrigatório');
  if (!openaiParams.model) throw new Error('openaiTracker: model é obrigatório');

  const startTime = Date.now();
  let response = null;
  let error = null;

  try {
    if (requestOptions) {
      response = await client.chat.completions.create(openaiParams, requestOptions);
    } else {
      response = await client.chat.completions.create(openaiParams);
    }
  } catch (e) {
    error = e;
  }

  const latencyMs = Date.now() - startTime;

  // Extrair dados de usage
  const usage = response?.usage || {};
  const promptTokens = usage.prompt_tokens || 0;
  const completionTokens = usage.completion_tokens || 0;
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;
  const modelUsed = response?.model || openaiParams.model;

  // Gravar log fire-and-forget
  logUsageFireAndForget({
    clinic_id: clinicId,
    model: modelUsed,
    purpose,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    cached_tokens: cachedTokens,
    estimated_cost_usd: calculateCost(modelUsed, promptTokens, cachedTokens, completionTokens),
    latency_ms: latencyMs,
    success: !error,
    error_message: error?.message ? String(error.message).substring(0, 500) : null,
    request_id: requestId || null,
    metadata: metadata || null,
  });

  if (error) throw error;
  return response;
}
