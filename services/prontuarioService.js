/**
 * prontuarioService.js — F11 Prontuário Eletrônico
 *
 * Camada de acesso a dados para todas as 12 tabelas do prontuário.
 * Todas as funções recebem o client supabase do server.js (service_role).
 *
 * CONVENÇÕES:
 *  - Sempre filtrar por clinic_id (isolamento multi-tenant)
 *  - created_by = req.userId (UUID do auth.users)
 *  - Lança Error em caso de falha — o router trata e responde 500
 *  - Prefixo [PRONTUARIO] em logs de erro
 *
 * TABELAS COBERTAS:
 *  patient_records, patient_consultations, patient_vitals,
 *  patient_medications, patient_allergies, patient_diagnoses,
 *  patient_prescriptions, patient_exam_requests, patient_documents,
 *  patient_vaccines, patient_family_history, patient_record_audit
 */

// ============================================================
// PRONTUÁRIO BASE (patient_records)
// ============================================================

export async function getOrCreateRecord(supabase, clinicId, patientId, createdBy) {
  const { data: existing, error: fetchError } = await supabase
    .from('patient_records')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('patient_id', patientId)
    .maybeSingle();

  if (fetchError) {
    console.error('[PRONTUARIO] Erro ao buscar patient_records:', fetchError.message);
    throw new Error('Falha ao buscar prontuário');
  }

  if (existing) return existing;

  const { data: created, error: createError } = await supabase
    .from('patient_records')
    .insert({
      clinic_id: clinicId,
      patient_id: patientId,
      anamnesis: {},
      created_by: createdBy,
    })
    .select()
    .single();

  if (createError) {
    console.error('[PRONTUARIO] Erro ao criar patient_records:', createError.message);
    throw new Error('Falha ao criar prontuário');
  }

  return created;
}

export async function updateRecord(supabase, clinicId, patientId, data) {
  const allowed = ['blood_type', 'height_cm', 'weight_kg', 'anamnesis', 'chronic_conditions', 'main_diagnosis_cid'];
  const filtered = Object.fromEntries(Object.entries(data).filter(([k]) => allowed.includes(k)));

  const { data: updated, error } = await supabase
    .from('patient_records')
    .update(filtered)
    .eq('clinic_id', clinicId)
    .eq('patient_id', patientId)
    .select()
    .single();

  if (error) {
    console.error('[PRONTUARIO] Erro ao atualizar patient_records:', error.message);
    throw new Error('Falha ao atualizar prontuário');
  }

  return updated;
}

// ============================================================
// CONSULTAS (patient_consultations)
// ============================================================

export async function createConsultation(supabase, clinicId, patientId, data, createdBy) {
  const record = await getOrCreateRecord(supabase, clinicId, patientId, createdBy);

  const payload = {
    clinic_id: clinicId,
    patient_id: patientId,
    record_id: record.id,
    created_by: createdBy,
    consultation_date: data.consultation_date || new Date().toISOString(),
    consultation_type: data.consultation_type || 'presencial',
    status: 'em_andamento',
    ...(data.appointment_id && { appointment_id: data.appointment_id }),
    ...(data.doctor_id && { doctor_id: data.doctor_id }),
    ...(data.chief_complaint && { chief_complaint: data.chief_complaint }),
    ...(data.anamnesis && { anamnesis: data.anamnesis }),
    ...(data.physical_exam && { physical_exam: data.physical_exam }),
    ...(data.diagnosis_notes && { diagnosis_notes: data.diagnosis_notes }),
    ...(data.treatment_plan && { treatment_plan: data.treatment_plan }),
    ...(data.soap_subjective && { soap_subjective: data.soap_subjective }),
    ...(data.soap_objective && { soap_objective: data.soap_objective }),
    ...(data.soap_assessment && { soap_assessment: data.soap_assessment }),
    ...(data.soap_plan && { soap_plan: data.soap_plan }),
    ...(data.follow_up_date && { follow_up_date: data.follow_up_date }),
    ...(data.follow_up_notes && { follow_up_notes: data.follow_up_notes }),
  };

  const { data: created, error } = await supabase
    .from('patient_consultations')
    .insert(payload)
    .select()
    .single();

  if (error) {
    console.error('[PRONTUARIO] Erro ao criar consulta:', error.message);
    throw new Error('Falha ao criar consulta');
  }

  return created;
}

