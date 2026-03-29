// services/adminClinicService.js
// Lógica de negócio para visão admin das clínicas

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Retorna todas as clínicas com métricas básicas
export async function getAllClinicsOverview() {
  const { data: clinics, error } = await supabase
    .from('clinics')
    .select('id, name, email, phone, is_active, created_at')
    .order('created_at', { ascending: false });

  if (error) throw error;

  const clinicsWithMetrics = await Promise.all(
    clinics.map(async (clinic) => {
      const [patientsResult, usersResult, billingResult] = await Promise.all([
        supabase
          .from('patients')
          .select('id', { count: 'exact', head: true })
          .eq('clinic_id', clinic.id),

        supabase
          .from('clinic_users')
          .select('id', { count: 'exact', head: true })
          .eq('clinic_id', clinic.id),

        supabase
          .from('clinic_billing_config')
          .select('plan, monthly_fee, is_active, asaas_customer_id')
          .eq('clinic_id', clinic.id)
          .single()
      ]);

      return {
        ...clinic,
        metrics: {
          total_patients: patientsResult.count || 0,
          total_users: usersResult.count || 0
        },
        billing: billingResult.data || null
      };
    })
  );

  return clinicsWithMetrics;
}

// Retorna detalhes completos de uma clínica específica
export async function getClinicDetail(clinicId) {
  const { data: clinic, error } = await supabase
    .from('clinics')
    .select('id, name, email, phone, is_active, created_at')
    .eq('id', clinicId)
    .single();

  if (error) throw error;
  if (!clinic) return null;

  const [
    patientsResult,
    usersResult,
    whatsappResult,
    billingResult,
    recentAlertsResult
  ] = await Promise.all([
    supabase
      .from('patients')
      .select('id', { count: 'exact', head: true })
      .eq('clinic_id', clinicId),

    supabase
      .from('clinic_users')
      .select('id, role, created_at')
      .eq('clinic_id', clinicId),

    supabase
      .from('clinic_whatsapp_config')
      .select('phone_number_id, display_name, is_active')
      .eq('clinic_id', clinicId)
      .eq('is_active', true)
      .maybeSingle(),

    supabase
      .from('clinic_billing_config')
      .select('plan, monthly_fee, is_active, asaas_customer_id, billing_day, price_per_1k_tokens_input, price_per_1k_tokens_output, price_per_template')
      .eq('clinic_id', clinicId)
      .maybeSingle(),

    supabase
      .from('system_alerts')
      .select('id, alert_type, title, created_at, is_resolved')
      .eq('clinic_id', clinicId)
      .eq('is_resolved', false)
      .order('created_at', { ascending: false })
      .limit(5)
  ]);

  return {
    ...clinic,
    metrics: {
      total_patients: patientsResult.count || 0
    },
    users: usersResult.data || [],
    whatsapp_config: whatsappResult.data || null,
    billing: billingResult.data || null,
    active_alerts: recentAlertsResult.data || []
  };
}

// Ativar ou desativar uma clínica
export async function toggleClinicStatus(clinicId, isActive) {
  const { data, error } = await supabase
    .from('clinics')
    .update({ is_active: isActive })
    .eq('id', clinicId)
    .select('id, name, is_active')
    .single();

  if (error) throw error;
  return data;
}

// Criar ou atualizar billing config de uma clínica
export async function upsertBillingConfig(clinicId, config) {
  const { data, error } = await supabase
    .from('clinic_billing_config')
    .upsert(
      { clinic_id: clinicId, ...config },
      { onConflict: 'clinic_id' }
    )
    .select()
    .single();

  if (error) throw error;
  return data;
}

// Overview geral da plataforma (KPIs do dashboard principal)
export async function getPlatformOverview() {
  const [
    totalClinicsResult,
    activeClinicsResult,
    totalPatientsResult,
    unresolvedAlertsResult
  ] = await Promise.all([
    supabase.from('clinics').select('id', { count: 'exact', head: true }),
    supabase.from('clinics').select('id', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('patients').select('id', { count: 'exact', head: true }),
    supabase.from('system_alerts').select('id', { count: 'exact', head: true }).eq('is_resolved', false)
  ]);

  return {
    total_clinics: totalClinicsResult.count || 0,
    active_clinics: activeClinicsResult.count || 0,
    inactive_clinics: (totalClinicsResult.count || 0) - (activeClinicsResult.count || 0),
    total_patients: totalPatientsResult.count || 0,
    unresolved_alerts: unresolvedAlertsResult.count || 0
  };
}
