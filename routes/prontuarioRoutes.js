/**
 * prontuarioRoutes.js — F11 Prontuário Eletrônico
 * BASE PATH: /crm/api/prontuario
 */

import { Router } from 'express';
import { trackedChatCompletion } from '../lib/openaiTracker.js';
import {
  getOrCreateRecord, updateRecord,
  createConsultation, getConsultations, getConsultation, updateConsultation,
  addVitals, getVitals,
  addAllergy, getAllergies, deleteAllergy,
  addMedication, getMedications, updateMedication,
  addDiagnosis, getDiagnoses, updateDiagnosis,
  createPrescription, getPrescriptions,
  createExamRequest, getExamRequests, updateExamRequest,
  addVaccine, getVaccines,
  addFamilyHistory, getFamilyHistory,
  addDocument, getDocuments,
  getPatientSummary, logAudit,
} from '../services/prontuarioService.js';

export default function createProntuarioRouter(supabase) {
  const router = Router();

  // RESUMO
  router.get('/patient/:patientId/summary', async (req, res) => {
    try {
      const { patientId } = req.params;
      const { clinicId, userId } = req;
      const summary = await getPatientSummary(supabase, clinicId, patientId);
      if (!summary) return res.status(404).json({ error: 'Paciente não encontrado' });
      logAudit(supabase, clinicId, patientId, userId, 'view', 'record', null, { action: 'summary_loaded' });
      return res.json(summary);
    } catch (err) {
      console.error('[PRONTUARIO ROUTE] GET /summary:', err.message);
      return res.status(500).json({ error: 'Erro ao carregar prontuário' });
    }
  });

  // PRONTUÁRIO BASE
  router.get('/patient/:patientId/record', async (req, res) => {
    try {
      const record = await getOrCreateRecord(supabase, req.clinicId, req.params.patientId, req.userId);
      return res.json(record);
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao buscar prontuário base' });
    }
  });

  router.put('/patient/:patientId/record', async (req, res) => {
    try {
      if (!req.body || Object.keys(req.body).length === 0) return res.status(400).json({ error: 'Nenhum dado fornecido' });
      const updated = await updateRecord(supabase, req.clinicId, req.params.patientId, req.body);
      logAudit(supabase, req.clinicId, req.params.patientId, req.userId, 'update', 'record', updated.id, { fields: Object.keys(req.body) });
      return res.json(updated);
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao atualizar prontuário base' });
    }
  });

  // CONSULTAS
  router.get('/patient/:patientId/consultations', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 20;
      const offset = parseInt(req.query.offset) || 0;
      const data = await getConsultations(supabase, req.clinicId, req.params.patientId, { limit, offset });
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao listar consultas' });
    }
  });

  router.post('/patient/:patientId/consultations', async (req, res) => {
    try {
      const consultation = await createConsultation(supabase, req.clinicId, req.params.patientId, req.body, req.userId);
      logAudit(supabase, req.clinicId, req.params.patientId, req.userId, 'create', 'consultation', consultation.id);
      return res.status(201).json(consultation);
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao criar consulta' });
    }
  });

  router.get('/consultation/:id', async (req, res) => {
    try {
      const consultation = await getConsultation(supabase, req.clinicId, req.params.id);
      if (!consultation) return res.status(404).json({ error: 'Consulta não encontrada' });
      logAudit(supabase, req.clinicId, consultation.patient_id, req.userId, 'view', 'consultation', req.params.id);
      return res.json(consultation);
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao buscar consulta' });
    }
  });

  router.put('/consultation/:id', async (req, res) => {
    try {
      if (!req.body || Object.keys(req.body).length === 0) return res.status(400).json({ error: 'Nenhum dado fornecido' });
      const updated = await updateConsultation(supabase, req.clinicId, req.params.id, req.body);
      logAudit(supabase, req.clinicId, updated.patient_id, req.userId, 'update', 'consultation', req.params.id, { fields: Object.keys(req.body) });
      return res.json(updated);
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao atualizar consulta' });
    }
  });

  // Rota alternativa: registrar vitais diretamente pelo patientId (sem consultation_id obrigatorio)
  router.post('/patient/:patientId/vitals', async (req, res) => {
    try {
      const { patientId } = req.params;
      const { clinicId, userId } = req;
      const vitals = await addVitals(supabase, clinicId, patientId, null, req.body, userId);
      logAudit(supabase, clinicId, patientId, userId, 'create', 'vitals', vitals.id);
      return res.status(201).json(vitals);
    } catch (err) {
      console.error('[PRONTUARIO ROUTE] POST /patient/vitals:', err.message);
      return res.status(500).json({ error: 'Erro ao registrar sinais vitais' });
    }
  });

  // SINAIS VITAIS
  router.post('/consultation/:id/vitals', async (req, res) => {
    try {
      const { patient_id: patientId } = req.body;
      if (!patientId) return res.status(400).json({ error: 'patient_id é obrigatório' });
      const vitals = await addVitals(supabase, req.clinicId, patientId, req.params.id, req.body, req.userId);
      logAudit(supabase, req.clinicId, patientId, req.userId, 'create', 'vitals', vitals.id);
      return res.status(201).json(vitals);
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao registrar sinais vitais' });
    }
  });

  router.get('/patient/:patientId/vitals', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 30;
      const data = await getVitals(supabase, req.clinicId, req.params.patientId, limit);
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ error: 'Erro ao listar sinais vitais' });
    }
  });

  // ALERGIAS
  router.get('/patient/:patientId/allergies', async (req, res) => {
    try {
      return res.json(await getAllergies(supabase, req.clinicId, req.params.patientId));
    } catch (err) { return res.status(500).json({ error: 'Erro ao listar alergias' }); }
  });

  router.post('/patient/:patientId/allergies', async (req, res) => {
    try {
      if (!req.body.allergen) return res.status(400).json({ error: 'allergen é obrigatório' });
      const created = await addAllergy(supabase, req.clinicId, req.params.patientId, req.body, req.userId);
      logAudit(supabase, req.clinicId, req.params.patientId, req.userId, 'create', 'allergy', created.id);
      return res.status(201).json(created);
    } catch (err) { return res.status(500).json({ error: 'Erro ao adicionar alergia' }); }
  });

  router.delete('/allergy/:id', async (req, res) => {
    try {
      await deleteAllergy(supabase, req.clinicId, req.params.id);
      logAudit(supabase, req.clinicId, null, req.userId, 'delete', 'allergy', req.params.id);
      return res.json({ success: true });
    } catch (err) { return res.status(500).json({ error: 'Erro ao remover alergia' }); }
  });

  // MEDICAMENTOS
  router.get('/patient/:patientId/medications', async (req, res) => {
    try {
      return res.json(await getMedications(supabase, req.clinicId, req.params.patientId, req.query.active === 'true'));
    } catch (err) { return res.status(500).json({ error: 'Erro ao listar medicamentos' }); }
  });

  router.post('/patient/:patientId/medications', async (req, res) => {
    try {
      if (!req.body.name) return res.status(400).json({ error: 'name do medicamento é obrigatório' });
      const created = await addMedication(supabase, req.clinicId, req.params.patientId, req.body, req.userId);
      logAudit(supabase, req.clinicId, req.params.patientId, req.userId, 'create', 'medication', created.id);
      return res.status(201).json(created);
    } catch (err) { return res.status(500).json({ error: 'Erro ao adicionar medicamento' }); }
  });

  router.put('/medication/:id', async (req, res) => {
    try {
      return res.json(await updateMedication(supabase, req.clinicId, req.params.id, req.body));
    } catch (err) { return res.status(500).json({ error: 'Erro ao atualizar medicamento' }); }
  });

  // DIAGNÓSTICOS
  router.get('/patient/:patientId/diagnoses', async (req, res) => {
    try {
      return res.json(await getDiagnoses(supabase, req.clinicId, req.params.patientId));
    } catch (err) { return res.status(500).json({ error: 'Erro ao listar diagnósticos' }); }
  });

  router.post('/consultation/:id/diagnoses', async (req, res) => {
    try {
      const { patient_id: patientId } = req.body;
      if (!patientId) return res.status(400).json({ error: 'patient_id é obrigatório' });
      const created = await addDiagnosis(supabase, req.clinicId, patientId, req.params.id, req.body, req.userId);
      logAudit(supabase, req.clinicId, patientId, req.userId, 'create', 'diagnosis', created.id);
      return res.status(201).json(created);
    } catch (err) { return res.status(500).json({ error: 'Erro ao adicionar diagnóstico' }); }
  });

  router.put('/diagnosis/:id', async (req, res) => {
    try {
      return res.json(await updateDiagnosis(supabase, req.clinicId, req.params.id, req.body));
    } catch (err) { return res.status(500).json({ error: 'Erro ao atualizar diagnóstico' }); }
  });

  // PRESCRIÇÕES
  router.get('/patient/:patientId/prescriptions', async (req, res) => {
    try {
      return res.json(await getPrescriptions(supabase, req.clinicId, req.params.patientId, parseInt(req.query.limit) || 20));
    } catch (err) { return res.status(500).json({ error: 'Erro ao listar prescrições' }); }
  });

  router.post('/consultation/:id/prescriptions', async (req, res) => {
    try {
      const { patient_id: patientId } = req.body;
      if (!patientId) return res.status(400).json({ error: 'patient_id é obrigatório' });
      if (!req.body.items || !Array.isArray(req.body.items) || req.body.items.length === 0) return res.status(400).json({ error: 'items é obrigatório e não pode ser vazio' });
      const created = await createPrescription(supabase, req.clinicId, patientId, req.params.id, req.body, req.userId);
      logAudit(supabase, req.clinicId, patientId, req.userId, 'create', 'prescription', created.id);
      return res.status(201).json(created);
    } catch (err) { return res.status(500).json({ error: 'Erro ao criar prescrição' }); }
  });

  // EXAMES
  router.get('/patient/:patientId/exams', async (req, res) => {
    try {
      return res.json(await getExamRequests(supabase, req.clinicId, req.params.patientId, parseInt(req.query.limit) || 20));
    } catch (err) { return res.status(500).json({ error: 'Erro ao listar solicitações de exames' }); }
  });

  router.post('/consultation/:id/exams', async (req, res) => {
    try {
      const { patient_id: patientId } = req.body;
      if (!patientId) return res.status(400).json({ error: 'patient_id é obrigatório' });
      if (!req.body.exams || !Array.isArray(req.body.exams) || req.body.exams.length === 0) return res.status(400).json({ error: 'exams é obrigatório e não pode ser vazio' });
      const created = await createExamRequest(supabase, req.clinicId, patientId, req.params.id, req.body, req.userId);
      logAudit(supabase, req.clinicId, patientId, req.userId, 'create', 'exam_request', created.id);
      return res.status(201).json(created);
    } catch (err) { return res.status(500).json({ error: 'Erro ao criar solicitação de exames' }); }
  });

  router.put('/exam/:id', async (req, res) => {
    try {
      return res.json(await updateExamRequest(supabase, req.clinicId, req.params.id, req.body));
    } catch (err) { return res.status(500).json({ error: 'Erro ao atualizar solicitação de exame' }); }
  });

  // VACINAS
  router.get('/patient/:patientId/vaccines', async (req, res) => {
    try {
      return res.json(await getVaccines(supabase, req.clinicId, req.params.patientId));
    } catch (err) { return res.status(500).json({ error: 'Erro ao listar vacinas' }); }
  });

  router.post('/patient/:patientId/vaccines', async (req, res) => {
    try {
      if (!req.body.vaccine_name) return res.status(400).json({ error: 'vaccine_name é obrigatório' });
      const created = await addVaccine(supabase, req.clinicId, req.params.patientId, req.body, req.userId);
      logAudit(supabase, req.clinicId, req.params.patientId, req.userId, 'create', 'vaccine', created.id);
      return res.status(201).json(created);
    } catch (err) { return res.status(500).json({ error: 'Erro ao registrar vacina' }); }
  });

  // HISTÓRICO FAMILIAR
  router.get('/patient/:patientId/family-history', async (req, res) => {
    try {
      return res.json(await getFamilyHistory(supabase, req.clinicId, req.params.patientId));
    } catch (err) { return res.status(500).json({ error: 'Erro ao listar histórico familiar' }); }
  });

  router.post('/patient/:patientId/family-history', async (req, res) => {
    try {
      if (!req.body.relationship || !req.body.condition) return res.status(400).json({ error: 'relationship e condition são obrigatórios' });
      const created = await addFamilyHistory(supabase, req.clinicId, req.params.patientId, req.body, req.userId);
      return res.status(201).json(created);
    } catch (err) { return res.status(500).json({ error: 'Erro ao adicionar histórico familiar' }); }
  });

  // DOCUMENTOS
  router.get('/patient/:patientId/documents', async (req, res) => {
    try {
      return res.json(await getDocuments(supabase, req.clinicId, req.params.patientId, req.query.type || null));
    } catch (err) { return res.status(500).json({ error: 'Erro ao listar documentos' }); }
  });

  router.post('/patient/:patientId/documents', async (req, res) => {
    try {
      if (!req.body.document_type || !req.body.document_name) return res.status(400).json({ error: 'document_type e document_name são obrigatórios' });
      const created = await addDocument(supabase, req.clinicId, req.params.patientId, req.body, req.userId);
      logAudit(supabase, req.clinicId, req.params.patientId, req.userId, 'create', 'document', created.id);
      return res.status(201).json(created);
    } catch (err) { return res.status(500).json({ error: 'Erro ao registrar documento' }); }
  });

  // ============================================================
  // LARA ASSIST — IA de suporte ao atendimento medico
  // ============================================================

  /**
   * POST /lara-assist
   * Recebe contexto da consulta e retorna sugestao da IA.
   * action: 'soap' | 'cid' | 'resumo' | 'exames' | 'interacoes'
   */
  router.post('/lara-assist', async (req, res) => {
    const { action, context } = req.body;
    const { clinicId } = req;

    if (!action || !context) {
      return res.status(400).json({ error: 'action e context sao obrigatorios' });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const OPENAI_MODEL   = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    if (!OPENAI_API_KEY) {
      return res.status(503).json({ error: 'OpenAI nao configurada no servidor' });
    }

    const prompts = {
      soap: 'Voce e a Lara, assistente medica de IA do CLINICORE. Com base na queixa e contexto abaixo, gere um rascunho estruturado de nota SOAP (Subjetivo, Objetivo, Avaliacao, Plano) para auxiliar o medico. Seja clinico, objetivo e use terminologia medica adequada. Deixe claro que e um rascunho para o medico revisar.\n\nContexto: ' + context,
      cid: 'Voce e a Lara, assistente medica de IA do CLINICORE. Com base nos sintomas e queixa abaixo, sugira os 3 CIDs mais provaveis com codigo e descricao. Formato: "CID | Descricao | Justificativa breve". Seja objetivo.\n\nContexto: ' + context,
      resumo: 'Voce e a Lara, assistente medica de IA do CLINICORE. Faca um resumo clinico estruturado do paciente com base nas informacoes abaixo. Destaque: diagnosticos ativos, medicamentos em uso, alergias, e ultimas consultas. Use linguagem medica precisa.\n\nContexto: ' + context,
      exames: 'Voce e a Lara, assistente medica de IA do CLINICORE. Com base no diagnostico e queixa abaixo, sugira os exames complementares mais pertinentes. Para cada exame, indique a justificativa clinica. Seja objetivo e pratico.\n\nContexto: ' + context,
      interacoes: 'Voce e a Lara, assistente medica de IA do CLINICORE. Analise a lista de medicamentos abaixo e identifique possiveis interacoes medicamentosas relevantes. Para cada interacao encontrada, indique o nivel de gravidade (leve/moderada/grave) e a conduta recomendada. Se nao houver interacoes relevantes, informe isso claramente.\n\nMedicamentos: ' + context,
    };

    const prompt = prompts[action];
    if (!prompt) {
      return res.status(400).json({ error: 'action invalida. Use: soap, cid, resumo, exames, interacoes' });
    }

    try {
      const { default: OpenAI } = await import('openai');
      const openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });

      const completion = await trackedChatCompletion({
        client: openaiClient,
        clinicId,
        purpose: 'prontuario_lara_assist',
        metadata: { action },
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: 'Voce e a Lara, assistente medica de IA do CLINICORE. Responda sempre em portugues brasileiro. Seja clinico, preciso e conciso. Nunca substitua o julgamento medico — voce auxilia, nao decide.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 800,
        temperature: 0.4,
      });

      const resposta = completion.choices[0] && completion.choices[0].message && completion.choices[0].message.content ? completion.choices[0].message.content : 'Sem resposta da IA.';
      return res.json({ result: resposta, action, tokens: completion.usage ? completion.usage.total_tokens : 0 });

    } catch (err) {
      console.error('[LARA ASSIST] Erro OpenAI:', err.message);
      return res.status(500).json({ error: 'Erro ao chamar IA: ' + err.message });
    }
  });

  return router;
}