export async function getConsultations(supabase, clinicId, patientId, options = {}) {
  const { limit = 20, offset = 0 } = options;

  const { data, error } = await supabase
    .from('patient_consultations')
    .select(`
      id, consultation_date, consultation_type, chief_complaint,
      status, follow_up_date, doctor_id, created_at,
      doctors ( name, specialty )
    `)
    .eq('clinic_id', clinicId)
    .eq('patient_id', patientId)
    .order('consultation_date', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error('[PRONTUARIO] Erro ao listar consultas:', error.message);
    throw new Error('Falha ao listar consultas');
  }

  return data;
}

export async function getConsultation(supabase, clinicId, consultationId) {
  const { data, error } = await supabase
    .from('patient_consultations')
    .select(`
      *,
      doctors ( id, name, specialty, crm ),
      patients ( id, name, phone, birth_date, cpf )
    `)
    .eq('clinic_id', clinicId)
    .eq('id', consultationId)
    .maybeSingle();

  if (error) {
    console.error('[PRONTUARIO] Erro ao buscar consulta:', error.message);
    throw new Error('Falha ao buscar consulta');
  }

  return data;
}

export async function updateConsultation(supabase, clinicId, consultationId, data) {
  const allowed = [
    'consultation_type', 'chief_complaint', 'anamnesis', 'physical_exam',
    'diagnosis_notes', 'treatment_plan', 'soap_subjective', 'soap_objective',
    'soap_assessment', 'soap_plan', 'follow_up_date', 'follow_up_notes',
    'status', 'doctor_id', 'consultation_date',
  ];
  const filtered = Object.fromEntries(Object.entries(data).filter(([k]) => allowed.includes(k)));

  const { data: updated, error } = await supabase
    .from('patient_consultations')
    .update(filtered)
    .eq('clinic_id', clinicId)
    .eq('id', consultationId)
    .select()
    .single();

  if (error) {
    console.error('[PRONTUARIO] Erro ao atualizar consulta:', error.message);
    throw new Error('Falha ao atualizar consulta');
  }

  return updated;
}

// ============================================================
// SINAIS VITAIS (patient_vitals)
// ============================================================

export async function addVitals(supabase, clinicId, patientId, consultationId, data, createdBy) {
  let bmi = data.bmi || null;
  if (!bmi && data.weight_kg && data.height_cm) {
    const heightM = parseFloat(data.height_cm) / 100;
    bmi = parseFloat((parseFloat(data.weight_kg) / (heightM * heightM)).toFixed(2));
  }

  const payload = {
    clinic_id: clinicId,
    patient_id: patientId,
    created_by: createdBy,
    measured_at: data.measured_at || new Date().toISOString(),
    ...(consultationId && { consultation_id: consultationId }),
    ...(data.blood_pressure_systolic != null && { blood_pressure_systolic: data.blood_pressure_systolic }),
    ...(data.blood_pressure_diastolic != null && { blood_pressure_diastolic: data.blood_pressure_diastolic }),
    ...(data.heart_rate != null && { heart_rate: data.heart_rate }),
    ...(data.temperature != null && { temperature: data.temperature }),
    ...(data.oxygen_saturation != null && { oxygen_saturation: data.oxygen_saturation }),
    ...(data.respiratory_rate != null && { respiratory_rate: data.respiratory_rate }),
    ...(data.weight_kg != null && { weight_kg: data.weight_kg }),
    ...(data.height_cm != null && { height_cm: data.height_cm }),
    ...(bmi != null && { bmi }),
    ...(data.blood_glucose != null && { blood_glucose: data.blood_glucose }),
    ...(data.notes && { notes: data.notes }),
  };

  const { data: created, error } = await supabase
    .from('patient_vitals')
    .insert(payload)
    .select()
    .single();

  if (error) {
    console.error('[PRONTUARIO] Erro ao registrar sinais vitais:', error.message);
    throw new Error('Falha ao registrar sinais vitais');
  }

  return created;
}

