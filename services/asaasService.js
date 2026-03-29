// services/asaasService.js
// Wrapper da API Asaas para operacoes de billing
// Documentacao: https://docs.asaas.com
// F8C - Billing integration

import { createClient } from '@supabase/supabase-js';

const ASAAS_API_KEY  = process.env.ASAAS_API_KEY;
const ASAAS_BASE_URL = 'https://api.asaas.com/v3';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// -------------------------------------------------------
// Helper: fetch autenticado para a API Asaas
// -------------------------------------------------------
async function asaasFetch(path, options = {}) {
  var url = ASAAS_BASE_URL + path;

  var response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type':  'application/json',
      'access_token':  ASAAS_API_KEY,
      ...options.headers
    }
  });

  var data = await response.json();

  if (!response.ok) {
    var errorMsg = (data && data.errors && data.errors[0] && data.errors[0].description) || (data && data.message) || 'Erro na API Asaas';
    throw new Error('[Asaas] ' + errorMsg + ' (status ' + response.status + ')');
  }

  return data;
}

// -------------------------------------------------------
// CLIENTES
// -------------------------------------------------------

export async function createCustomer(clinicData) {
  return asaasFetch('/customers', {
    method: 'POST',
    body: JSON.stringify({
      name:             clinicData.name,
      email:            clinicData.email,
      mobilePhone:      clinicData.phone    || undefined,
      cpfCnpj:          clinicData.cpf_cnpj || undefined,
      externalReference: clinicData.clinic_id
    })
  });
}

export async function getCustomer(asaasCustomerId) {
  return asaasFetch('/customers/' + asaasCustomerId);
}

export async function getCustomerByClinicId(clinicId) {
  var result = await asaasFetch('/customers?externalReference=' + clinicId);
  return (result && result.data && result.data[0]) || null;
}

export async function listCustomers(params = {}) {
  var qs = new URLSearchParams(params).toString();
  return asaasFetch('/customers' + (qs ? '?' + qs : ''));
}

// -------------------------------------------------------
// COBRANCAS
// -------------------------------------------------------

export async function createCharge(chargeData) {
  return asaasFetch('/payments', {
    method: 'POST',
    body: JSON.stringify({
      customer:         chargeData.asaasCustomerId,
      billingType:      chargeData.billingType || 'UNDEFINED',
      value:            chargeData.value,
      dueDate:          chargeData.dueDate,
      description:      chargeData.description || 'Mensalidade CLINICORE',
      externalReference: chargeData.externalReference || undefined
    })
  });
}

export async function listChargesByCustomer(asaasCustomerId, params = {}) {
  var qs = new URLSearchParams({ customer: asaasCustomerId, ...params }).toString();
  return asaasFetch('/payments?' + qs);
}

export async function getCharge(chargeId) {
  return asaasFetch('/payments/' + chargeId);
}

export async function deleteCharge(chargeId) {
  return asaasFetch('/payments/' + chargeId, { method: 'DELETE' });
}

// -------------------------------------------------------
// ASSINATURAS (mensalidade recorrente)
// -------------------------------------------------------

export async function createSubscription(subscriptionData) {
  return asaasFetch('/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      customer:    subscriptionData.asaasCustomerId,
      billingType: subscriptionData.billingType || 'BOLETO',
      value:       subscriptionData.value,
      nextDueDate: subscriptionData.nextDueDate,
      cycle:       'MONTHLY',
      description: subscriptionData.description || 'Mensalidade CLINICORE',
      externalReference: subscriptionData.externalReference || undefined
    })
  });
}

export async function listSubscriptionsByCustomer(asaasCustomerId) {
  return asaasFetch('/subscriptions?customer=' + asaasCustomerId);
}

// -------------------------------------------------------
// GERACAO AUTOMATICA DE FATURA MENSAL
// Calcula uso do mes e gera cobranca variavel no Asaas
// -------------------------------------------------------

export async function generateMonthlyUsageCharge(clinicId, year, month) {
  // 1. Buscar billing config da clinica
  var billingResult = await supabase
    .from('clinic_billing_config')
    .select('asaas_customer_id, monthly_fee, price_per_1k_tokens_input, price_per_1k_tokens_output, price_per_template, billing_day, plan')
    .eq('clinic_id', clinicId)
    .single();

  if (billingResult.error || !billingResult.data) {
    throw new Error('Billing config nao encontrada para clinic_id: ' + clinicId);
  }

  var billing = billingResult.data;

  if (!billing.asaas_customer_id) {
    throw new Error('Clinica nao tem asaas_customer_id configurado');
  }

  // 2. Calcular periodo
  var startDate = new Date(year, month - 1, 1).toISOString();
  var endDate   = new Date(year, month, 0, 23, 59, 59).toISOString();

  // 3. Somar tokens OpenAI do periodo
  var aiResult = await supabase
    .from('clinic_ai_usage')
    .select('tokens_input, tokens_output')
    .eq('clinic_id', clinicId)
    .gte('created_at', startDate)
    .lte('created_at', endDate);

  var totalTokensInput  = 0;
  var totalTokensOutput = 0;
  var aiUsage = aiResult.data || [];

  for (var i = 0; i < aiUsage.length; i++) {
    totalTokensInput  += aiUsage[i].tokens_input  || 0;
    totalTokensOutput += aiUsage[i].tokens_output || 0;
  }

  var aiCostTokens =
    (totalTokensInput  / 1000) * parseFloat(billing.price_per_1k_tokens_input)  +
    (totalTokensOutput / 1000) * parseFloat(billing.price_per_1k_tokens_output);

  // 4. Somar templates do periodo
  var templateResult = await supabase
    .from('clinic_template_usage')
    .select('id', { count: 'exact', head: true })
    .eq('clinic_id', clinicId)
    .gte('created_at', startDate)
    .lte('created_at', endDate);

  var templateCount = templateResult.count || 0;
  var templateCost = templateCount * parseFloat(billing.price_per_template);

  // 5. Total em BRL
  var monthlyFee   = parseFloat(billing.monthly_fee);
  var variableCost = aiCostTokens + templateCost;
  var totalBRL     = monthlyFee + variableCost;

  // 6. Calcular data de vencimento
  var dueDate = new Date(year, month - 1, billing.billing_day);
  if (dueDate < new Date()) {
    dueDate.setMonth(dueDate.getMonth() + 1);
  }
  var dueDateStr = dueDate.toISOString().substring(0, 10);

  // 7. Montar descricao detalhada
  var description =
    'CLINICORE ' + String(month).padStart(2, '0') + '/' + year +
    ' | Mensalidade: R$' + monthlyFee.toFixed(2) +
    ' | Tokens IA: R$' + aiCostTokens.toFixed(2) +
    ' | Templates: R$' + templateCost.toFixed(2) +
    ' | Total: R$' + totalBRL.toFixed(2);

  // 8. Criar cobranca no Asaas
  var charge = await createCharge({
    asaasCustomerId:   billing.asaas_customer_id,
    value:             parseFloat(totalBRL.toFixed(2)),
    dueDate:           dueDateStr,
    description:       description,
    externalReference: clinicId + '_' + year + '_' + month
  });

  return {
    charge: charge,
    breakdown: {
      monthly_fee:     monthlyFee,
      ai_tokens_input:  totalTokensInput,
      ai_tokens_output: totalTokensOutput,
      ai_cost:         parseFloat(aiCostTokens.toFixed(2)),
      template_count:  templateCount,
      template_cost:   parseFloat(templateCost.toFixed(2)),
      total_brl:       parseFloat(totalBRL.toFixed(2)),
      due_date:        dueDateStr
    }
  };
}
