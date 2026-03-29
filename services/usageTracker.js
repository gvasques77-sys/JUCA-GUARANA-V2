// services/usageTracker.js
// Serviço de rastreamento de uso para billing
// Registra tokens OpenAI e templates Meta por clínica

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// -------------------------------------------------------
// Tabela de preços por modelo (USD por 1k tokens)
// Fonte: https://openai.com/pricing
// -------------------------------------------------------
const MODEL_PRICING = {
  'gpt-4.1':      { input: 0.002,    output: 0.008  },
  'gpt-4.1-mini': { input: 0.0004,   output: 0.0016 },
  'gpt-4o':       { input: 0.005,    output: 0.015  },
  'gpt-4o-mini':  { input: 0.00015,  output: 0.0006 }
};

const DEFAULT_PRICING = { input: 0.002, output: 0.008 };

function calculateCostUsd(model, tokensInput, tokensOutput) {
  const pricing = MODEL_PRICING[model] || DEFAULT_PRICING;
  const cost = (tokensInput / 1000) * pricing.input + (tokensOutput / 1000) * pricing.output;
  return parseFloat(cost.toFixed(6));
}

function hashPhone(phone) {
  return crypto
    .createHash('sha256')
    .update(String(phone).replace(/\D/g, ''))
    .digest('hex');
}

// -------------------------------------------------------
// trackAiUsage — registrar uso de tokens OpenAI
//
// Uso (fire and forget):
//   trackAiUsage(clinicId, 'conversation', openaiResponse, { conversation_id: '...' })
//     .catch(err => console.error('[tracking]', err.message));
//
// Ou com tokens acumulados (sem objeto de resposta OpenAI):
//   trackAiUsage(clinicId, 'conversation', null, {
//     tokensInput: 1200, tokensOutput: 400, model: 'gpt-4.1'
//   }).catch(...);
// -------------------------------------------------------
export async function trackAiUsage(clinicId, usageType, openaiResponse, metadata) {
  try {
    if (!clinicId) return null;

    let tokensInput, tokensOutput, model;

    if (openaiResponse && openaiResponse.usage) {
      // Modo normal: objeto de resposta OpenAI
      tokensInput  = openaiResponse.usage.prompt_tokens     || 0;
      tokensOutput = openaiResponse.usage.completion_tokens || 0;
      model        = openaiResponse.model || (metadata && metadata.model) || 'gpt-4.1';
    } else if (metadata && (metadata.tokensInput !== undefined || metadata.tokens_input !== undefined)) {
      // Modo acumulado: tokens passados diretamente nos metadados
      tokensInput  = metadata.tokensInput  || metadata.tokens_input  || 0;
      tokensOutput = metadata.tokensOutput || metadata.tokens_output || 0;
      model        = (metadata && metadata.model) || 'gpt-4.1';
    } else {
      console.warn('[usageTracker] trackAiUsage: sem dados de usage');
      return null;
    }

    const costUsd = calculateCostUsd(model, tokensInput, tokensOutput);

    const record = {
      clinic_id:       clinicId,
      usage_type:      usageType,
      model:           model,
      tokens_input:    tokensInput,
      tokens_output:   tokensOutput,
      cost_usd:        costUsd,
      conversation_id: (metadata && metadata.conversation_id) || null,
      report_type:     (metadata && metadata.report_type)     || null,
      metadata:        (metadata && Object.keys(metadata).length > 0) ? metadata : null
    };

    const { data, error } = await supabase
      .from('clinic_ai_usage')
      .insert(record)
      .select('id, cost_usd, tokens_total')
      .single();

    if (error) {
      console.error('[usageTracker] Erro ao registrar AI usage:', error.message);
      return null;
    }

    return data;
  } catch (err) {
    console.error('[usageTracker] Erro inesperado em trackAiUsage:', err.message);
    return null;
  }
}

// -------------------------------------------------------
// trackTemplateUsage — registrar template Meta enviado
// -------------------------------------------------------
export async function trackTemplateUsage(clinicId, options) {
  try {
    if (!clinicId || !options) return null;

    const templateName     = options.templateName     || options.template_name;
    const templateCategory = options.templateCategory || options.template_category || 'utility';
    const phone            = options.phone;
    const messageSid       = options.messageSid || options.message_sid || null;
    const campaignId       = options.campaignId || options.campaign_id || null;
    const status           = options.status || 'sent';

    if (!templateName || !phone) {
      console.warn('[usageTracker] trackTemplateUsage: templateName e phone são obrigatórios');
      return null;
    }

    // Custo por categoria (Brasil, USD)
    const TEMPLATE_COST = {
      'utility':        0.0315,
      'marketing':      0.0625,
      'authentication': 0.0315
    };

    const costUsd = TEMPLATE_COST[templateCategory] || 0.0315;

    const record = {
      clinic_id:         clinicId,
      template_name:     templateName,
      template_category: templateCategory,
      phone_hash:        hashPhone(phone),
      message_sid:       messageSid,
      campaign_id:       campaignId,
      status:            status,
      cost_usd:          costUsd
    };

    const { data, error } = await supabase
      .from('clinic_template_usage')
      .insert(record)
      .select('id, cost_usd')
      .single();

    if (error) {
      console.error('[usageTracker] Erro ao registrar template usage:', error.message);
      return null;
    }

    return data;
  } catch (err) {
    console.error('[usageTracker] Erro inesperado em trackTemplateUsage:', err.message);
    return null;
  }
}

// -------------------------------------------------------
// updateTemplateStatus — atualizar status via webhook Meta
// -------------------------------------------------------
export async function updateTemplateStatus(messageSid, newStatus) {
  try {
    const { error } = await supabase
      .from('clinic_template_usage')
      .update({ status: newStatus })
      .eq('message_sid', messageSid);

    if (error) {
      console.error('[usageTracker] Erro ao atualizar status:', error.message);
    }
  } catch (err) {
    console.error('[usageTracker] Erro inesperado em updateTemplateStatus:', err.message);
  }
}