export async function getVitals(supabase, clinicId, patientId, limit = 30) {
  const { data, error } = await supabase
    .from('patient_vitals')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('patient_id', patientId)
    .order('measured_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[PRONTUARIO] Erro ao listar sinais vitais:', error.message);
    throw new Error('Falha ao listar sinais vitais');
  }

  return data;
}

// ============================================================
// ALERGIAS (patient_allergies)
// ============================================================

export async function addAllergy(supabase, clinicId, patientId, data, createdBy) {
  const { data: created, error } = await supabase
    .from('patient_allergies')
    .insert({
      clinic_id: clinicId,
      patient_id: patientId,
      allergen: data.allergen,
      reaction: data.reaction || null,
      severity: data.severity || 'moderada',
      confirmed: data.confirmed || false,
      notes: data.notes || null,
      created_by: createdBy,
    })
    .select()
    .single();

  if (error) {
    console.error('[PRONTUARIO] Erro ao adicionar alergia:', error.message);
    throw new Error('Falha ao adicionar alergia');
  }

  return created;
}

export async function getAllergies(supabase, clinicId, patientId) {
  const { data, error } = await supabase
    .from('patient_allergies')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('patient_id', patientId)
    .order('severity', { ascending: false })
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[PRONTUARIO] Erro ao listar alergias:', error.message);
    throw new Error('Falha ao listar alergias');
  }

  return data;
}

export async function deleteAllergy(supabase, clinicId, allergyId) {
  const { error } = await supabase
    .from('patient_allergies')
    .delete()
    .eq('clinic_id', clinicId)
    .eq('id', allergyId);

  if (error) {
    console.error('[PRONTUARIO] Erro ao remover alergia:', error.message);
    throw new Error('Falha ao remover alergia');
  }
}

// ============================================================
// MEDICAMENTOS (patient_medications)
// ============================================================

export async function addMedication(supabase, clinicId, patientId, data, createdBy) {
  const { data: created, error } = await supabase
    .from('patient_medications')
    .insert({
      clinic_id: clinicId,
      patient_id: patientId,
      name: data.name,
      dosage: data.dosage || null,
      frequency: data.frequency || null,
      route: data.route || null,
      start_date: data.start_date || null,
      end_date: data.end_date || null,
      prescribed_by: data.prescribed_by || null,
      notes: data.notes || null,
      active: data.active !== undefined ? data.active : true,
      created_by: createdBy,
    })
    .select()
    .single();

  if (error) {
    console.error('[PRONTUARIO] Erro ao adicionar medicamento:', error.message);
    throw new Error('Falha ao adicionar medicamento');
  }

  return created;
}

export async function getMedications(supabase, clinicId, patientId, onlyActive = false) {
  let query = supabase
    .from('patient_medications')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('patient_id', patientId)
    .order('active', { ascending: false })
    .order('name', { ascending: true });

  if (onlyActive) query = query.eq('active', true);

  const { data, error } = await query;

  if (error) {
    console.error('[PRONTUARIO] Erro ao listar medicamentos:', error.message);
    throw new Error('Falha ao listar medicamentos');
  }

  return data;
}

export async function updateMedication(supabase, clinicId, medicationId, data) {
  const allowed = ['name', 'dosage', 'frequency', 'route', 'start_date', 'end_date', 'prescribed_by', 'notes', 'active'];
  const filtered = Object.fromEntries(Object.entries(data).filter(([k]) => allowed.includes(k)));

  const { data: updated, error } = await supabase
    .from('patient_medications')
    .update(filtered)
    .eq('clinic_id', clinicId)
    .eq('id', medicationId)
    .select()
    .single();

  if (error) {
    console.error('[PRONTUARIO] Erro ao atualizar medicamento:', error.message);
    throw new Error('Falha ao atualizar medicamento');
  }

  return updated;
}

// ============================================================
// DIAGNÓSTICOS (patient_diagnoses)
// ============================================================

export async function addDiagnosis(supabase, clinicId, patientId, consultationId, data, createdBy) {
  const { data: created, error } = await supabase
    .from('patient_diagnoses')
    .insert({
      clinic_id: clinicId,
      patient_id: patientId,
      consultation_id: consultationId || null,
      cid_code: data.cid_code || null,
      cid_description: data.cid_description || null,
      diagnosis_type: data.diagnosis_type || 'principal',
      status: data.status || 'ativo',
      onset_date: data.onset_date || null,
      notes: data.notes || null,
      created_by: createdBy,
    })
    .select()
    .single();

  if (error) {
    console.error('[PRONTUARIO] Erro ao adicionar diagnóstico:', error.message);
    throw new Error('Falha ao adicionar diagnóstico');
  }

  return created;
}

export async function getDiagnoses(supabase, clinicId, patientId) {
  const { data, error } = await supabase
    .from('patient_diagnoses')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('patient_id', patientId)
    .order('status', { ascending: true })
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[PRONTUARIO] Erro ao listar diagnósticos:', error.message);
    throw new Error('Falha ao listar diagnósticos');
  }

  return data;
}

export async function updateDiagnosis(supabase, clinicId, diagnosisId, data) {
  const allowed = ['cid_code', 'cid_description', 'diagnosis_type', 'status', 'onset_date', 'resolution_date', 'notes'];
  const filtered = Object.fromEntries(Object.entries(data).filter(([k]) => allowed.includes(k)));

  const { data: updated, error } = await supabase
    .from('patient_diagnoses')
    .update(filtered)
    .eq('clinic_id', clinicId)
    .eq('id', diagnosisId)
    .select()
    .single();

  if (error) {
    console.error('[PRONTUARIO] Erro ao atualizar diagnóstico:', error.message);
    throw new Error('Falha ao atualizar diagnóstico');
  }

  return updated;
}

// ============================================================
// PRESCRIÇÕES (patient_prescriptions)
// ============================================================

export async function createPrescription(supabase, clinicId, patientId, consultationId, data, createdBy) {
  const { data: created, error } = await supabase
    .from('patient_prescriptions')
    .insert({
      clinic_id: clinicId,
      patient_id: patientId,
      consultation_id: consultationId || null,
      doctor_id: data.doctor_id || null,
      prescription_date: data.prescription_date || new Date().toISOString().split('T')[0],
      items: data.items || [],
      valid_until: data.valid_until || null,
      notes: data.notes || null,
      status: 'ativa',
      created_by: createdBy,
    })
    .select()
    .single();

  if (error) {
    console.error('[PRONTUARIO] Erro ao criar prescrição:', error.message);
    throw new Error('Falha ao criar prescrição');
  }

  return created;
}

export async function getPrescriptions(supabase, clinicId, patientId, limit = 20) {
  const { data, error } = await supabase
    .from('patient_prescriptions')
    .select(`
      *,
      doctors ( name, crm )
    `)
    .eq('clinic_id', clinicId)
    .eq('patient_id', patientId)
    .order('prescription_date', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[PRONTUARIO] Erro ao listar prescrições:', error.message);
    throw new Error('Falha ao listar prescrições');
  }

  return data;
}

// ============================================================
// SOLICITAÇÃO DE EXAMES (patient_exam_requests)
// ============================================================

export async function createExamRequest(supabase, clinicId, patientId, consultationId, data, createdBy) {
  const { data: created, error } = await supabase
    .from('patient_exam_requests')
    .insert({
      clinic_id: clinicId,
      patient_id: patientId,
      consultation_id: consultationId || null,
      doctor_id: data.doctor_id || null,
      request_date: data.request_date || new Date().toISOString().split('T')[0],
      exams: data.exams || [],
      urgency: data.urgency || 'rotina',
      clinical_indication: data.clinical_indication || null,
      status: 'solicitado',
      notes: data.notes || null,
      created_by: createdBy,
    })
    .select()
    .single();

  if (error) {
    console.error('[PRONTUARIO] Erro ao criar solicitação de exames:', error.message);
    throw new Error('Falha ao criar solicitação de exames');
  }

  return created;
}

export async function getExamRequests(supabase, clinicId, patientId, limit = 20) {
  const { data, error } = await supabase
    .from('patient_exam_requests')
    .select(`
      *,
      doctors ( name, specialty )
    `)
    .eq('clinic_id', clinicId)
    .eq('patient_id', patientId)
    .order('request_date', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[PRONTUARIO] Erro ao listar solicitações de exames:', error.message);
    throw new Error('Falha ao listar solicitações de exames');
  }

  return data;
}

export async function updateExamRequest(supabase, clinicId, examId, data) {
  const allowed = ['status', 'result_summary', 'result_date', 'notes', 'urgency'];
  const filtered = Object.fromEntries(Object.entries(data).filter(([k]) => allowed.includes(k)));

  const { data: updated, error } = await supabase
    .from('patient_exam_requests')
    .update(filtered)
    .eq('clinic_id', clinicId)
    .eq('id', examId)
    .select()
    .single();

  if (error) {
    console.error('[PRONTUARIO] Erro ao atualizar solicitação de exame:', error.message);
    throw new Error('Falha ao atualizar solicitação de exame');
  }

  return updated;
}

// ============================================================
// VACINAS (patient_vaccines)
// ============================================================

export async function addVaccine(supabase, clinicId, patientId, data, createdBy) {
  const { data: created, error } = await supabase
    .from('patient_vaccines')
    .insert({
      clinic_id: clinicId,
      patient_id: patientId,
      vaccine_name: data.vaccine_name,
      dose_number: data.dose_number || 1,
      application_date: data.application_date || null,
      next_dose_date: data.next_dose_date || null,
      batch_number: data.batch_number || null,
      manufacturer: data.manufacturer || null,
      applied_by: data.applied_by || null,
      site: data.site || null,
      notes: data.notes || null,
      created_by: createdBy,
    })
    .select()
    .single();

  if (error) {
    console.error('[PRONTUARIO] Erro ao registrar vacina:', error.message);
    throw new Error('Falha ao registrar vacina');
  }

  return created;
}

export async function getVaccines(supabase, clinicId, patientId) {
  const { data, error } = await supabase
    .from('patient_vaccines')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('patient_id', patientId)
    .order('application_date', { ascending: false });

  if (error) {
    console.error('[PRONTUARIO] Erro ao listar vacinas:', error.message);
    throw new Error('Falha ao listar vacinas');
  }

  return data;
}

// ============================================================
// HISTÓRICO FAMILIAR (patient_family_history)
// ============================================================

export async function addFamilyHistory(supabase, clinicId, patientId, data, createdBy) {
  const { data: created, error } = await supabase
    .from('patient_family_history')
    .insert({
      clinic_id: clinicId,
      patient_id: patientId,
      relationship: data.relationship,
      condition: data.condition,
      notes: data.notes || null,
      deceased: data.deceased || false,
      created_by: createdBy,
    })
    .select()
    .single();

  if (error) {
    console.error('[PRONTUARIO] Erro ao adicionar histórico familiar:', error.message);
    throw new Error('Falha ao adicionar histórico familiar');
  }

  return created;
}

export async function getFamilyHistory(supabase, clinicId, patientId) {
  const { data, error } = await supabase
    .from('patient_family_history')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('patient_id', patientId)
    .order('relationship', { ascending: true });

  if (error) {
    console.error('[PRONTUARIO] Erro ao listar histórico familiar:', error.message);
    throw new Error('Falha ao listar histórico familiar');
  }

  return data;
}

// ============================================================
// DOCUMENTOS (patient_documents)
// ============================================================

export async function addDocument(supabase, clinicId, patientId, data, createdBy) {
  const { data: created, error } = await supabase
    .from('patient_documents')
    .insert({
      clinic_id: clinicId,
      patient_id: patientId,
      consultation_id: data.consultation_id || null,
      document_type: data.document_type,
      document_name: data.document_name,
      file_url: data.file_url || null,
      file_size_bytes: data.file_size_bytes || null,
      mime_type: data.mime_type || null,
      description: data.description || null,
      tags: data.tags || [],
      created_by: createdBy,
    })
    .select()
    .single();

  if (error) {
    console.error('[PRONTUARIO] Erro ao adicionar documento:', error.message);
    throw new Error('Falha ao adicionar documento');
  }

  return created;
}

export async function getDocuments(supabase, clinicId, patientId, documentType = null) {
  let query = supabase
    .from('patient_documents')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('patient_id', patientId)
    .order('created_at', { ascending: false });

  if (documentType) query = query.eq('document_type', documentType);

  const { data, error } = await query;

  if (error) {
    console.error('[PRONTUARIO] Erro ao listar documentos:', error.message);
    throw new Error('Falha ao listar documentos');
  }

  return data;
}

// ============================================================
// RESUMO COMPLETO DO PRONTUÁRIO
// ============================================================

export async function getPatientSummary(supabase, clinicId, patientId) {
  const [
    patientResult,
    recordResult,
    consultationsResult,
    vitalsResult,
    allergiesResult,
    medicationsResult,
    diagnosesResult,
    vaccinesResult,
    familyHistoryResult,
  ] = await Promise.all([
    supabase.from('patients').select('id, name, phone, email, birth_date, cpf, address').eq('clinic_id', clinicId).eq('id', patientId).maybeSingle(),
    supabase.from('patient_records').select('*').eq('clinic_id', clinicId).eq('patient_id', patientId).maybeSingle(),
    supabase.from('patient_consultations').select('id, consultation_date, consultation_type, chief_complaint, status, doctor_id, doctors(name)').eq('clinic_id', clinicId).eq('patient_id', patientId).order('consultation_date', { ascending: false }).limit(5),
    supabase.from('patient_vitals').select('*').eq('clinic_id', clinicId).eq('patient_id', patientId).order('measured_at', { ascending: false }).limit(1),
    supabase.from('patient_allergies').select('*').eq('clinic_id', clinicId).eq('patient_id', patientId),
    supabase.from('patient_medications').select('*').eq('clinic_id', clinicId).eq('patient_id', patientId).eq('active', true),
    supabase.from('patient_diagnoses').select('*').eq('clinic_id', clinicId).eq('patient_id', patientId).in('status', ['ativo', 'cronico']),
    supabase.from('patient_vaccines').select('vaccine_name, dose_number, application_date, next_dose_date').eq('clinic_id', clinicId).eq('patient_id', patientId).order('application_date', { ascending: false }).limit(10),
    supabase.from('patient_family_history').select('*').eq('clinic_id', clinicId).eq('patient_id', patientId),
  ]);

  if (patientResult.error) throw new Error('Falha ao buscar dados do paciente');
  if (!patientResult.data) return null;

  return {
    patient: patientResult.data,
    record: recordResult.data || null,
    recent_consultations: consultationsResult.data || [],
    latest_vitals: vitalsResult.data?.[0] || null,
    allergies: allergiesResult.data || [],
    active_medications: medicationsResult.data || [],
    active_diagnoses: diagnosesResult.data || [],
    vaccines: vaccinesResult.data || [],
    family_history: familyHistoryResult.data || [],
  };
}

// ============================================================
// AUDITORIA LGPD (patient_record_audit)
// ============================================================

export async function logAudit(supabase, clinicId, patientId, userId, action, resourceType, resourceId = null, details = {}) {
  const { error } = await supabase
    .from('patient_record_audit')
    .insert({
      clinic_id: clinicId,
      patient_id: patientId,
      user_id: userId,
      action,
      resource_type: resourceType,
      resource_id: resourceId,
      details,
    });

  if (error) {
    console.error('[PRONTUARIO] Erro ao registrar auditoria (não-crítico):', error.message);
  }
}
