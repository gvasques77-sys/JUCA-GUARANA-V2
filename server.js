import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import pino from 'pino';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import { fileURLToPath } from 'url';
import adminRoutes from './routes/adminRoutes.js';
import googleCalendarRoutes from './routes/googleCalendarRoutes.js';
import { schedulingToolsDefinitions, executeSchedulingTool } from './tools/schedulingTools.js';
import { redisHealthCheck } from './services/redisService.js';
import { getOrCreateConversation, updateConversationTurn, finalizeConversation } from './services/conversationTracker.js';
import { processPostConversation } from './services/crmService.js';
import { startTaskProcessor } from './services/taskProcessor.js';
import { createCrmApiRouter } from './routes/crmDashboardRoutes.js';
import campaignRoutes from './routes/campaignRoutes.js';
import { startCampaignScheduler } from './services/campaignService.js';



// ======================================================
// STATE MACHINE — Estados explícitos do fluxo de agendamento
// ======================================================

// FIX 1 — Constantes para busca aberta (sem data específica)
const BUSCA_SLOTS_ABERTA_DIAS = 30  // quantos dias à frente buscar
const BUSCA_SLOTS_ABERTA_MAX  = 5   // quantos slots retornar no máximo

// FIX 3 — Limite de tentativas antes de fallback definitivo
const STUCK_LIMIT = 3

// ======================================================
// TAREFA 2 — FIX 1: Mapeamento direto de intenções curtas
// Intercepta respostas de 1-2 palavras ANTES do LLM
// ======================================================
const INTENCOES_DIRETAS = {
  'continuar':        'continue_booking',
  'continuar agendamento': 'continue_booking',
  'quero continuar':  'continue_booking',
  // Saudações por horário (interceptar antes do LLM — resposta simples)
  'oi':               'greeting',
  'ola':              'greeting',
  'oi tudo bem':      'greeting',
  'tudo bem':         'greeting',
  'bom dia':          'greeting',
  'boa tarde':        'greeting',
  'boa noite':        'greeting',
  'oi boa noite':     'greeting',
  'oi boa tarde':     'greeting',
  'oi bom dia':       'greeting',
  'ola bom dia':      'greeting',
  'ola boa tarde':    'greeting',
  'ola boa noite':    'greeting',
  'hey':              'greeting',
  'hello':            'greeting',
  'marcar':           'schedule_new',
  'agendar':          'schedule_new',
  'consulta':         'schedule_new',
  'quero marcar':     'schedule_new',
  'queria marcar':    'schedule_new',
  'quero agendar':    'schedule_new',
  'queria agendar':   'schedule_new',
  'marcar consulta':  'schedule_new',
  'agendar consulta': 'schedule_new',
  'remarcar':         'reschedule',
  'reagendar':        'reschedule',
  'remarcar consulta':'reschedule',
  'reagendar consulta':'reschedule',
  'quero reagendar':  'reschedule',
  'quero remarcar':   'reschedule',
  'reagendar meu horario':'reschedule',
  'quero reagendar meu horario':'reschedule',
  'cancelar':         'cancel',
  'desmarcar':        'cancel',
  'cancelar consulta':'cancel',
  'duvida':           'info',
  'informacao':       'info',
  'informacoes':      'info',
  'tirar duvida':     'info',
  'tirar uma duvida': 'info',
  'tenho uma duvida': 'info',
  'qual medico':          'info',
  'quais medicos':        'info',
  'que medico':           'info',
  'qual especialidade':   'info',
  'quais especialidades': 'info',
  'que especialidade':    'info',
  'qual nome de especialidade e medico': 'info',
  'quais sao os medicos': 'info',
  'lista de medicos':     'info',
  'medicos disponiveis':  'info',
  'valor':            'info',
  'precos':           'info',
  'preco':            'info',
  'valores':          'info',
  'convenios':        'info',
  'convenio':         'info',
  'plano de saude':   'info',
  'parcelamento':     'info',
  'parcela':          'info',
  'formas de pagamento': 'info',
  'forma de pagamento':  'info',
  'aceita cartao':    'info',
  'tem horario':      'check_availability',
  'tem vaga':         'check_availability',
  'horario disponivel':'check_availability',
  'encaixe':          'schedule_encaixe',
  'encaixar':         'schedule_encaixe',
  'meus agendamentos':      'view_appointments',
  'ver meus agendamentos':  'view_appointments',
  'quero ver meus agendamentos': 'view_appointments',
  'minhas consultas':       'view_appointments',
  'meus horarios':          'view_appointments',
  'meu agendamento':        'view_appointments',
  'minha consulta':         'view_appointments',
  'qual minha consulta':    'view_appointments',
  'qual meu agendamento':   'view_appointments',
  'qual meu horario':       'view_appointments',
  'minha agenda':           'view_appointments',
  'qual minha agenda':      'view_appointments',
  'ver minha agenda':       'view_appointments',
  'o que agendei':          'view_appointments',
  'quando e minha consulta':'view_appointments',
  'quando e meu horario':   'view_appointments',
  'esta semana':            'week_current',
  'essa semana':            'week_current',
  'semana atual':           'week_current',
  'proxima semana':         'week_next',
  'semana que vem':         'week_next',
}

/**
 * Detector de perguntas informativas por padrão (não exige match exato).
 * Detecta frases como "qual o valor da consulta com psicólogo",
 * "vocês aceitam unimed?", "parcelam em quantas vezes?", etc.
 * @param {string} text
 * @returns {boolean}
 */
function detectInfoQuestion(text) {
  if (!text) return false;
  const normalized = text.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '').trim();
  const INFO_PATTERNS = [
    /\b(valor|preco|precos|valores|custa|custo)\b/,
    /\b(convenio|convenios|plano|planos|unimed|bradesco|amil|sulamerica|porto seguro)\b/,
    /\b(parcela|parcelam|parcelamento|cartao|credito|debito|pix|pagamento)\b/,
    /\b(duracao|dura|quanto tempo|demora)\b.*\b(consulta|procedimento|atendimento|sessao)\b/,
    /\bquanto\b.*\b(custa|cobra|sai|fica|paga)\b/,
    /\bqual\b.*\b(valor|preco)\b/,
    /\baceitam?\b.*\b(convenio|plano|cartao)\b/,
    /\b(formas?|meios?)\b.*\bpagamento\b/,
    /\bgostaria\b.*\b(saber|informac)\b/,
    /\bquero\b.*\b(saber|informac)\b/,
    /\b(tirar|tenho)\b.*\b(duvida|duvidas)\b/,
  ];
  return INFO_PATTERNS.some(p => p.test(normalized));
}

/**
 * Interceptor de intenções curtas — executa ANTES do LLM.
 * Normaliza o input (lowercase + sem acentos) e verifica match exato.
 * @param {string} text - Texto da mensagem do usuário
 * @returns {string|null} intent mapeado ou null se não houver match
 */
function interceptarIntencaoDireta(text) {
  if (!text) return null;
  const normalized = text.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '').trim();
  return INTENCOES_DIRETAS[normalized] || null;
}

// ======================================================
// CAMADA 1: Helper para mapear intent → intent_group
// ======================================================
function resolveIntentGroup(intent) {
  const SCHEDULING_INTENTS = ['schedule_new', 'view_appointments', 'try_other_date', 'try_other_doctor', 'confirm_yes', 'confirm_no', 'week_current', 'week_next'];
  const HANDOFF_INTENTS    = ['human_handoff', 'ask_question'];
  if (SCHEDULING_INTENTS.includes(intent)) return 'scheduling';
  if (HANDOFF_INTENTS.includes(intent))    return 'other';
  return 'other';
}

// ======================================================
// TAREFA 2 — FIX 3: Constante de timeout de sessão
// ======================================================
const SESSION_TIMEOUT_MINUTES = 30

// ======================================================
// TAREFA 2 — FIX 4: Estado machine de agendamento
// BOOKING_STAGES foi removido — era duplicata inutilizada de BOOKING_STATES.
// ======================================================
const BOOKING_STATES = {
  IDLE: 'idle',
  COLLECTING_SPECIALTY: 'collecting_specialty',
  COLLECTING_DOCTOR: 'collecting_doctor',
  COLLECTING_DATE: 'collecting_date',
  AWAITING_SLOTS: 'awaiting_slots',     // chamou verificar_disponibilidade, aguardando escolha
  COLLECTING_TIME: 'collecting_time',
  CONFIRMING: 'confirming',             // mostrou resumo, aguardando "sim"
  BOOKED: 'booked',
  RESCHEDULING: 'rescheduling',
  CANCELLING: 'cancelling',
};

// Para usar __dirname com ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
// Captura rawBody para validação HMAC antes do parse.
// O verify callback é executado pelo express.json ANTES de deserializar.
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// ======================================================
// PAINEL ADMINISTRATIVO (RECEPÇÃO)
// ======================================================
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));
app.use('/admin', adminRoutes);
app.use('/admin/gcal', googleCalendarRoutes);

// ======================================================
// DASHBOARD CRM (Fase 4)
// ======================================================
// API endpoints em /crm/api/* (montados após criação do supabase client, abaixo)
// SPA estática em /crm/*
app.use('/crm', express.static(path.join(__dirname, 'public', 'crm')));
// Fallback SPA: qualquer rota /crm/ que não seja /crm/api ou /crm/login retorna o index.html
// Usa regex em vez de '/crm/*' para compatibilidade com path-to-regexp v8+
app.get(/^\/crm\/(?!api|login).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'crm', 'index.html'));
});

const log = pino({
  transport: { target: 'pino-pretty' },
});

// ======================================================
// VARIÁVEIS DE AMBIENTE
// ======================================================
const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Avisos se variáveis estiverem faltando
if (!OPENAI_API_KEY) log.warn('⚠️  OPENAI_API_KEY não definido (coloque no .env)');
if (!SUPABASE_URL) log.warn('⚠️  SUPABASE_URL não definido (coloque no .env)');
if (!SUPABASE_SERVICE_ROLE_KEY) log.warn('⚠️  SUPABASE_SERVICE_ROLE_KEY não definido (coloque no .env)');

// Inicializar clientes
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY || 'missing',
  ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
});

const supabase = createClient(
  SUPABASE_URL || 'missing',
  SUPABASE_SERVICE_ROLE_KEY || 'missing',
  { auth: { persistSession: false } }
);

// — F9D: Campaign API (must be before generic CRM routes) —
import { authMiddleware } from './middleware/authMiddleware.js';
app.use('/crm/api/campaigns', authMiddleware(supabase), campaignRoutes);

// — CRM Dashboard API (montada aqui porque depende do supabase client) —
app.use('/crm/api', createCrmApiRouter(supabase));



// ======================================================
// SCHEMA DE VALIDAÇÃO (Zod)
// ======================================================
const ClinicIdSchema = z.string().uuid('clinic_id precisa ser um UUID valido');

const EnvelopeSchema = z.object({
  correlation_id: z.string().min(6),
  clinic_id: ClinicIdSchema,
  from: z.string().min(5),
  message_text: z.string().min(1),
  phone_number_id: z.string().optional(),
  received_at_iso: z.string().optional(),
  intent_override: z.string().optional(), // CAMADA 1: intent pré-classificada por botão interativo
  context: z
    .object({
      previous_messages: z
        .array(z.object({ role: z.string(), content: z.string() }))
        .optional(),
    })
    .optional(),
});

const fallbackClinicId = '09e5240f-9c26-47ee-a54d-02934a36ebfd';
const sampleClinicIdCandidate =
  process.env.DEFAULT_CLINIC_ID || process.env.CLINIC_ID || fallbackClinicId;
const sampleClinicId = ClinicIdSchema.safeParse(sampleClinicIdCandidate).success
  ? sampleClinicIdCandidate
  : fallbackClinicId;

const sampleEnvelope = {
  correlation_id: 'abc123456',
  clinic_id: sampleClinicId,
  from: '5511999999999',
  message_text: 'Quero marcar consulta amanha',
  phone_number_id: 'whatsapp-123',
  received_at_iso: '2026-02-16T20:00:00.000Z',
};

// ======================================================
// AUTENTICAÇÃO DO /process (JG-P0-004)
// ======================================================
const AGENT_API_KEY = process.env.AGENT_API_KEY;
if (!AGENT_API_KEY) {
  log.warn('⚠️  AGENT_API_KEY não definido — /process está aberto (apenas dev)');
}

function checkAgentAuth(req, res, next) {
  if (!AGENT_API_KEY) return next(); // dev mode sem key: permite

  const key =
    req.headers['x-api-key'] ||
    (req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null);

  if (!key || key !== AGENT_API_KEY) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'x-api-key ou Authorization: Bearer <token> requerido.',
    });
  }
  next();
}

// ======================================================
// HMAC SIGNATURE VALIDATION (JG-SEC-001)
// Protege /process contra payloads forjados.
// O n8n Worker assina o body com N8N_WEBHOOK_SECRET antes de enviar.
// Header esperado: X-Webhook-Signature: sha256=<hex>
// Se N8N_WEBHOOK_SECRET não está definido: modo dev (bypass).
// ======================================================
const N8N_WEBHOOK_SECRET = process.env.N8N_WEBHOOK_SECRET;
if (!N8N_WEBHOOK_SECRET) {
  log.warn('⚠️  N8N_WEBHOOK_SECRET não definido — validação HMAC desabilitada (apenas dev)');
}

function verifyWebhookSignature(req, res, next) {
  if (!N8N_WEBHOOK_SECRET) return next(); // dev mode

  const sigHeader = req.headers['x-webhook-signature'];
  if (!sigHeader) {
    log.warn({ path: req.path }, '[HMAC] Header X-Webhook-Signature ausente');
    return res.status(401).json({ error: 'missing_signature' });
  }

  const rawBody = req.rawBody ?? Buffer.alloc(0);
  const expected = 'sha256=' + createHmac('sha256', N8N_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  // timingSafeEqual previne timing attacks
  try {
    const a = Buffer.from(sigHeader.padEnd(expected.length));
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      log.warn({ sig: sigHeader.substring(0, 16) + '…' }, '[HMAC] Assinatura inválida');
      return res.status(401).json({ error: 'invalid_signature' });
    }
  } catch {
    return res.status(401).json({ error: 'invalid_signature' });
  }

  next();
}

// ======================================================
// ROTA DE HEALTH CHECK
// ======================================================
app.get('/health', async (req, res) => {
    const redis = await redisHealthCheck();
    return res.json({ ok: true, service: 'agent-service', redis });
});

// Rota amigavel para navegador
app.get('/', (req, res) => {
  return res.json({
    ok: true,
    service: 'agent-service',
    endpoints: {
      health: 'GET /health',
      tester: 'GET /process',
      process: 'POST /process',
    },
  });
});

// /process aceita apenas POST com JSON
app.get('/process', (req, res) => {
  const acceptHeader = req.get('accept') || '';
  const wantsHtml = acceptHeader.includes('text/html');

  if (wantsHtml) {
    return res.status(200).type('html').send(`<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tester /process</title>
  <style>
    body { font-family: Segoe UI, sans-serif; max-width: 860px; margin: 24px auto; padding: 0 14px; }
    h1 { margin-bottom: 8px; }
    p { margin-top: 0; color: #333; }
    textarea { width: 100%; min-height: 240px; font-family: Consolas, monospace; font-size: 13px; padding: 10px; }
    button { margin-top: 10px; padding: 10px 14px; cursor: pointer; }
    pre { background: #f6f8fa; border: 1px solid #ddd; padding: 12px; overflow: auto; }
    .small { color: #444; font-size: 13px; }
  </style>
</head>
<body>
  <h1>Tester local: POST /process</h1>
  <p>Cole ou edite o JSON abaixo e clique em <b>Enviar</b>.</p>
  <textarea id="payload">${JSON.stringify(sampleEnvelope, null, 2)}</textarea>
  <br />
  <button id="sendBtn">Enviar para /process</button>
  <p class="small">Dica: use um clinic_id em formato UUID (de preferencia um clinic_id real do seu banco).</p>
  <h3>Resposta</h3>
  <pre id="result">Aguardando envio...</pre>
  <script>
    const btn = document.getElementById('sendBtn');
    const payloadField = document.getElementById('payload');
    const result = document.getElementById('result');
    btn.addEventListener('click', async () => {
      result.textContent = 'Enviando...';
      let payload;
      try {
        payload = JSON.parse(payloadField.value);
      } catch (e) {
        result.textContent = 'JSON invalido: ' + e.message;
        return;
      }
      try {
        const resp = await fetch('/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const text = await resp.text();
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        result.textContent = JSON.stringify(
          { status: resp.status, statusText: resp.statusText, body: parsed },
          null,
          2
        );
      } catch (e) {
        result.textContent = 'Falha na requisicao: ' + e.message;
      }
    });
  </script>
</body>
</html>`);
  }

  res.set('Allow', 'POST');
  return res.status(405).json({
    error: 'method_not_allowed',
    message: 'Use POST /process com Content-Type: application/json.',
    allow: ['POST'],
    example_body: sampleEnvelope,
    examples: {
      curl:
        'curl -X POST http://localhost:3000/process -H "Content-Type: application/json" -d "{\\"correlation_id\\":\\"abc123456\\",\\"clinic_id\\":\\"09e5240f-9c26-47ee-a54d-02934a36ebfd\\",\\"from\\":\\"5511999999999\\",\\"message_text\\":\\"Quero marcar consulta amanha\\"}"',
      powershell:
        '$body = @{ correlation_id="abc123456"; clinic_id="09e5240f-9c26-47ee-a54d-02934a36ebfd"; from="5511999999999"; message_text="Quero marcar consulta amanha" } | ConvertTo-Json; Invoke-RestMethod -Method Post -Uri "http://localhost:3000/process" -ContentType "application/json" -Body $body',
    },
  });
});

// ======================================================
// UTILITÁRIOS DE LOGGING
// ======================================================

/**
 * Salva um turno da conversa (user + assistant) em conversation_history.
 * Chamado antes de retornar a resposta final. Nunca lança exceção.
 */
async function saveConversationTurn({ clinicId, fromNumber, correlationId, userText, assistantText, intentGroup, intent, slots }) {
  try {
    const { error } = await supabase.from('conversation_history').insert([
      {
        clinic_id: clinicId,
        from_number: fromNumber,
        wa_message_id: correlationId || null,
        role: 'user',
        message_text: userText,
        intent_group: intentGroup || null,
        intent: intent || null,
        slots: slots || null,
      },
      {
        clinic_id: clinicId,
        from_number: fromNumber,
        wa_message_id: null,
        role: 'assistant',
        message_text: assistantText,
        intent_group: intentGroup || null,
        intent: intent || null,
        slots: null,
      },
    ]);
    if (error) log.warn({ err: String(error) }, 'conversation_history_insert_failed');
  } catch (e) {
    log.warn({ err: String(e) }, 'conversation_history_insert_exception');
  }
}

/**
 * Registra na tabela agent_logs situações onde o agente não encontrou
 * informação na KB (knowledge gap), para popular a base proativamente.
 *
 * @param {string} clinicId
 * @param {string} correlationId
 * @param {string} question - pergunta original do paciente
 * @param {Object} context - contexto adicional (intent, slots, etc.)
 */
async function logKnowledgeGap(clinicId, correlationId, question, context) {
  try {
    await supabase.from('agent_logs').insert({
      clinic_id: clinicId,
      correlation_id: correlationId,
      log_type: 'knowledge_gap',
      extra_data: { question, context },
      latency_ms: 0,
    });
  } catch (e) {
    log.warn({ err: String(e) }, 'knowledge_gap_log_failed');
  }
}

/**
 * Loga decisões determinísticas do interceptor e transições de estado.
 * Quando ENABLE_AGENT_DECISION_LOGS=true, também salva em agent_decision_logs.
 */
async function logDecision(type, details, clinicId = null, fromNumber = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    type, // 'interceptor_trigger' | 'state_transition' | 'tool_forced' | 'tool_validated' | 'session_timeout' | 'confirmation'
    ...details,
  };
  console.log(`[DECISION] ${JSON.stringify(entry)}`);

  if (process.env.ENABLE_AGENT_DECISION_LOGS === 'true' && clinicId) {
    try {
      await supabase.from('agent_decision_logs').insert({
        clinic_id: clinicId,
        from_number: fromNumber || 'unknown',
        decision_type: type,
        details: entry,
      });
    } catch (e) {
      // silencioso — não crítico
    }
  }
}

// ======================================================
// CÁLCULO DE CUSTO DE TOKENS (PONTO D — Conversation Tracking)
// ======================================================

/**
 * Calcula custo estimado de uma chamada OpenAI baseado nos tokens.
 * Preços do GPT-4.1 (atualizar se mudar de modelo).
 */
function calculateCost(promptTokens, completionTokens) {
  // Preços do GPT-4.1 por 1M tokens (verificar se mudou)
  const INPUT_PRICE_PER_1M = 2.00;    // USD por 1M tokens de input
  const OUTPUT_PRICE_PER_1M = 8.00;   // USD por 1M tokens de output

  const inputCost = (promptTokens / 1_000_000) * INPUT_PRICE_PER_1M;
  const outputCost = (completionTokens / 1_000_000) * OUTPUT_PRICE_PER_1M;

  return parseFloat((inputCost + outputCost).toFixed(6));
}

// ======================================================
// GERENCIAMENTO DE ESTADO PERSISTENTE
// ======================================================

/**
 * Carrega ou cria estado da conversa no banco.
 */
async function loadConversationState(supabase, clinicId, fromNumber) {
  const { data, error } = await supabase
    .from('conversation_state')
    .select('*')
    .eq('clinic_id', clinicId)
    .eq('from_number', fromNumber)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Erro ao carregar estado:', error);
  }

  if (data) {
    if (new Date(data.expires_at) < new Date()) {
      console.log(`[STATE] Session expired (24h) for ${fromNumber} — resetting state`);
      logDecision('session_timeout', { reason: '24h_expires_at', from_number: fromNumber }, clinicId, fromNumber);
      return await resetConversationState(supabase, clinicId, fromNumber);
    }
    // Nova mensagem após agendamento confirmado → nova conversa
    if (data.state_json?.appointment_confirmed) {
      console.log('[STATE] Agendamento anterior confirmado — resetando estado para nova conversa');
      return await resetConversationState(supabase, clinicId, fromNumber);
    }

    // Check de timeout de 4h: se o estado de booking está ativo e ficou inativo por muito tempo
    const SESSION_TIMEOUT_HOURS = Number(process.env.SESSION_TIMEOUT_HOURS || 4);
    const stateJson = data.state_json || {};
    if (stateJson.last_activity_at) {
      const lastActivity = new Date(stateJson.last_activity_at);
      const hoursElapsed = (Date.now() - lastActivity.getTime()) / (1000 * 60 * 60);
      const bookingState = stateJson.booking_state;
      const activeStates = [BOOKING_STATES.COLLECTING_DATE, BOOKING_STATES.AWAITING_SLOTS,
                            BOOKING_STATES.COLLECTING_TIME, BOOKING_STATES.CONFIRMING];
      if (hoursElapsed > SESSION_TIMEOUT_HOURS && activeStates.includes(bookingState)) {
        console.log(`[STATE] Session timeout (${SESSION_TIMEOUT_HOURS}h) for ${fromNumber} — resetting booking state`);
        logDecision('session_timeout', {
          reason: `${SESSION_TIMEOUT_HOURS}h_booking_state`,
          hours_elapsed: hoursElapsed.toFixed(1),
          booking_state: bookingState,
          from_number: fromNumber,
        }, clinicId, fromNumber);
        // Não reseta tudo — apenas limpa dados de agendamento em andamento
        const resetUpdates = {
          ...stateJson,
          booking_state: BOOKING_STATES.IDLE,
          preferred_date: null,
          preferred_date_iso: null,
          preferred_time: null,
          last_suggested_slots: [],
          last_activity_at: new Date().toISOString(),
        };
        await supabase.from('conversation_state').update({
          state_json: resetUpdates,
          updated_at: new Date().toISOString(),
        }).eq('clinic_id', clinicId).eq('from_number', fromNumber);
        return resetUpdates;
      }
    }

    return stateJson;
  }

  return await resetConversationState(supabase, clinicId, fromNumber);
}

/**
 * Cria/reseta estado da conversa para valores iniciais.
 */
async function resetConversationState(supabase, clinicId, fromNumber) {
  const initialState = {
    patient_name: null,
    patient_phone: fromNumber,
    intent: null,
    doctor_id: null,
    doctor_name: null,
    specialty: null,
    service_id: null,
    service_name: null,
    preferred_date: null,
    preferred_date_iso: null,
    preferred_time: null,
    pending_fields: [],
    last_question_asked: null,
    conversation_stage: 'greeting',
    appointment_confirmed: false,
    // Memória operacional (anti-loop de disponibilidade)
    last_suggested_dates: [],
    last_suggested_slots: [],
    stuck_counter: {},
    // State machine de agendamento
    booking_state: BOOKING_STATES.IDLE,
    // Memória longa (running summary)
    running_summary: null,
    // Timestamp de última atividade (para timeout de 4h)
    last_activity_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from('conversation_state')
    .upsert({
      clinic_id: clinicId,
      from_number: fromNumber,
      state_json: initialState,
      turn_count: 0,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }, { onConflict: 'clinic_id,from_number' });

  if (error) console.error('Erro ao resetar estado:', error);
  return initialState;
}

/**
 * Atualiza estado da conversa via merge_conversation_state (atômico).
 * Substitui o padrão read-modify-write que tinha race condition:
 *   dois updates simultâneos sobrescreviam um ao outro.
 * A função SQL usa JSONB || que aplica o patch atomicamente no banco.
 */
async function updateConversationState(supabase, clinicId, fromNumber, updates) {
  const { data: newState, error } = await supabase
    .rpc('merge_conversation_state', {
      p_clinic_id:   clinicId,
      p_from_number: fromNumber,
      p_updates:     updates,
    });

  if (error) {
    console.error('[STATE] merge_conversation_state falhou:', error.message);
    // Fallback: read-modify-write se a RPC não existir ainda
    const { data: current } = await supabase
      .from('conversation_state')
      .select('state_json')
      .eq('clinic_id', clinicId)
      .eq('from_number', fromNumber)
      .maybeSingle();
    const fallbackState = { ...(current?.state_json || {}), ...updates, last_activity_at: new Date().toISOString() };
    await supabase
      .from('conversation_state')
      .update({ state_json: fallbackState, updated_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString() })
      .eq('clinic_id', clinicId)
      .eq('from_number', fromNumber);
    return fallbackState;
  }

  return newState;
}

// ======================================================
// TAREFA 2 — FIX 2: Mapa expandido de sinônimos de especialidade
// ======================================================
// Valores reais do banco (com acentos): Dermatologia, Clínico Geral, Estética,
// Cardiologia, Ortopedia, Ginecologia, Pediatria, Nutrição, Psicologia
const SINONIMOS_ESPECIALIDADE = {
  // Formas coloquiais (sem acentos, lowercase) → nome exato no banco
  'cardiologista':     'Cardiologia',
  'cardiologia':       'Cardiologia',
  'ortopedista':       'Ortopedia',
  'ortopedia':         'Ortopedia',
  'dermatologista':    'Dermatologia',
  'dermatologia':      'Dermatologia',
  'ginecologista':     'Ginecologia',
  'ginecologia':       'Ginecologia',
  'pediatra':          'Pediatria',
  'pediatria':         'Pediatria',
  'neurologista':      'Neurologia',
  'neurologia':        'Neurologia',
  'psiquiatra':        'Psiquiatria',
  'psiquiatria':       'Psiquiatria',
  'urologista':        'Urologia',
  'urologia':          'Urologia',
  'oftalmo':           'Oftalmologia',
  'oftalmologista':    'Oftalmologia',
  'oftalmologia':      'Oftalmologia',
  'endocrino':         'Endocrinologia',
  'endocrinologista':  'Endocrinologia',
  'endocrinologia':    'Endocrinologia',
  'nutricionista':     'Nutrição',
  'nutricao':          'Nutrição',
  'nutri':             'Nutrição',
  'nutricionist':      'Nutrição',
  'psicologo':         'Psicologia',
  'psicologa':         'Psicologia',
  'psicologia':        'Psicologia',
  'psico':             'Psicologia',
  'psicoterapeuta':    'Psicologia',
  'esteticista':       'Estética',
  'estetica':          'Estética',
  'esteticien':        'Estética',
  'clinico geral':     'Clínico Geral',
  'clinico':           'Clínico Geral',
  'geral':             'Clínico Geral',
  'medico geral':      'Clínico Geral',
  'medico':            'Clínico Geral',
  'clinica geral':     'Clínico Geral',
}

/**
 * Normaliza variações linguísticas de especialidade antes do match.
 * TAREFA 2 FIX 2: Usa SINONIMOS_ESPECIALIDADE expandido.
 * Ex.: "cardiologista" → "cardiologia", "oftalmo" → "oftalmologia"
 * @param {string} input - Especialidade informada pelo paciente
 * @returns {string} Especialidade normalizada (sem acentos, lowercase)
 */
function normalizeSpecialty(input) {
  if (!input) return '';
  // Normalizar: lowercase + remover acentos
  const normalized = input.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '').trim();

  // Verificar match exato no mapa
  if (SINONIMOS_ESPECIALIDADE[normalized]) {
    return SINONIMOS_ESPECIALIDADE[normalized];
  }

  // Verificar match parcial (ex: "cardiologista" contém "cardiologista")
  for (const [key, value] of Object.entries(SINONIMOS_ESPECIALIDADE)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return value;
    }
  }

  return normalized;
}

/**
 * Normaliza especialidade com fallback assíncrono no banco.
 * Se não houver match no mapa, busca via ILIKE no Supabase.
 * TAREFA 2 FIX 2: Fallback com query no banco.
 * @param {string} input - Especialidade informada pelo paciente
 * @param {object} supabaseClient - Cliente Supabase
 * @param {string} clinicId - UUID da clínica
 * @returns {Promise<string>} Especialidade normalizada
 */
async function normalizeSpecialtyWithFallback(input, supabaseClient, clinicId) {
  if (!input) return '';
  const fromMap = normalizeSpecialty(input);

  // Se o mapa retornou algo diferente do input normalizado, usar
  const inputNorm = input.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '').trim();

  if (fromMap !== inputNorm) {
    return fromMap; // Match encontrado no mapa
  }

  // Fallback: buscar no banco via ILIKE
  try {
    const { data } = await supabaseClient
      .from('doctors')
      .select('specialty')
      .eq('clinic_id', clinicId)
      .ilike('specialty', `%${inputNorm}%`)
      .limit(1);

    if (data && data.length > 0) {
      const dbSpecialty = data[0].specialty.toLowerCase().trim()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9 ]/g, '').trim();
      console.log(`[FIX2] Especialidade resolvida via banco: '${input}' → '${dbSpecialty}'`);
      return dbSpecialty;
    }
  } catch (err) {
    console.error('[FIX2] Erro ao buscar especialidade no banco:', err.message);
  }

  return fromMap; // Retornar o que o mapa deu (mesmo que seja o input normalizado)
}

/**
 * Merge slots extraídos pelo LLM no estado persistente.
 * Valida especialidade e médico contra dados reais da clínica.
 * Suporta os dois naming conventions do extract_intent.
 */
async function mergeExtractedSlots(currentState, extractedSlots, doctors, services, supabaseClient, clinicId, timezone) {
  const updates = { ...currentState };

  // Nome do paciente
  if (extractedSlots.patient_name) {
    updates.patient_name = extractedSlots.patient_name;
  }

  // Especialidade (extract_intent usa 'specialty_or_reason')
  // TAREFA 2 FIX 2: Usar normalizeSpecialty expandido + persistir em specialty
  const specialtyInput = extractedSlots.specialty || extractedSlots.specialty_or_reason;
  if (specialtyInput) {
    // Usar versão com fallback no banco para especialidades não mapeadas
    const normalizedSpec = supabaseClient && clinicId
      ? await normalizeSpecialtyWithFallback(specialtyInput, supabaseClient, clinicId)
      : normalizeSpecialty(specialtyInput);
    console.log(`[FIX2] Especialidade normalizada (com fallback): '${specialtyInput}' → '${normalizedSpec}'`);
    const matchingDoctor = doctors.find(d => {
      const docSpec = d.specialty.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9 ]/g, '').trim();
      const inputNorm = normalizedSpec.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9 ]/g, '').trim();
      return docSpec.includes(inputNorm) || inputNorm.includes(docSpec);
    });
    if (matchingDoctor) {
      updates.specialty = matchingDoctor.specialty;
      updates.doctor_name = matchingDoctor.name;
      updates.doctor_id = matchingDoctor.id;
      console.log(`[FIX2] Especialidade "${specialtyInput}" → ${matchingDoctor.name} (${matchingDoctor.id})`);
    } else {
      // Persistir a especialidade normalizada mesmo sem match de médico
      // Isso garante que o valor fique no estado para o próximo turno
      updates.specialty = normalizedSpec;
      console.log(`[FIX2] Especialidade "${specialtyInput}" não encontrou médico. Normalizado: '${normalizedSpec}'. Disponíveis:`, doctors.map(d => d.specialty));
    }
  }

  // Médico específico (extract_intent usa 'doctor_preference')
  // CORREÇÃO 1: Matching robusto com remoção de prefixo Dr/Dra e busca parcial
  const doctorInput = extractedSlots.doctor_name || extractedSlots.doctor_preference;
  if (doctorInput) {
    // DOCTOR-GUARD: uma vez que doctor_id está definido e o estado passou da coleta inicial,
    // NUNCA permitir que extração LLM sobrescreva o médico escolhido.
    // Isso cobre COLLECTING_DATE (onde o bug ocorria) + todos os estados avançados.
    const _currentBsDoctor = updates.booking_state || currentState.booking_state;
    const _doctorLocked = currentState.doctor_id &&
      _currentBsDoctor !== BOOKING_STATES.IDLE &&
      _currentBsDoctor !== BOOKING_STATES.COLLECTING_SPECIALTY;
    if (_doctorLocked) {
      console.log(`[DOCTOR-GUARD] Médico travado (${currentState.doctor_name}, ${currentState.doctor_id}) em estado ${_currentBsDoctor} — ignorando extração LLM: "${doctorInput}"`);
    } else {
    // Normalizar: lowercase + remover acentos + remover prefixo Dr/Dra
    const normalizedDoc = doctorInput
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/^(dr\.?|dra\.?)\s*/i, '') // remove prefixo Dr/Dra
      .replace(/[^a-z0-9 ]/g, '')
      .trim();
    console.log(`[CORREÇÃO1] Buscando médico: '${doctorInput}' → normalizado: '${normalizedDoc}'`);
    // FIX v5.2: Usar scoring em vez de .find() para evitar falso positivo
    // Ex: "beatriz lima" matchava "julia lima" porque "lima" é token parcial
    let bestMatch = null;
    let bestScore = 0;
    for (const d of doctors) {
      const docNameNorm = d.name
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/^(dr\.?|dra\.?)\s*/i, '')
        .replace(/[^a-z0-9 ]/g, '')
        .trim();
      let score = 0;
      // Match exato (bidirecional)
      if (docNameNorm === normalizedDoc) { score = 100; }
      else if (docNameNorm.includes(normalizedDoc)) { score = 80; }
      else if (normalizedDoc.includes(docNameNorm)) { score = 80; }
      else {
        // Scoring por tokens: contar quantos tokens do input batem com o nome do banco
        const inputTokens = normalizedDoc.split(' ').filter(t => t.length > 2);
        const docTokens = docNameNorm.split(' ').filter(t => t.length > 2);
        const matchedTokens = inputTokens.filter(t => docTokens.includes(t));
        if (matchedTokens.length > 0) {
          // Score proporcional: mais tokens batendo = melhor match
          score = (matchedTokens.length / Math.max(inputTokens.length, docTokens.length)) * 60;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestMatch = d;
      }
    }
    const matchingDoctor = bestScore > 0 ? bestMatch : null;
    if (matchingDoctor) {
      updates.doctor_name = matchingDoctor.name;
      updates.doctor_id = matchingDoctor.id;
      updates.specialty = matchingDoctor.specialty;
      console.log(`[CORREÇÃO1] Médico encontrado: '${doctorInput}' → ${matchingDoctor.name} (${matchingDoctor.id})`);
    } else {
      console.warn(`[CORREÇÃO1] Médico NÃO encontrado: '${doctorInput}' (normalizado: '${normalizedDoc}'). Disponíveis:`, doctors.map(d => d.name));
    }
    } // fim do else do DOCTOR-GUARD
  }

  // Data (extract_intent usa 'preferred_date_text')
  // BUG 2 FIX: Resolver datas relativas (incluindo dias da semana) ANTES de salvar no estado
  const dateInput = extractedSlots.preferred_date_text || extractedSlots.preferred_date;
  if (dateInput) {
    // DATE-GUARD: não sobrescrever data ISO já escolhida quando usuário está em etapa posterior
    const isoPattern = /^\d{4}-\d{2}-\d{2}$/;
    const existingDateISO = updates.preferred_date_iso || currentState.preferred_date_iso || updates.preferred_date || currentState.preferred_date;
    const existingIsValid = isoPattern.test(existingDateISO || '');
    // Só proteger datas FUTURAS (ou hoje) — datas passadas devem ser sobrescritas
    const existingDateObj = existingIsValid ? new Date((existingDateISO || '') + 'T00:00:00') : null;
    const _tz = timezone || 'America/Cuiaba';
    const _todayClinic = new Date().toLocaleDateString('en-CA', { timeZone: _tz });
    const todayStart = new Date(_todayClinic + 'T00:00:00');
    const existingIsFuture = existingDateObj && !isNaN(existingDateObj.getTime()) && existingDateObj >= todayStart;
    const protectedStates = [BOOKING_STATES.AWAITING_SLOTS, BOOKING_STATES.COLLECTING_TIME, BOOKING_STATES.CONFIRMING, BOOKING_STATES.BOOKED];
    const currentBookingState = updates.booking_state || currentState.booking_state;
    if (existingIsValid && existingIsFuture && protectedStates.includes(currentBookingState)) {
      console.log(`[DATE-GUARD] preferred_date já definido (${existingDateISO}) em estado ${currentBookingState} — ignorando extração LLM: "${dateInput}"`);
    } else {
      // Tentar resolver para ISO (YYYY-MM-DD) antes de salvar
      // Usar timezone da clínica para evitar data errada à noite (UTC vs América)
      const _tzRef = timezone || 'America/Cuiaba';
      const _clinicTodayStr = new Date().toLocaleDateString('en-CA', { timeZone: _tzRef });
      const _refDate = new Date(_clinicTodayStr + 'T12:00:00');
      const resolvedDate = resolveDateChoice(
        dateInput,
        currentState.last_suggested_dates || [],
        _refDate
      );
      if (resolvedDate) {
        updates.preferred_date = resolvedDate;
        updates.preferred_date_iso = resolvedDate;
        console.log(`[BUG2-FIX] Data resolvida: "${dateInput}" → ${resolvedDate}`);
      } else {
        if (isoPattern.test(dateInput)) {
          updates.preferred_date = dateInput;
          updates.preferred_date_iso = dateInput;
          console.log(`[BUG2-FIX] Data ISO direta: "${dateInput}"`);
        } else {
          // Data não-ISO e não resolvível — NÃO atualizar estado.
          // Se salvarmos preferred_date="sexta" mas preferred_date_iso="2026-03-25" (valor antigo),
          // o criar_agendamento usaria a data errada no fallback.
          // O LLM receberá o texto via system prompt e tentará resolver no próximo turno.
          console.log(`[DATE-GUARD] Data não-ISO não resolvida: "${dateInput}" — preservando preferred_date_iso anterior (${currentState.preferred_date_iso || 'null'})`);
        }
      }
    }
  }

  // Horário (extract_intent usa 'preferred_time_text')
  const timeInput = extractedSlots.preferred_time || extractedSlots.preferred_time_text;
  if (timeInput) {
    // FIX v5.1: Safety net — normalizar last_suggested_slots (pode ser objetos {date,time} ou strings)
    const rawSlots = currentState.last_suggested_slots || [];
    const normalizedSlots = rawSlots.map(s => typeof s === 'string' ? s : (s?.time || null)).filter(Boolean);
    // Tentar resolver para HH:MM antes de salvar
    const resolvedTime = resolveTimeChoice(
      timeInput,
      normalizedSlots
    );
    if (resolvedTime) {
      updates.preferred_time = resolvedTime;
      console.log(`[STATE] Horário resolvido: "${timeInput}" → ${resolvedTime}`);
    } else {
      updates.preferred_time = timeInput;
    }
  }

  updates.pending_fields = calculatePendingFields(updates);

  // Atualizar stuck_counter: incrementa campos que continuam pendentes
  const currentStuck = currentState.stuck_counter || {};
  const newStuck = { ...currentStuck };
  for (const field of updates.pending_fields) {
    newStuck[field] = (newStuck[field] || 0) + 1;
  }
  // Zerar contador de campos que foram preenchidos neste turno
  for (const field of Object.keys(newStuck)) {
    if (!updates.pending_fields.includes(field)) {
      newStuck[field] = 0;
    }
  }
  updates.stuck_counter = newStuck;

  updates.conversation_stage = determineConversationStage(updates);

  return updates;
}

/**
 * Calcula quais campos ainda faltam para agendar.
 */
function calculatePendingFields(state) {
  const pending = [];
  if (!state.patient_name) pending.push('patient_name');
  if (!state.specialty && !state.doctor_name) pending.push('specialty_or_doctor');
  if (!state.preferred_date) pending.push('preferred_date');
  if (!state.preferred_time) pending.push('preferred_time');
  return pending;
}

/**
 * Determina o estágio atual da conversa com base no estado.
 */
function determineConversationStage(state) {
  if (state.appointment_confirmed) return 'confirmed';
  if (state.pending_fields.length === 0) return 'ready_to_confirm';
  if (state.pending_fields.length === 1) return 'almost_complete';
  if (state.patient_name || state.specialty) return 'collecting_info';
  return 'greeting';
}

/**
 * Verifica se a nova resposta é muito similar à última pergunta feita.
 * Usa similaridade de Jaccard sobre palavras com mais de 3 letras.
 */
function isRepetition(newMessage, lastQuestion) {
  if (!lastQuestion) return false;

  const normalize = (text) => text.toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .sort()
    .join(' ');

  const setA = new Set(normalize(newMessage).split(' '));
  const setB = new Set(normalize(lastQuestion).split(' '));
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return false;
  return (intersection.size / union.size) > 0.7;
}

/**
 * Detecta se a mensagem do usuário é uma pergunta de disponibilidade.
 * Quando verdadeiro, o interceptor chama buscar_proximas_datas em vez de
 * perguntar "qual data você prefere?".
 */
function detectAvailabilityQuestion(text) {
  const normalized = text.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // remove acentos
  const patterns = [
    /disponiv/, /disponibilidade/, /quais dias/, /que dia/, /qual dia/,
    /tem agenda/, /tem horario/, /quais horarios/, /que horario/,
    /proximo/, /proxima/, /quando tem/, /quando voce/, /quando atende/,
  ];
  return patterns.some(p => p.test(normalized));
}

// ======================================================
// HELPERS DE DATA (nativos — sem library externa)
// ======================================================

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function formatISO(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Normaliza array de datas do schedulingService para salvar em last_suggested_dates.
 * Garante que date_iso está SEMPRE em formato YYYY-MM-DD (nunca DD/MM ou texto).
 * Isso evita que o interceptor numérico recupere uma data em formato errado.
 */
function normalizeDatesForState(dates) {
  const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
  return (dates || []).map(d => {
    // date_iso deve ser ISO; se não for, tentar extrair de date
    let dateIso = d.date_iso || d.date || null;
    if (dateIso && !ISO_PATTERN.test(dateIso)) {
      // Pode ser "31/03/2026" → converter para ISO
      const parts = dateIso.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (parts) {
        dateIso = `${parts[3]}-${parts[2].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
      } else {
        // Fallback: usar d.date_iso se tiver, senão null para evitar dado corrompido
        dateIso = ISO_PATTERN.test(d.date_iso || '') ? d.date_iso : null;
      }
    }
    return {
      date: d.date,
      date_iso: dateIso,
      formatted_date: d.formatted_date,
      day_of_week: d.day_of_week,
      slots_count: d.slots_count || (d.slots || []).length,
      slots: d.slots || [],
    };
  }).filter(d => d.date_iso); // remover entradas com date_iso inválido
}

function nextWeekday(referenceDate, targetDay) {
  const result = new Date(referenceDate);
  const currentDay = result.getDay();
  let daysUntil = targetDay - currentDay;
  if (daysUntil <= 0) daysUntil += 7;
  result.setDate(result.getDate() + daysUntil);
  return result;
}

function findClosestSlot(timeStr, slots) {
  if (!slots || slots.length === 0) return null;
  const [targetH, targetM] = timeStr.split(':').map(Number);
  const targetMinutes = targetH * 60 + (targetM || 0);
  let closest = null;
  let minDiff = Infinity;
  for (const rawSlot of slots) {
    // FIX v5.1: Guard — normalizar se for objeto {date, time}
    const slot = typeof rawSlot === 'string' ? rawSlot : (rawSlot?.time || null);
    if (!slot || typeof slot !== 'string' || !slot.includes(':')) continue;
    const [h, m] = slot.split(':').map(Number);
    if (isNaN(h) || isNaN(m)) continue;
    const diff = Math.abs((h * 60 + m) - targetMinutes);
    if (diff < minDiff) { minDiff = diff; closest = slot; }
  }
  return minDiff <= 60 ? closest : null; // máx 1h de diferença
}

// ======================================================
// RESOLUÇÃO DE ESCOLHAS RELATIVAS
// ======================================================

/**
 * Converte escolha relativa de data para ISO date string (YYYY-MM-DD).
 * Exemplos: "amanhã", "segunda", "semana que vem", "dia 15", "a primeira"
 * @param {string} userInput - texto do usuário
 * @param {Array} suggestedDates - last_suggested_dates do estado
 * @param {Date} referenceDate - data de referência (default: agora)
 * @returns {string|null} YYYY-MM-DD ou null se não resolver
 */
function resolveDateChoice(userInput, suggestedDates = [], referenceDate = new Date()) {
  if (!userInput) return null;
  const input = String(userInput).toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // remove acentos

  // ── PRIORIDADE 1: índice numérico posicional ────────────────────────────
  // "4", "4)", "4." → sempre usa a lista interna, nunca o texto
  // Captura: dígito puro OU dígito no início seguido de ) . espaço ou fim
  if (suggestedDates.length > 0) {
    const numMatch = input.match(/^(\d)[).\s]|^(\d)$/);
    if (numMatch) {
      const digit = numMatch[1] || numMatch[2];
      const idx = parseInt(digit) - 1;
      if (idx >= 0 && idx < suggestedDates.length && suggestedDates[idx]) {
        const picked = suggestedDates[idx];
        console.log(`[resolveDateChoice] índice "${digit}" → ${picked.date_iso || picked.date}`);
        return picked.date_iso || picked.date || null;
      }
    }
    // Palavras ordinais: "primeira", "segunda opção" etc.
    const ORDINALS = ['prim', 'segund', 'terceir', 'quart', 'quint'];
    for (let i = 0; i < ORDINALS.length; i++) {
      if (input.startsWith(ORDINALS[i]) && suggestedDates[i]) {
        return suggestedDates[i].date_iso || suggestedDates[i].date || null;
      }
    }
  }

  // ── PRIORIDADE 2: data explícita DD/MM ou DD/MM/YYYY ───────────────────
  // Verificar ANTES do nome do dia da semana — dado explícito sempre vence inferência
  const dayMatch = input.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (dayMatch) {
    const d = parseInt(dayMatch[1]);
    const m = parseInt(dayMatch[2]) - 1;
    // Aceitar apenas dia 1-31 e mês 1-12 para evitar confusão MM/DD
    if (d >= 1 && d <= 31 && m >= 0 && m <= 11) {
      const rawYear = dayMatch[3] ? parseInt(dayMatch[3]) : null;
      const year = rawYear
        ? (rawYear < 100 ? 2000 + rawYear : rawYear)
        : referenceDate.getFullYear();
      const candidate = new Date(year, m, d);
      if (isNaN(candidate.getTime())) return null;
      // Se ano explícito foi fornecido, retornar direto (sem ajuste de ano)
      if (rawYear) return formatISO(candidate);
      if (candidate >= referenceDate) return formatISO(candidate);
      return formatISO(new Date(year + 1, m, d));
    }
  }

  // ── PRIORIDADE 3: datas relativas ──────────────────────────────────────
  if (/hoje/.test(input)) return formatISO(referenceDate);
  if (/amanha/.test(input)) return formatISO(addDays(referenceDate, 1));
  if (/semana que vem|proxima semana/.test(input)) return formatISO(addDays(referenceDate, 7));

  // ── PRIORIDADE 4: dia da semana (apenas quando não há data explícita) ──
  // Só chega aqui se NENHUM DD/MM foi encontrado no input
  const WEEKDAY_MAP = [
    { pattern: /\bsegunda([-\s]feira)?\b/, day: 1 },
    { pattern: /\b(terca|terca)([-\s]feira)?\b/, day: 2 },
    { pattern: /\bquarta([-\s]feira)?\b/, day: 3 },
    { pattern: /\bquinta([-\s]feira)?\b/, day: 4 },
    { pattern: /\bsexta([-\s]feira)?\b/, day: 5 },
    { pattern: /\b(sabado)\b/, day: 6 },
    { pattern: /\bdomingo\b/, day: 0 },
  ];
  for (const { pattern, day } of WEEKDAY_MAP) {
    if (pattern.test(input)) {
      const resolved = formatISO(nextWeekday(referenceDate, day));
      console.log(`[resolveDateChoice] Dia da semana detectado (sem data explícita): '${userInput}' → ${resolved}`);
      return resolved;
    }
  }

  // ── PRIORIDADE 5: dia do mês ("dia 15", "15") ──────────────────────────
  const singleDayMatch = input.match(/^dia\s+(\d{1,2})$|^(\d{1,2})$/);
  if (singleDayMatch) {
    const d = parseInt(singleDayMatch[1] || singleDayMatch[2]);
    if (d >= 1 && d <= 31) {
      const now = referenceDate;
      let candidate = new Date(now.getFullYear(), now.getMonth(), d);
      if (candidate < now) candidate = new Date(now.getFullYear(), now.getMonth() + 1, d);
      if (!isNaN(candidate.getTime())) return formatISO(candidate);
    }
  }

  return null; // não conseguiu resolver
}

/**
 * Converte escolha relativa de horário para "HH:MM".
 * Exemplos: "a primeira", "14h", "às 14", "de manhã", "à tarde"
 * @param {string} userInput - texto do usuário
 * @param {Array} suggestedSlots - last_suggested_slots do estado (strings "HH:MM")
 * @returns {string|null} "HH:MM" ou null se não resolver
 */
function resolveTimeChoice(userInput, suggestedSlots = []) {
  if (!userInput) return null;
  const input = userInput.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // FIX v5.1: Normalizar last_suggested_slots — pode ser array de strings "HH:MM"
  // ou array de objetos {date, time}. Converter tudo para strings "HH:MM".
  const slots = suggestedSlots
    .map(s => typeof s === 'string' ? s : (s?.time || null))
    .filter(Boolean);

  // Referências posicionais
  if (/prim[ea]ira?|^1[ao°]?$|^1$/.test(input) && slots[0]) return slots[0];
  if (/segunda?|^2[ao°]?$|^2$/.test(input) && slots[1]) return slots[1];
  if (/terceira?|^3[ao°]?$|^3$/.test(input) && slots[2]) return slots[2];
  if (/quarta?|^4[ao°]?$|^4$/.test(input) && slots[3]) return slots[3];

  // Períodos do dia
  if (/manha/.test(input)) {
    const manha = slots.find(s => parseInt(s.split(':')[0]) < 12);
    if (manha) return manha;
  }
  if (/tarde/.test(input)) {
    const tarde = slots.find(s => {
      const h = parseInt(s.split(':')[0]);
      return h >= 12 && h < 18;
    });
    if (tarde) return tarde;
  }
  if (/noite/.test(input)) {
    const noite = slots.find(s => parseInt(s.split(':')[0]) >= 18);
    if (noite) return noite;
  }

  // Horário explícito: "14h", "14:00", "às 14", "14h30", "13h30", "2pm"
  // Fix: [h:] como separador aceita tanto "13:30" quanto "13h30" (notação europeia)
  const hourMatch = input.match(/(\d{1,2})(?:[h:](\d{2}))?h?/);
  if (hourMatch) {
    const h = hourMatch[1].padStart(2, '0');
    const m = hourMatch[2] || '00';
    const formatted = `${h}:${m}`;
    const exact = slots.find(s => s === formatted);
    if (exact) return exact;
    const closest = findClosestSlot(formatted, slots);
    if (closest) return closest;
    // Se não há lista de slots mas o horário parece válido, retornar mesmo assim
    if (parseInt(h) >= 6 && parseInt(h) <= 22) return formatted;
  }

  return null;
}

// ======================================================
// INTERCEPTORES DETERMINÍSTICOS
// ======================================================

/**
 * Deve ser executada ANTES do LLM a cada step.
 * Retorna uma `forcedToolCall` (ou null se o LLM pode decidir livremente).
 */
function applyDeterministicInterceptors(state, messageText) {
  const { doctor_id, preferred_date, preferred_time, booking_state } = state;

  // REGRA 1: Tem médico e data ISO válida, mas não tem horário → DEVE verificar disponibilidade
  // Guard: verificar se preferred_date é realmente um ISO (YYYY-MM-DD) antes de chamar a tool
  // Se for texto como "a primeira" ou "sexta", não passar para a tool (causaria DATA_INVALIDA)
  const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
  const preferredDateIsISO = preferred_date && ISO_DATE_PATTERN.test(preferred_date);

  // Não chamar se: (1) já mostramos os horários e aguardamos escolha OU (2) aguardando usuário
  // escolher a data da lista (COLLECTING_DATE). Quando o interceptor numérico dispara, ele limpa
  // last_suggested_slots e muda para AWAITING_SLOTS, forçando a passagem pela regra abaixo.
  const alreadyShowingSlots = booking_state === BOOKING_STATES.AWAITING_SLOTS &&
    (state.last_suggested_slots?.length > 0);
  if (doctor_id && preferredDateIsISO && !preferred_time &&
      !alreadyShowingSlots &&
      booking_state !== BOOKING_STATES.COLLECTING_DATE) {
    return {
      tool: 'verificar_disponibilidade',
      params: { doctor_id, data: preferred_date },
      reason: 'guard_rail: date_set_no_time',
    };
  }

  // Se tem data mas não é ISO → dado ainda não foi resolvido pelo resolveDateChoice
  // O LLM vai tentar resolver ou pedir ao usuário que especifique melhor
  if (doctor_id && preferred_date && !preferredDateIsISO && !preferred_time) {
    console.log(`[INTERCEPTOR] preferred_date não-ISO detectado: "${preferred_date}" — aguardando resolução`);
  }

  // REGRA 2: Tem médico, mas não tem data → buscar próximas datas disponíveis
  if (doctor_id && !preferred_date &&
      booking_state !== BOOKING_STATES.AWAITING_SLOTS &&
      booking_state !== BOOKING_STATES.CONFIRMING &&
      booking_state !== BOOKING_STATES.BOOKED) {
    // Se já tem datas sugeridas e está em COLLECTING_DATE, não buscar de novo
    if (booking_state === BOOKING_STATES.COLLECTING_DATE && state.last_suggested_dates?.length > 0) {
      return null; // aguardar escolha do paciente
    }
    return {
      tool: 'buscar_proximas_datas',
      params: { doctor_id, dias: BUSCA_SLOTS_ABERTA_DIAS, busca_aberta: true },
      reason: 'guard_rail: doctor_set_no_date (busca_aberta)',
    };
  }

  // REGRA 3: Estado CONFIRMING — não chamar nenhuma tool, apenas aguardar "sim"/"não"
  if (booking_state === BOOKING_STATES.CONFIRMING) {
    return { tool: '__await_confirmation__', params: {}, reason: 'guard_rail: awaiting_confirmation' };
  }

  return null; // LLM decide livremente
}

// ======================================================
// VALIDAÇÃO DE RETORNO DE TOOLS
// ======================================================

/**
 * Valida o retorno de tools de disponibilidade antes de usar.
 */
function validateAvailabilityResult(toolResult, tool) {
  if (!toolResult || toolResult.error) {
    // FIX: Tratar erros da tool como "sem vagas" para ativar o fallback buscar_proximas_datas
    // em vez de mostrar "Não encontrei horários" diretamente. Casos comuns: MEDICO_INVALIDO
    // (doctor_id perdido), DATA_PASSADA (data inválida), ou falha de rede.
    return {
      valid: false,
      noSlots: tool === 'verificar_disponibilidade',
      fallback: tool === 'verificar_disponibilidade'
        ? 'Não há vagas nessa data. Buscando as próximas datas disponíveis...'
        : 'Não consegui buscar as datas disponíveis no momento. Tente novamente em instantes.',
    };
  }

  if (tool === 'verificar_disponibilidade') {
    const slots = toolResult.slots || toolResult.available_slots || [];
    if (!Array.isArray(slots) || slots.length === 0) {
      return {
        valid: false,
        noSlots: true,
        // FIX-FALLBACK: Busca automática de alternativas será executada no bloco de tool execution
        fallback: 'Não há vagas nessa data. Buscando as próximas datas disponíveis...',
        // Preservar a data solicitada para usar como ponto de partida da busca alternativa
        requestedDate: toolResult.date || null,
      };
    }
  }

  return { valid: true };
}

// ======================================================
// LIST MESSAGE — SELEÇÃO DE DATA (Meta WhatsApp Cloud API)
// ======================================================

/**
 * Gera action `send_interactive_list` para que o n8n envie uma list message
 * da Meta WhatsApp Cloud API com até 5 datas selecionáveis.
 * Row id = dígito "1"–"5" → compatível com o interceptor numérico existente.
 *
 * Limites Meta: header ≤60 · body ≤1024 · button ≤20 · row title ≤24 · row desc ≤72
 */
function buildDateListAction(dates, doctorName) {
  const rows = (dates || []).slice(0, 5).map((d, i) => {
    const slotsPreview = (d.slots || []).slice(0, 3).join(' · ');
    return {
      id: String(i + 1),
      title: `${i + 1}) ${d.day_of_week}, ${d.formatted_date}`.substring(0, 24),
      description: (slotsPreview || `${d.slots_count || '?'} horários`).substring(0, 72),
    };
  });
  return {
    type: 'send_interactive_list',
    payload: {
      header: 'Datas disponíveis',
      body: `*${(doctorName || 'Médico selecionado').substring(0, 55)}* — escolha uma data:`,
      button: 'Ver datas',
      sections: [{ title: 'Datas disponíveis', rows }],
    },
  };
}

/**
 * Gera action `send_interactive_list` para seleção de horário.
 * Row id = "1"–"10" → compatível com o interceptor numérico (sugSlots[idx]).
 */
function buildTimeListAction(slots, doctorName, dateFormatted) {
  const rows = (slots || []).slice(0, 10).map((slot, i) => {
    const timeStr = typeof slot === 'string' ? slot : (slot?.time || '');
    return {
      id: String(i + 1),
      title: timeStr,
    };
  });
  return {
    type: 'send_interactive_list',
    payload: {
      header: 'Horários disponíveis',
      body: `*${(doctorName || 'Médico').substring(0, 55)}* — ${(dateFormatted || 'escolha o horário').substring(0, 60)}`,
      button: 'Ver horários',
      sections: [{ title: 'Selecione o horário', rows }],
    },
  };
}

// ======================================================
// CONFIRMAÇÃO OBRIGATÓRIA ANTES DE AGENDAR
// ======================================================

/**
 * Formata data ISO (YYYY-MM-DD) para pt-BR.
 */
function formatDateBR(dateStr) {
  if (!dateStr) return '[DATA NÃO DEFINIDA]';
  const s = String(dateStr);
  // Se já é formato pt-BR (DD/MM/YYYY), retornar direto
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;
  // Parsear ISO YYYY-MM-DD diretamente (evita problemas de toLocaleDateString/ICU no Railway)
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[3]}/${isoMatch[2]}/${isoMatch[1]}`;
  try {
    const date = new Date(s + 'T00:00:00');
    if (isNaN(date.getTime())) return s;
    return date.toLocaleDateString('pt-BR');
  } catch {
    return s;
  }
}

/**
 * Gera mensagem de confirmação do agendamento para o usuário.
 * FIX v5.2: Inclui preço da consulta e informações de convênios.
 */
async function buildConfirmationMessage(state, doctorName, clinicName, clinicId) {
  const { preferred_date_iso, preferred_date, preferred_time, patient_name, doctor_id } = state;
  const rawDate = preferred_date_iso || preferred_date;
  console.log(`[CONFIRM-MSG] preferred_date_iso=${JSON.stringify(preferred_date_iso)} preferred_date=${JSON.stringify(preferred_date)} rawDate=${JSON.stringify(rawDate)}`);
  const dateFormatted = formatDateBR(rawDate);
  const doctor = doctorName || state.doctor_name || '[MÉDICO]';
  const clinic = clinicName || 'Clínica';

  // Buscar preço do serviço principal do médico
  let priceInfo = '';
  if (doctor_id && clinicId) {
    try {
      const { data: dsRows } = await supabase
        .from('doctor_services')
        .select('custom_price, service_id, services(name, price)')
        .eq('doctor_id', doctor_id)
        .eq('clinic_id', clinicId)
        .limit(5);
      if (dsRows && dsRows.length > 0) {
        // Usar custom_price se existir, senão price da tabela services
        // Pegar o primeiro serviço (consulta principal)
        const mainService = dsRows[0];
        const price = mainService.custom_price || mainService.services?.price;
        const serviceName = mainService.services?.name || 'Consulta';
        if (price) {
          const formatted = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(price);
          priceInfo = `💰 Valor: ${formatted} (${serviceName})`;
          if (dsRows.length > 1) {
            priceInfo += `\n   _Outros serviços disponíveis com este profissional_`;
          }
        }
      }
    } catch (e) {
      console.warn('[buildConfirmationMessage] Erro ao buscar preço:', e.message);
    }
  }

  // Buscar informações de convênios do clinic_kb
  let convenioInfo = '';
  if (clinicId) {
    try {
      const { data: kbRows } = await supabase
        .from('clinic_kb')
        .select('content')
        .eq('clinic_id', clinicId)
        .ilike('title', '%onvênio%')
        .limit(1);
      if (kbRows && kbRows.length > 0 && kbRows[0].content) {
        // Extrair só a parte relevante (ex: "Aceitamos: Unimed, Bradesco...")
        const content = kbRows[0].content;
        if (content.toLowerCase().includes('aceita')) {
          convenioInfo = `🏷️ ${content.split('.')[0]}.`; // primeira frase
        } else {
          convenioInfo = `🏷️ ${content}`;
        }
      }
    } catch (e) {
      console.warn('[buildConfirmationMessage] Erro ao buscar convênios:', e.message);
    }
  }

  let msg = `✅ *Confirmar agendamento?*\n\n` +
    `👤 Paciente: ${patient_name || 'não informado'}\n` +
    `👨‍⚕️ Médico: ${doctor}\n` +
    `📅 Data: ${dateFormatted}\n` +
    `🕐 Horário: ${preferred_time}\n` +
    `🏥 Clínica: ${clinic}`;

  if (priceInfo) msg += `\n${priceInfo}`;
  if (convenioInfo) msg += `\n\n${convenioInfo}`;

  msg += `\n\nPressione *Confirmar* para confirmar seu agendamento ou *Cancelar* para cancelar.`;

  return msg;
}

// ======================================================
// DYNAMIC SYSTEM PROMPT (com estado como fonte da verdade)
// ======================================================

// ======================================================
// RUNNING SUMMARY — Memória longa comprimida
// ======================================================

/**
 * Gera resumo comprimido a cada SUMMARY_TRIGGER_MESSAGES mensagens.
 * Salva em state.running_summary para injeção no system prompt.
 */
async function maybeGenerateSummary(conversationHistory, state, openaiClient) {
  const TRIGGER = Number(process.env.SUMMARY_TRIGGER_MESSAGES || 10);
  const COOLDOWN_MINUTES = 30;

  if (conversationHistory.length < TRIGGER) return state;

  // Fix: verificação por tempo em vez de módulo por contagem.
  // O módulo disparava toda request quando o histórico era carregado
  // sempre com exatamente TRIGGER mensagens (limit=10 na query).
  const lastSummaryAt = state.last_summary_at ? new Date(state.last_summary_at) : null;
  if (lastSummaryAt) {
    const minutesSinceLast = (Date.now() - lastSummaryAt.getTime()) / 60000;
    if (minutesSinceLast < COOLDOWN_MINUTES) return state;
  }

  try {
    const historyText = conversationHistory
      .slice(-TRIGGER)
      .map(m => `${m.role}: ${m.content}`)
      .join('\n');

    const summaryResponse = await openaiClient.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `Resuma em 3-5 frases o que foi discutido nesta conversa de atendimento médico, ` +
          `focando em: nome do paciente, médico de interesse, datas mencionadas, intenção principal.\n\n` +
          `Conversa:\n${historyText}`,
      }],
      max_tokens: 200,
      temperature: 0.1,
    });

    const summary = summaryResponse.choices[0].message.content;
    const updatedState = { ...state, running_summary: summary, last_summary_at: new Date().toISOString() };
    console.log(`[SUMMARY] Generated: ${summary.substring(0, 80)}...`);
    return updatedState;
  } catch (e) {
    console.warn('[SUMMARY] Failed to generate summary:', e.message);
    return state;
  }
}

// ======================================================
// DYNAMIC SYSTEM PROMPT (com estado como fonte da verdade)
// ======================================================

/**
 * Constrói o system prompt usando o estado persistente como fonte da verdade.
 * Substitui a abordagem anterior baseada em regex sobre previousMessages.
 */
const buildSystemPrompt = (clinicSettings, doctors, services, kbContext, conversationState) => {
  const doctorsList = doctors.map(d => `• ${d.name} — ${d.specialty}`).join('\n');
  const specialtiesList = [...new Set(doctors.map(d => d.specialty))].join(', ');

  // PRIORIDADE 2A — Injetar data atual no timezone da clínica (fix UTC vs America/Cuiaba)
  // toISOString() retorna UTC — com offset de -4h, datas à noite ficavam erradas.
  const clinicTimezone = clinicSettings?.timezone || 'America/Cuiaba';
  const now = new Date();
  // en-CA usa formato YYYY-MM-DD nativamente — ideal para datas no sistema
  const CURRENT_DATE    = now.toLocaleDateString('en-CA', { timeZone: clinicTimezone });
  const TOMORROW_DATE   = new Date(now.getTime() + 86400000).toLocaleDateString('en-CA', { timeZone: clinicTimezone });
  const CURRENT_WEEKDAY = now.toLocaleDateString('pt-BR', { timeZone: clinicTimezone, weekday: 'long' });

  const cs = conversationState || {};
  const stateDisplay = `
ESTADO ATUAL DA CONVERSA (FONTE DA VERDADE — NÃO PERGUNTE O QUE JÁ TEM):
${cs.patient_name ? `✅ Nome: ${cs.patient_name}` : '❌ Nome: PENDENTE'}
${cs.doctor_name ? `✅ Médico: ${cs.doctor_name} (${cs.specialty})` : cs.specialty ? `✅ Especialidade: ${cs.specialty}` : '❌ Médico/Especialidade: PENDENTE'}
${cs.preferred_date && cs.booking_state !== 'collecting_date' ? `✅ Data: ${cs.preferred_date}` : '❌ Data: PENDENTE (aguardando usuário escolher nova data)'}
${cs.preferred_time ? `✅ Horário: ${cs.preferred_time}` : '❌ Horário: PENDENTE'}

ESTÁGIO: ${cs.conversation_stage || 'greeting'}
BOOKING_STATE: ${cs.booking_state || 'idle'}
${cs.booking_state === BOOKING_STATES.BOOKED ? `🔒 AGENDAMENTO JÁ CONFIRMADO — NÃO tente agendar novamente. Se o paciente perguntar sobre a consulta, confirme os dados acima. Se quiser novo agendamento, mude booking_state para idle.` : ''}
${cs.booking_state === 'collecting_date' ? '⚠️ ATENÇÃO: A data anterior não tinha horários disponíveis. NÃO chame verificar_disponibilidade. Pergunte ao paciente qual nova data prefere, ou chame buscar_proximas_datas para mostrar datas disponíveis.' : ''}
PRÓXIMO CAMPO A COLETAR: ${(cs.pending_fields || [])[0] || 'NENHUM — PRONTO PARA CONFIRMAR'}
${cs.last_question_asked ? `ÚLTIMA PERGUNTA FEITA (NÃO REPITA): "${cs.last_question_asked}"` : ''}
${cs.pending_info_question ? `⚠️ PERGUNTA DE INFORMAÇÃO PENDENTE (RESPONDA PRIMEIRO): "${cs.pending_info_question}"\n→ O paciente perguntou sobre preço/convênio/pagamento. RESPONDA ISSO ANTES de retomar o agendamento.` : ''}
${(cs.last_suggested_dates || []).length > 0
  ? `DATAS JÁ APRESENTADAS AO PACIENTE: ${cs.last_suggested_dates.map((d, i) => `${i + 1}) ${d.day_of_week}, ${d.formatted_date}`).join(' | ')}`
  : ''}
${(cs.last_suggested_slots || []).length > 0
  ? `HORÁRIOS JÁ APRESENTADOS AO PACIENTE: ${cs.last_suggested_slots.map((s, i) => `${i + 1}) ${s}`).join(' | ')}`
  : ''}
`.trim();

  const summarySection = cs.running_summary
    ? `## RESUMO DA CONVERSA ANTERIOR:\n${cs.running_summary}\n\n---\n\n`
    : '';

  return `${summarySection}## QUEM VOCÊ É
Você é a Lara, secretária virtual da clínica. Você é inteligente, acolhedora e humana.
Você entende QUALQUER mensagem do paciente — seja agendamento, dúvida, sintoma, reclamação ou conversa.

## TOM DE VOZ
- Fale como uma pessoa real, não como robô
- Respostas curtas e diretas (máximo 3 frases quando possível)
- Use no máximo 1-2 emojis por mensagem 😊
- NUNCA repita a mesma pergunta duas vezes
- NUNCA faça duas perguntas na mesma mensagem

## DATA E HORA ATUAL
Hoje é: **${CURRENT_DATE}** (${CURRENT_WEEKDAY})
Amanhã é: **${TOMORROW_DATE}**

## MÉDICOS DA CLÍNICA
${doctorsList || 'Nenhum cadastrado'}

## ESPECIALIDADES DISPONÍVEIS
${specialtiesList || 'Nenhuma'}

## FUNCIONAMENTO DA CLÍNICA
${clinicSettings?.policies_text || 'Segunda a sexta, 8h às 18h'}

## INFORMAÇÕES DA CLÍNICA
${kbContext || 'Sem informações adicionais'}

---

${stateDisplay}

---

## COMO RESPONDER CADA TIPO DE MENSAGEM

### 1. CONVERSA SIMPLES (saudações, agradecimentos, despedidas)
Exemplos: "oi", "tudo bem?", "obrigado", "tchau", "ok"
→ Responda naturalmente em 1 frase. NÃO tente agendar. NÃO use tools.
→ "Olá! Tudo bem sim, obrigada 😊 Como posso te ajudar hoje?"

### 2. PACIENTE DESCREVE SINTOMA OU PROBLEMA DE SAÚDE
Exemplos: "estou com dor nas costas", "tenho manchas na pele", "meu coração acelera"
→ Acolha o paciente com empatia, sugira a especialidade certa, e pergunte se quer agendar.
→ Use este mapeamento:
   - dor nas costas, coluna, joelho, fratura → Ortopedia
   - manchas, acne, pele, cabelo, unhas → Dermatologia
   - coração, pressão alta, falta de ar → Cardiologia
   - ansiedade, depressão, emoções → Psicologia
   - alimentação, peso, dieta → Nutrição
   - menstruação, gravidez, ginecológico → Ginecologia
   - criança doente, febre, pediatra → Pediatria
   - consulta geral, check-up, exame → Clínico Geral
→ Exemplo de resposta: "Entendi, para dor nas costas o ideal é uma consulta com ortopedia. Gostaria de agendar? 😊"

### 3. DÚVIDAS SOBRE A CLÍNICA (preço, convênio, pagamento, endereço)
Exemplos: "qual o endereço?", "aceita convênio?", "qual o preço?", "quais médicos têm?"
→ Responda COM AS INFORMAÇÕES DA KB acima. NUNCA diga que não sabe se a KB tem a resposta.
→ Se a KB não tem: diga "Para essa informação específica, recomendo ligar diretamente para a clínica."
→ Se já estava num agendamento: RESPONDA A DÚVIDA COMPLETAMENTE PRIMEIRO. Só depois retome o agendamento.

### 3B. MENSAGEM MISTA (dúvida + pedido de agendamento NA MESMA MENSAGEM)
Exemplos: "quanto custa e vocês aceitam unimed? quero marcar consulta"
→ OBRIGATÓRIO: Responda a dúvida de informação PRIMEIRO
→ Só depois pergunte sobre o agendamento
→ NUNCA pule a resposta da dúvida para ir direto ao agendamento

### 4. QUER AGENDAR (explícito ou implícito)
Exemplos: "quero marcar", "preciso de uma consulta", "tem horário?"
→ Siga o fluxo de agendamento abaixo.

### 5. NÃO ENTENDEU OU MENSAGEM CONFUSA
→ Peça gentilmente para o paciente repetir: "Não entendi muito bem. Pode me dizer o que você precisa? 😊"
→ NUNCA invente uma resposta. NUNCA force um fluxo que não foi pedido.

---

## FLUXO DE AGENDAMENTO

Colete os dados nesta ordem (pule o que já tem ✅):

**1. MÉDICO/ESPECIALIDADE** — Se o paciente não sabe qual especialidade, ajude com base nos sintomas.
   → Quando tiver o médico, chame IMEDIATAMENTE 'buscar_proximas_datas' para mostrar datas disponíveis.
   → NÃO pergunte a data antes de mostrar as opções.

**2. DATA E HORÁRIO** — Mostre as datas retornadas pela tool. Formato:
   "📅 [Médico] tem horários em:
   [dia da semana], [DD/MM] — [horário1] · [horário2]
   Qual você prefere?"
   → Se paciente escolher data específica: chame 'verificar_disponibilidade'.
   → Se não tiver horário nessa data: chame 'buscar_proximas_datas' e mostre alternativas. NÃO repita "não encontrei" — mostre as próximas opções disponíveis.

**3. NOME** — Peça o nome completo do paciente (se ainda não tem).

**4. CONFIRMAÇÃO** — Mostre resumo e peça confirmação:
   "Confirmo sua consulta:
   👨‍⚕️ [médico]
   📅 [data] às [horário]
   👤 [nome]
   Está correto? 😊"

**5. AGENDAR** — Só após o paciente confirmar ("sim", "pode", "confirmo"), chame 'criar_agendamento'.

---

## REGRAS CRÍTICAS (NUNCA VIOLE)

1. **NUNCA invente horários ou datas** — use SOMENTE o que as tools retornarem
2. **NUNCA repita a mesma pergunta** que já foi respondida (verifique o estado ✅)
3. **NUNCA faça duas perguntas** na mesma mensagem
4. **NUNCA diga "não encontrei horários" duas vezes seguidas** — mostre alternativas
5. **NUNCA ignore o que o paciente perguntou** — sempre responda a pergunta antes de retomar o agendamento
6. Se o paciente der uma data, calcule o dia da semana correto:
   - "amanhã" = ${TOMORROW_DATE}
   - "segunda", "terça" etc = próxima ocorrência desse dia
   - Sempre converta para YYYY-MM-DD antes de chamar tools
7. Se booking_state = 'collecting_date': NÃO chame verificar_disponibilidade. Chame buscar_proximas_datas OU pergunte qual data o paciente prefere.

${(cs.stuck_counter?.preferred_date || 0) >= 2 ? '⚠️ Data perguntada 2+ vezes. NÃO pergunte de novo. Chame buscar_proximas_datas e mostre as opções.' : ''}
${(cs.stuck_counter?.preferred_time || 0) >= 2 ? '⚠️ Horário perguntado 2+ vezes. NÃO pergunte de novo. Mostre os horários disponíveis diretamente.' : ''}

---

## FLUXO DE AGENDAMENTO: SEQUÊNCIA OBRIGATÓRIA (v4)

Ao agendar uma consulta, siga RIGOROSAMENTE esta sequência:

1. **ESPECIALIDADE/MÉDICO** — Pergunte qual especialidade ou médico o paciente deseja.
   Quando o paciente responder, resolva o médico e IMEDIATAMENTE chame a tool 'buscar_proximas_datas'
   com o doctor_id para obter os próximos horários disponíveis. NÃO pergunte a data antes de chamar a tool.

`.trim();
};

// ======================================================
// ROTA: GET /history — histórico de conversa por usuário
// ======================================================
app.get('/history', checkAgentAuth, async (req, res) => {
  const { from, clinic_id, limit = '10' } = req.query;

  if (!from || !clinic_id) {
    return res.status(400).json({ error: 'Parâmetros obrigatórios: from, clinic_id' });
  }

  const parsedLimit = Math.min(Number(limit) || 10, 30);

  const { data, error } = await supabase
    .from('conversation_history')
    .select('role, message_text')
    .eq('clinic_id', clinic_id)
    .eq('from_number', from)
    .order('created_at', { ascending: false })
    .limit(parsedLimit);

  if (error) {
    log.warn({ err: String(error) }, 'history_fetch_failed');
    return res.status(500).json({ error: 'Erro ao buscar histórico' });
  }

  // Inverter para ordem cronológica (mais antigo primeiro)
  const messages = (data || []).reverse().map(r => ({
    role: r.role,
    content: r.message_text,
  }));

  return res.json({ messages });
});

// ======================================================
// ROTA PRINCIPAL: /process
// ======================================================
app.post('/process', verifyWebhookSignature, checkAgentAuth, async (req, res) => {
  const started = Date.now();
  const DEBUG = process.env.DEBUG === 'true';
  const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS || 2);
  const GLOBAL_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 12000);

  // 1) VALIDAR DADOS DE ENTRADA
  const parsed = EnvelopeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'invalid_envelope',
      details: parsed.error.flatten(),
    });
  }

  const envelope = parsed.data;

  // Helper: parser JSON seguro
  const safeJsonParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };

  // AbortController para timeout total da requisição (JG-P2-008)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GLOBAL_TIMEOUT_MS);

  // Rastrear se o lock foi adquirido para liberar no finally
  let processingLockAcquired = false;

  try {
    // ======================================================
    // 0) DEDUP POR WAMID (inbound_dedup)
    // correlation_id vem do wa_message_id setado pelo n8n.
    // INSERT ON CONFLICT DO NOTHING: se 0 linhas afetadas → mensagem já processada.
    // ======================================================
    try {
      const { error: dedupErr, count: dedupCount } = await supabase
        .from('inbound_dedup')
        .insert({
          clinic_id:     envelope.clinic_id,
          wa_message_id: envelope.correlation_id,
        }, { count: 'exact' });

      if (!dedupErr && dedupCount === 0) {
        // ON CONFLICT: linha já existe → mensagem duplicada
        log.info({ correlation_id: envelope.correlation_id }, '[DEDUP] wamid já processado — ignorando');
        clearTimeout(timeoutId);
        return res.json({
          correlation_id: envelope.correlation_id,
          final_message: null,
          actions: [{ type: 'dedup_blocked', payload: { reason: 'duplicate_wamid' } }],
        });
      }
      if (dedupErr && dedupErr.code !== '23505') {
        // 23505 = unique_violation: duplicata (tratada acima via count)
        // Outros erros: logar mas não bloquear o fluxo
        log.warn({ err: String(dedupErr) }, '[DEDUP] Erro ao inserir inbound_dedup — continuando');
      }
    } catch (dedupEx) {
      log.warn({ err: String(dedupEx) }, '[DEDUP] Exceção no dedup — continuando sem proteção');
    }

    // ======================================================
    // COOLDOWN ATÔMICO — substitui o SELECT não-atômico anterior
    // O SELECT anterior tinha race condition: duas requisições simultâneas
    // passavam pelo guard porque ambas liam "sem resposta recente" antes
    // de qualquer uma terminar. Esta função SQL é atômica (UPDATE condicional).
    // ======================================================
    // Cooldown de 3s: suficiente para deduplicar webhooks repetidos sem bloquear conversas normais.
    // O lock é liberado no bloco finally ao final do processamento (sucesso ou erro).
    const COOLDOWN_SECONDS = Math.floor(Number(process.env.SESSION_COOLDOWN_MS || 3000) / 1000);
    try {
      const { data: lockResult, error: lockErr } = await supabase
        .rpc('try_acquire_processing_lock', {
          p_clinic_id: envelope.clinic_id,
          p_from_number: envelope.from,
          p_cooldown_seconds: COOLDOWN_SECONDS,
        });

      if (lockErr) {
        log.warn({ err: String(lockErr) }, '[LOCK] Erro ao tentar lock — continuando');
      } else if (lockResult === false) {
        log.info({ from: envelope.from }, '[LOCK] Lock não adquirido — requisição duplicada ignorada');
        clearTimeout(timeoutId);
        return res.json({
          correlation_id: envelope.correlation_id,
          final_message: null,
          actions: [{ type: 'cooldown_active' }],
        });
      } else {
        processingLockAcquired = true; // Lock adquirido com sucesso
      }
    } catch (lockEx) {
      log.warn({ err: String(lockEx) }, '[LOCK] Exceção no lock — continuando sem proteção');
    }

    // ======================================================
    // 2) BUSCAR CONFIGURAÇÕES DA CLÍNICA
    // ======================================================
    const { data: settings, error: settingsErr } = await supabase
      .from('clinic_settings')
      .select('*')
      .eq('clinic_id', envelope.clinic_id)
      .maybeSingle();

    if (settingsErr) throw settingsErr;

    if (!settings) {
      log.warn(
        { clinic_id: envelope.clinic_id, correlation_id: envelope.correlation_id },
        'clinic_settings_not_found_using_defaults'
      );
    }

    const clinicRules = settings ?? {
      clinic_id: envelope.clinic_id,
      allow_prices: false,
      timezone: 'America/Cuiaba',
      business_hours: {
        mon: { open: '08:00', close: '18:00' },
        tue: { open: '08:00', close: '18:00' },
        wed: { open: '08:00', close: '18:00' },
        thu: { open: '08:00', close: '18:00' },
        fri: { open: '08:00', close: '18:00' },
        sat: {},
        sun: {},
      },
      policies_text: 'Atendemos de segunda a sexta, das 8h às 18h.',
    };

    // ======================================================
    // 3) BUSCAR BASE DE CONHECIMENTO (RAG)
    // ======================================================
    const { data: kbRows, error: kbErr } = await supabase
      .from('clinic_kb')
      .select('title, content')
      .eq('clinic_id', envelope.clinic_id)
      .limit(8);

    if (kbErr) throw kbErr;

    const kbContext = (kbRows ?? [])
      .map((r) => `• ${r.title}: ${r.content}`)
      .join('\n');

    // ======================================================
    // 3b) BUSCAR MÉDICOS, SERVIÇOS E ESTADO DA CONVERSA
    // ======================================================
    const [doctorsResult, servicesResult, conversationState] = await Promise.all([
      supabase
        .from('doctors')
        .select('id, name, specialty')
        .eq('clinic_id', envelope.clinic_id)
        .eq('active', true),
      supabase
        .from('services')
        .select('name, duration_minutes, price')
        .eq('clinic_id', envelope.clinic_id)
        .eq('active', true),
      loadConversationState(supabase, envelope.clinic_id, envelope.from),
    ]);
    const doctors = doctorsResult.data || [];
    const services = servicesResult.data || [];

    if (DEBUG) {
      log.debug({ state: conversationState }, 'conversation_state_loaded');
    }
    console.log('📊 Estado carregado:', JSON.stringify(conversationState, null, 2));

    if (DEBUG) {
      log.debug({ doctors: doctors.length, services: services.length }, 'clinic_data_loaded');
    }

    // — Conversation Tracking (ADITIVO — não altera fluxo existente) —
    let conversationRecord = null;
    try {
      conversationRecord = await getOrCreateConversation(
        supabase,
        envelope.clinic_id,
        envelope.from,
        conversationState?.id || null
      );
    } catch (trackingError) {
      console.warn('[ConversationTracker] Erro não-bloqueante:', trackingError.message);
      // NÃO interrompe o fluxo — tracking é best-effort
    }

    // Acumuladores de usage da OpenAI (para tracking de custo)
    let totalTokensInput = 0;
    let totalTokensOutput = 0;

    // ======================================================
    // 4) DEFINIR TOOLS (Function Calling)
    // ======================================================
    const tools = [
      {
        type: 'function',
        function: {
          name: 'extract_intent',
          strict: false, // 🔧 CORRIGIDO: strict false para evitar erros de schema
          description:
            'Classifica intenção (2 níveis) e extrai slots estruturados. Não escreve resposta ao usuário.',
          parameters: {
            type: 'object',
            properties: {
              intent_group: {
                type: 'string',
                enum: [
                  'scheduling',
                  'procedures',
                  'clinical',
                  'billing',
                  'logistics',
                  'results',
                  'other',
                ],
              },
              intent: { type: 'string' },
              slots: {
                type: 'object',
                properties: {
                  patient_name: { type: 'string' },
                  specialty_or_reason: { type: 'string' },
                  preferred_date_text: { type: 'string' },
                  preferred_time_text: { type: 'string' },
                  time_window: {
                    type: 'string',
                    enum: [
                      'morning',
                      'afternoon',
                      'evening',
                      'after_18',
                      'before_10',
                      'any',
                      'unknown',
                    ],
                  },
                  doctor_preference: { type: 'string' },
                  unit_preference: { type: 'string' },
                  procedure_name: { type: 'string' },
                  procedure_area: { type: 'string' },
                  goal: { type: 'string' },
                  price_request: { type: 'boolean' },
                  symptom_summary: { type: 'string' },
                  duration: { type: 'string' },
                  severity: { type: 'string' },
                  red_flags_present: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                  comorbidities: { type: 'string' },
                  current_meds: { type: 'string' },
                  requested_care_type: { type: 'string' },
                  test_type: { type: 'string' },
                  result_status: { type: 'string' },
                  collection_date: { type: 'string' },
                  fasting_question: { type: 'boolean' },
                  abnormal_values_mentioned: { type: 'string' },
                  next_step_request: { type: 'string' },
                },
              },
              missing_fields: {
                type: 'array',
                items: { type: 'string' },
              },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
            },
            required: ['intent_group', 'intent', 'confidence'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'decide_next_action',
          strict: false, // 🔧 CORRIGIDO: strict false para evitar erros de schema
          description:
            'Decide o próximo passo (policy), com base no extracted + regras + KB. Retorna mensagem curta e ações sugeridas.',
          parameters: {
            type: 'object',
            properties: {
              decision_type: {
                type: 'string',
                enum: ['ask_missing', 'block_price', 'handoff', 'proceed'],
              },
              message: { type: 'string' },
              actions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'string' },
                    payload: { type: 'object' },
                  },
                  required: ['type'],
                },
              },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
            },
            required: ['decision_type', 'message'],
          },
        },
      },
    ];

    // ======================================================
    // 5) FEW-SHOT EXAMPLES
    // ======================================================
    const fewShots = `
Exemplo 1:
Usuário: "Quero marcar consulta amanhã de manhã"
extract_intent => {"intent_group":"scheduling","intent":"schedule_new","slots":{"time_window":"morning","preferred_date_text":"amanhã"},"missing_fields":["patient_name","specialty_or_reason"],"confidence":0.92}

Exemplo 2:
Usuário: "Quanto custa botox?"
extract_intent => {"intent_group":"billing","intent":"procedure_pricing_request","slots":{"procedure_name":"botox","price_request":true},"missing_fields":[],"confidence":0.95}
`.trim();

    // ======================================================
    // 6) LOOP CONTROLADO - STEP 0: extract_intent
    // ======================================================
    let step = 0;
    let extracted = null;
    let decided = null;
    let skipSchedulingAgent = false;
// Buscar histórico de conversas — usa o que o N8N enviou ou vai ao banco
let previousMessages = envelope.context?.previous_messages || [];

if (previousMessages.length === 0) {
  // CORREÇÃO Problema 2: buscar apenas as últimas 10 mensagens (evita timeout por excesso de tokens)
  const { data: historyRows } = await supabase
    .from('conversation_history')
    .select('role, message_text, created_at')
    .eq('clinic_id', envelope.clinic_id)
    .eq('from_number', envelope.from)
    .order('created_at', { ascending: false })
    .limit(10);

  if (historyRows && historyRows.length > 0) {
    // Inverter para ordem cronológica correta antes de passar ao OpenAI
    previousMessages = historyRows.reverse().map(r => ({
      role: r.role,
      content: r.message_text,
    }));
  } else {
    // CORREÇÃO Problema 1: histórico vazio (novo número ou deletado manualmente)
    // Resetar conversation_state para evitar que contexto antigo persista
    const currentState = conversationState;
    // Não resetar estado BOOKED — o paciente pode perguntar sobre o agendamento que fez
    const isBookedState = currentState?.booking_state === BOOKING_STATES.BOOKED;
    const hasStaleState = !isBookedState && currentState && (
      currentState.doctor_id ||
      currentState.specialty ||
      currentState.preferred_date ||
      currentState.preferred_time ||
      (currentState.booking_state && currentState.booking_state !== 'idle')
    );
    if (hasStaleState) {
      console.log(`[HISTÓRICO] Histórico vazio mas estado antigo detectado — resetando conversation_state para ${envelope.from}`);
      logDecision('state_reset_on_empty_history', {
        reason: 'history_empty_stale_state_detected',
        stale_state: {
          doctor_id: currentState.doctor_id,
          specialty: currentState.specialty,
          booking_state: currentState.booking_state,
        },
      }, envelope.clinic_id, envelope.from);
      await resetConversationState(supabase, envelope.clinic_id, envelope.from);
      // Recarregar o estado resetado
      Object.assign(conversationState, await loadConversationState(supabase, envelope.clinic_id, envelope.from));
    }

    // CAMADA 2 — Cenário A: Primeira mensagem → retornar saudão com botões interativos
    // CORREÇÃO 4: Verificar se greeting já foi enviado recentemente (evita duplicação)
    // CORREÇÃO 2+4: Só retorna greeting se NÃO houver intent_override (botão clicado)
    const isFirstMessage = !envelope.intent_override;

    // BOOKED-GUARD: se o paciente já agendou, nunca mostrar greeting genérico.
    // O greeting redefinia booking_state→IDLE e apagava doctor_id/nome/data — bug crítico.
    if (isFirstMessage && isBookedState) {
      const csB = conversationState;
      const bookedWelcomeMsg = `Olá! Seu agendamento está confirmado ✅\n\n👤 Paciente: ${csB.patient_name || 'Você'}\n👨‍⚕️ Médico: ${csB.doctor_name || '—'}\n📅 Data: ${csB.preferred_date_iso || csB.preferred_date || '—'}\n🕐 Horário: ${csB.preferred_time || '—'}\n\nComo posso te ajudar?`;
      await saveConversationTurn({
        clinicId: envelope.clinic_id, fromNumber: envelope.from,
        correlationId: envelope.correlation_id, userText: envelope.message_text,
        assistantText: bookedWelcomeMsg, intentGroup: 'scheduling', intent: 'booked_welcome', slots: null,
      });
      clearTimeout(timeoutId);
      return res.json({
        correlation_id: envelope.correlation_id,
        final_message: bookedWelcomeMsg,
        actions: [{
          type: 'send_interactive_buttons',
          payload: {
            buttons: [
              { id: 'view_appointments', title: '📋 Meus agendamentos' },
              { id: 'schedule_new',      title: '📅 Novo agendamento' },
              { id: 'ask_question',      title: '❓ Tirar uma dúvida' },
            ],
          },
        }],
        debug: DEBUG ? { source: 'booked_welcome_guard' } : undefined,
      });
    }

    if (isFirstMessage) {
      // CORREÇÃO 4: Verificar se já existe um greeting recente no conversation_state
      // Isso evita duplicação quando duas mensagens chegam em rápida sucessão
      const greetingAlreadySent = conversationState?.greeting_sent_at &&
        (Date.now() - new Date(conversationState.greeting_sent_at).getTime()) < 10000; // 10s
      if (greetingAlreadySent) {
        console.log(`[CORREÇÃO 4] Greeting já enviado há menos de 10s para ${envelope.from} — bloqueando duplicação`);
        clearTimeout(timeoutId);
        return res.json({
          correlation_id: envelope.correlation_id,
          final_message: null,
          actions: [{ type: 'dedup_blocked', payload: { reason: 'greeting_already_sent' } }],
        });
      }
      // Saudação sensível ao horário do dia
      const greetingHour = Number(new Date().toLocaleString('pt-BR', { hour: 'numeric', hour12: false, timeZone: clinicRules?.timezone || 'America/Cuiaba' }));
      const greetingSaudacao = greetingHour < 12 ? 'Bom dia' : greetingHour < 18 ? 'Boa tarde' : 'Boa noite';
      const greetingMessage = `${greetingSaudacao}! Sou a Lara, secretária virtual da clínica. Como posso te ajudar? 😊`;
      // CORREÇÃO 2: Salvar histórico antes de retornar (evita loop de greeting)
      await saveConversationTurn({
        clinicId: envelope.clinic_id,
        fromNumber: envelope.from,
        correlationId: envelope.correlation_id,
        userText: envelope.message_text,
        assistantText: greetingMessage,
        intentGroup: 'other',
        intent: 'greeting',
        slots: null,
      });
      // Reset de agendamento ao iniciar nova conversa — limpa estado antigo que poderia
      // causar data errada na confirmação (bug: preferred_date de sessão anterior persistia)
      await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
        booking_state: BOOKING_STATES.IDLE,
        preferred_date: null,
        preferred_date_iso: null,
        preferred_time: null,
        patient_name: null,
        doctor_id: null,
        doctor_name: null,
        specialty: null,
        last_suggested_dates: [],
        last_suggested_slots: [],
        stuck_counter_slots: 0,
        stuck_counter_off_topic: 0,
        greeting_sent_at: new Date().toISOString(),
        conversation_stage: 'greeting',
      });
      clearTimeout(timeoutId);
      return res.json({
        correlation_id: envelope.correlation_id,
        final_message: greetingMessage,
        actions: [{
          type: 'send_interactive_buttons',
          payload: {
            buttons: [
              { id: 'schedule_new',      title: '\uD83D\uDCC5 Agendar consulta' },   // 19 chars
              { id: 'view_appointments', title: '\uD83D\uDCCB Meus agendamentos' },   // 20 chars
              { id: 'ask_question',      title: '\u2753 Tirar uma dúvida' }, // 20 chars
            ],
          },
        }],
        debug: DEBUG ? { source: 'camada2_greeting' } : undefined,
      });
    }
  }
}

if (DEBUG) {
  log.debug({ count: previousMessages.length }, 'previous_messages_loaded');
}

// ======================================================
// CORREÇÃO PROBLEMA-1: Saudação de retorno para sessões inativas
// Se o usuário tem histórico mas ficou inativo por >= SESSION_TIMEOUT_HOURS,
// enviar saudação contextual em vez de entrar no estado antigo sem avisar.
// ======================================================
if (previousMessages.length > 0 && !envelope.intent_override) {
  const SESSION_TIMEOUT_HOURS = Number(process.env.SESSION_TIMEOUT_HOURS || 4);
  const lastActivity = conversationState?.last_activity_at;
  const hoursSinceLast = lastActivity
    ? (Date.now() - new Date(lastActivity).getTime()) / 3600000
    : Infinity;

  if (hoursSinceLast >= SESSION_TIMEOUT_HOURS) {
    const bookingState = conversationState?.booking_state;
    const hadActiveBooking = bookingState &&
      ![BOOKING_STATES.IDLE, BOOKING_STATES.BOOKED].includes(bookingState) &&
      conversationState?.doctor_name;

    console.log(`[RETORNO] Usuário retornou após ${hoursSinceLast.toFixed(1)}h. booking_state=${bookingState}. hadActiveBooking=${hadActiveBooking}`);

    let returnGreeting;
    let returnActions;

    if (hadActiveBooking) {
      // Estava no meio de um agendamento — perguntar se quer continuar
      const doctorName = conversationState.doctor_name || 'o médico';
      returnGreeting = `Olá! Que bom te ver de volta 😊 Você havia iniciado um agendamento com ${doctorName}. Gostaria de continuar ou prefere começar do zero?`;
      returnActions = [{
        type: 'send_interactive_buttons',
        payload: {
          buttons: [
            { id: 'continue_booking', title: '▶️ Continuar agendamento' },
            { id: 'schedule_new',     title: '🔄 Começar do zero' },
          ],
        },
      }];
    } else {
      // Nenhum agendamento ativo — saudação limpa
      const hourOfDay = new Date().toLocaleString('pt-BR', { hour: 'numeric', hour12: false, timeZone: clinicRules?.timezone || 'America/Cuiaba' });
      const hora = Number(hourOfDay);
      const saudacao = hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite';
      returnGreeting = `${saudacao}! Sou a Lara 😊 Como posso te ajudar hoje?`;
      returnActions = [{
        type: 'send_interactive_buttons',
        payload: {
          buttons: [
            { id: 'schedule_new',      title: '📅 Agendar consulta' },
            { id: 'view_appointments', title: '📋 Meus agendamentos' },
            { id: 'ask_question',      title: '❓ Tirar uma dúvida' },
          ],
        },
      }];
      // Limpar estado stale — nova sessão limpa
      await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
        booking_state: BOOKING_STATES.IDLE,
        preferred_date: null, preferred_date_iso: null, preferred_time: null,
        last_suggested_dates: [], last_suggested_slots: [],
        stuck_counter_slots: 0, stuck_counter_off_topic: 0,
        doctor_id: null, doctor_name: null, specialty: null,
        patient_name: null, pending_fields: [], last_question_asked: null,
      });
    }

    await saveConversationTurn({
      clinicId: envelope.clinic_id, fromNumber: envelope.from,
      correlationId: envelope.correlation_id, userText: envelope.message_text,
      assistantText: returnGreeting, intentGroup: 'other', intent: 'return_greeting', slots: null,
    });
    clearTimeout(timeoutId);
    return res.json({
      correlation_id: envelope.correlation_id,
      final_message: returnGreeting,
      actions: returnActions,
      debug: DEBUG ? { source: 'return_greeting', hours_since_last: hoursSinceLast.toFixed(1), had_active_booking: hadActiveBooking } : undefined,
    });
  }
}

// Construir array de mensagens incluindo histórico
const messages = [
  {
    role: 'system',
    content: [
      'Você é um classificador/estruturador. Sua única saída é JSON.',
      'Não gere texto para o usuário.',
      'Não invente dados. Se incerto, mantenha confidence baixa.',
      'Taxonomia: intent_group + intent.',
      'Use os slots definidos.',
      'Contexto KB (referência de domínio):',
      kbContext || 'SEM KB',
      '',
      fewShots,
    ].join('\n'),
  },
  // NOVO: Adicionar mensagens anteriores do histórico
  ...previousMessages.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'assistant',
    content: msg.content
  })),
  // Mensagem atual
  {
    role: 'user',
    content: envelope.message_text,
  }
];

// NOVO: Log para debug
console.log(`📜 Histórico: ${previousMessages.length} mensagens anteriores`);

// Gerar summary comprimido se conversa está longa
let activeConvState = conversationState;
if (previousMessages.length > 0) {
  activeConvState = await maybeGenerateSummary(previousMessages, conversationState, openai);
  if (activeConvState.running_summary !== conversationState.running_summary) {
    await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
      running_summary: activeConvState.running_summary,
    });
  }
}

// ======================================================
// CAMADA 1: Se chegou intent_override de botão → pular extract_intent
// Isso elimina 1 chamada ao LLM e garante classificação 100% precisa
// ======================================================
if (envelope.intent_override) {
  console.log(`[INTENT_OVERRIDE] Intent pré-classificada por botão: ${envelope.intent_override}`);
  extracted = {
    intent_group: resolveIntentGroup(envelope.intent_override),
    intent: envelope.intent_override,
    slots: {},
    missing_fields: [],
    confidence: 1.0,
    source: 'button_override',
  };
  step = 1; // pular o step de extract_intent

  // FIX v5.2: Tratar view_appointments deterministicamente
  if (envelope.intent_override === 'view_appointments') {
    try {
      const appointments = await executeSchedulingTool(
        'listar_meus_agendamentos',
        { patient_phone: envelope.from },
        { clinicId: envelope.clinic_id, userPhone: envelope.from }
      );
      let viewMsg;
      if (appointments?.success && appointments?.appointments?.length > 0) {
        const list = appointments.appointments.map(a => 
          `📅 ${a.date || a.appointment_date} às ${a.time || a.start_time} — ${a.doctor_name || 'Médico'} (${a.status || 'agendado'})`
        ).join('\n');
        viewMsg = `Seus agendamentos:\n\n${list}\n\nDeseja remarcar, cancelar ou agendar uma nova consulta?`;
      } else {
        viewMsg = 'Você ainda não tem agendamentos. Gostaria de agendar uma consulta? 😊';
      }
      await saveConversationTurn({
        clinicId: envelope.clinic_id,
        fromNumber: envelope.from,
        correlationId: envelope.correlation_id,
        userText: envelope.message_text,
        assistantText: viewMsg,
        intentGroup: 'scheduling',
        intent: 'view_appointments',
        slots: null,
      });
      clearTimeout(timeoutId);
      return res.json({
        correlation_id: envelope.correlation_id,
        final_message: viewMsg,
        actions: [],
      });
    } catch (viewErr) {
      console.error('[VIEW_APPOINTMENTS] Erro:', viewErr);
    }
  }

  // FIX v5.3: Handler para botões "Esta semana" / "Próxima semana"
  if (envelope.intent_override === 'week_current' || envelope.intent_override === 'week_next') {
    const isCurrentWeek = envelope.intent_override === 'week_current';
    const allDates = conversationState?.last_suggested_dates || [];
    const doctorDisplayName = conversationState?.doctor_name || 'Médico';

    // Calcular intervalo da semana
    const now = new Date();
    const currentDay = now.getDay(); // 0=dom, 1=seg, ...
    let weekStart, weekEnd;
    if (isCurrentWeek) {
      weekStart = new Date(now);
      weekEnd = new Date(now);
      weekEnd.setDate(now.getDate() + (6 - currentDay)); // até sábado
    } else {
      weekStart = new Date(now);
      weekStart.setDate(now.getDate() + (7 - currentDay + 1)); // próxima segunda
      weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 5); // até sábado
    }
    const weekStartStr = weekStart.toISOString().split('T')[0];
    const weekEndStr = weekEnd.toISOString().split('T')[0];

    // Filtrar datas da semana escolhida
    const weekDates = allDates.filter(d => {
      const dateStr = d.date_iso || d.date;
      return dateStr >= weekStartStr && dateStr <= weekEndStr;
    });

    // Filtrar horários passados no dia atual
    const todayStr = now.toISOString().split('T')[0];
    const currentTotalMin = now.getHours() * 60 + now.getMinutes();

    let weekMsg;
    if (weekDates.length > 0) {
      const label = isCurrentWeek ? 'Esta semana' : 'Próxima semana';
      weekMsg = `📅 *${doctorDisplayName}* — ${label}:\n\n`;
      weekDates.forEach(d => {
        let slots = d.slots || [];
        // Filtrar horários passados no dia atual
        if ((d.date_iso || d.date) === todayStr) {
          slots = slots.filter(s => {
            const [h, m] = s.split(':').map(Number);
            return (h * 60 + m) > currentTotalMin;
          });
        }
        if (slots.length > 0) {
          const slotsFormatted = slots.slice(0, 6).join(' · ');
          weekMsg += `📅 *${d.day_of_week}, ${d.formatted_date}*\n   ${slotsFormatted}\n\n`;
        }
      });
      weekMsg += `Qual dia e horário você prefere?`;
    } else {
      const otherLabel = isCurrentWeek ? 'próxima semana' : 'esta semana';
      weekMsg = `Não há horários disponíveis ${isCurrentWeek ? 'nesta' : 'na próxima'} semana. Gostaria de verificar ${otherLabel}?`;
    }

    await saveConversationTurn({
      clinicId: envelope.clinic_id,
      fromNumber: envelope.from,
      correlationId: envelope.correlation_id,
      userText: envelope.message_text,
      assistantText: weekMsg,
      intentGroup: 'scheduling',
      intent: envelope.intent_override,
      slots: null,
    });
    clearTimeout(timeoutId);
    return res.json({
      correlation_id: envelope.correlation_id,
      final_message: weekMsg,
      actions: [],
    });
  }

  // Handler para botão "Continuar agendamento" (retorno após inatividade)
  if (envelope.intent_override === 'continue_booking') {
    const bState = conversationState?.booking_state;
    const drName = conversationState?.doctor_name;
    const spec   = conversationState?.specialty;
    const pDate  = conversationState?.preferred_date_iso || conversationState?.preferred_date;
    let continueMsg;
    if (drName && pDate) {
      continueMsg = `Ótimo! Continuando o agendamento com *${drName}*.\n📅 Data que você havia escolhido: ${formatDateBR(pDate)}.\n\nQuer confirmar esta data ou escolher outra?`;
    } else if (drName) {
      continueMsg = `Ótimo! Continuando o agendamento com *${drName}*.\n\nQual data você prefere?`;
    } else {
      continueMsg = `Claro! Vamos continuar 😊 Qual especialidade ou médico você precisa?`;
    }
    await saveConversationTurn({
      clinicId: envelope.clinic_id, fromNumber: envelope.from,
      correlationId: envelope.correlation_id, userText: envelope.message_text,
      assistantText: continueMsg, intentGroup: 'scheduling', intent: 'continue_booking', slots: null,
    });
    clearTimeout(timeoutId);
    return res.json({ correlation_id: envelope.correlation_id, final_message: continueMsg, actions: [] });
  }

  // FIX v5.4: Handler para botão "Tirar uma dúvida"
  if (envelope.intent_override === 'ask_question') {
    const askMsg = `Claro! Posso te ajudar com informações sobre:\n\n` +
      `💰 Valores das consultas e procedimentos\n` +
      `🏷️ Convênios aceitos\n` +
      `💳 Formas de pagamento e parcelamento\n` +
      `⏱️ Duração dos procedimentos\n` +
      `👨‍⚕️ Especialidades disponíveis\n\n` +
      `O que você gostaria de saber?`;
    await saveConversationTurn({
      clinicId: envelope.clinic_id,
      fromNumber: envelope.from,
      correlationId: envelope.correlation_id,
      userText: envelope.message_text,
      assistantText: askMsg,
      intentGroup: 'other',
      intent: 'ask_question',
      slots: null,
    });
    clearTimeout(timeoutId);
    return res.json({
      correlation_id: envelope.correlation_id,
      final_message: askMsg,
      actions: [],
    });
  }
}

// ======================================================
// INTERCEPTOR DE ENCERRAMENTO / RECUSA (CORREÇÃO #16)
// Detecta quando o paciente recusa, agradece ou encerra
// a conversa, evitando loop de respostas desnecessárias.
// DEVE ser verificado ANTES do interceptor de agendamento.
// ======================================================
const ENCERRAMENTO_PATTERNS = [
  // Recusas diretas
  /^n[aã]o\s*(obrigad[ao]|,?\s*obrigad[ao])?$/i,
  /^n[aã]o\s*(preciso|quero|desejo|necessito)/i,
  /^n[aã]o\s*,?\s*(vlw|valeu|brigad[ao])/i,
  // Agradecimentos de encerramento
  /^(obrigad[ao]|brigad[ao]|vlw|valeu)\s*(!|\.)*$/i,
  /^(muito\s+)?obrigad[ao]/i,
  /^(agradec|thanks|thank)/i,
  // Despedidas (saudações de horário SOZINHAS não encerram — são saudações)
  // "bom dia", "boa tarde", "boa noite" sozinhos = saudação, não encerramento
  /^(tchau|ate\s*(logo|mais|breve)|bye|flw|falou|fui)/i,
  // Encerramento implícito
  /^(s[oó]\s*(isso|era\s*isso)|era\s*s[oó]\s*isso|t[aá]\s*(bom|certo|ok))/i,
  /^(ok|beleza|blz|suave|tranquilo|perfeito)\s*(!|\.)*$/i,
  /^(entendi|entendido|certo)\s*(!|\.)*$/i,
  /^nada\s*(mais|n[aã]o)?$/i,
  /^(por\s*enquanto\s*)?[eé]\s*s[oó]$/i,
];

const normalizedMsgEncerramento = envelope.message_text.trim().toLowerCase()
  .replace(/[!?.]+$/g, '').trim();

const isEncerramento = ENCERRAMENTO_PATTERNS.some(
  pattern => pattern.test(normalizedMsgEncerramento)
);

if (isEncerramento) {
  console.log(`[INTERCEPTOR_ENCERRAMENTO] Encerramento detectado: "${normalizedMsgEncerramento}" | booking_state: ${conversationState?.booking_state || 'idle'}`);

  const shouldResetBooking = conversationState?.booking_state
    && conversationState.booking_state !== BOOKING_STATES.IDLE
    && conversationState.booking_state !== BOOKING_STATES.BOOKED;

  const encerramentoMsg = shouldResetBooking
    ? 'Tudo bem! Se quiser retomar o agendamento depois, é só me chamar. Até logo! 😊'
    : 'Por nada! Se precisar de algo, é só me chamar. Até logo! 😊';

  // Resetar estado da conversa
  await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
    booking_state: BOOKING_STATES.IDLE,
    pending_fields: [],
    last_question_asked: null,
    intent: null,
    running_summary: shouldResetBooking
      ? 'Paciente encerrou conversa durante agendamento.'
      : 'Paciente encerrou conversa após tirar dúvida.',
  });

  await saveConversationTurn({
    clinicId: envelope.clinic_id,
    fromNumber: envelope.from,
    correlationId: envelope.correlation_id,
    userText: envelope.message_text,
    assistantText: encerramentoMsg,
    intentGroup: 'other',
    intent: 'encerramento',
    slots: null,
  });

  clearTimeout(timeoutId);
  return res.json({
    correlation_id: envelope.correlation_id,
    final_message: encerramentoMsg,
    actions: [],
    debug: DEBUG ? { intercepted: true, type: 'encerramento', booking_reset: shouldResetBooking } : undefined,
  });
}

// ======================================================
// CORREÇÃO PROBLEMA-2 e PROBLEMA-3: Interceptor de perguntas informativas
// Quando a mensagem contém DÚVIDA (preço, convênio, pagamento) E há um
// agendamento em andamento, responde a dúvida PRIMEIRO antes de retomar.
// Isso garante que o bot nunca ignore uma pergunta do usuário.
// ======================================================
const messageHasInfoQuestion = detectInfoQuestion(envelope.message_text);
const bookingStateNow = conversationState?.booking_state;
// BOOKED é incluído como "contexto ativo" para perguntas de informação —
// o usuário pode perguntar "qual o valor" logo após confirmar o agendamento
const isInActiveBooking = bookingStateNow &&
  bookingStateNow !== BOOKING_STATES.IDLE;

if (messageHasInfoQuestion) {
  console.log(`[INFO_INTERCEPTOR] Pergunta informativa detectada: "${envelope.message_text.substring(0, 60)}" | booking_state=${bookingStateNow}`);

  // ── STEP 1: Identificar médico (estado > nome na mensagem) ──────────────
  let doctorIdForInfo   = conversationState?.doctor_id   || null;
  let doctorNameForInfo = conversationState?.doctor_name || null;
  let doctorSpecialty   = conversationState?.specialty   || null;

  if (!doctorIdForInfo) {
    // Tenta detectar nome do médico na mensagem ("quanto valor de marcos?")
    try {
      const { data: allDocs } = await supabase
        .from('doctors')
        .select('id, name, specialty')
        .eq('clinic_id', envelope.clinic_id);
      if (allDocs && allDocs.length > 0) {
        const msgNorm = envelope.message_text.toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        for (const doc of allDocs) {
          const parts = doc.name.toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(' ');
          // Só considera partes com 3+ caracteres para evitar falsos positivos
          if (parts.some(p => p.length >= 3 && msgNorm.includes(p))) {
            doctorIdForInfo   = doc.id;
            doctorNameForInfo = doc.name;
            doctorSpecialty   = doc.specialty || doctorSpecialty;
            console.log(`[INFO_INTERCEPTOR] Médico detectado na mensagem: ${doc.name} (${doc.id})`);
            break;
          }
        }
      }
    } catch (e) { console.warn('[INFO_INTERCEPTOR] doctor lookup error:', e.message); }
  }

  // ── STEP 2: PRIORIDADE — preço real do médico (doctor_services) ─────────
  // Isso é sempre a resposta correta quando um médico está identificado.
  // KB genérica só é usada como fallback quando NÃO há médico identificado.
  let priceAnswer = '';
  if (doctorIdForInfo) {
    try {
      const { data: dsRows } = await supabase
        .from('doctor_services')
        .select('custom_price, service_id, services(name, price)')
        .eq('doctor_id', doctorIdForInfo)
        .eq('clinic_id', envelope.clinic_id)
        .limit(5);
      if (dsRows && dsRows.length > 0) {
        const priceLines = dsRows.map(ds => {
          const price = ds.custom_price || ds.services?.price;
          const svcName = ds.services?.name || 'Consulta';
          if (price) return `*${svcName}*: R$ ${Number(price).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
          return null;
        }).filter(Boolean);
        if (priceLines.length > 0) {
          const specStr = doctorSpecialty ? ` (${doctorSpecialty})` : '';
          priceAnswer = `A consulta com *${doctorNameForInfo}*${specStr} custa:\n${priceLines.join('\n')}`;
        }
      }
    } catch (e) { console.warn('[INFO_INTERCEPTOR] doctor_services fetch error:', e.message); }
  }

  // ── STEP 3: Se há preço → responder DIRETAMENTE, sem KB ─────────────────
  if (priceAnswer) {
    const finalPriceMsg = `${priceAnswer}\n\nSe for por convênio, posso verificar a cobertura também. Deseja agendar? 😊`;
    await saveConversationTurn({
      clinicId: envelope.clinic_id, fromNumber: envelope.from,
      correlationId: envelope.correlation_id, userText: envelope.message_text,
      assistantText: finalPriceMsg, intentGroup: 'other', intent: 'info_price_answered', slots: null,
    });
    clearTimeout(timeoutId);
    return res.json({
      correlation_id: envelope.correlation_id,
      final_message: finalPriceMsg,
      actions: [{
        type: 'send_interactive_buttons',
        payload: { buttons: [
          { id: 'schedule_new', title: '📅 Agendar consulta' },
          { id: 'ask_question', title: '❓ Outra dúvida' },
        ]},
      }],
      debug: DEBUG ? { source: 'info_interceptor_price', doctor_id: doctorIdForInfo } : undefined,
    });
  }

  // ── STEP 4: Sem médico identificado → KB genérica (convênios/pagamento) ─
  let kbAnswer = '';
  try {
    const { data: kbInfo } = await supabase
      .from('clinic_kb')
      .select('title, content')
      .eq('clinic_id', envelope.clinic_id)
      .or('title.ilike.%onvênio%,title.ilike.%alor%,title.ilike.%pagamento%,title.ilike.%preço%,title.ilike.%plano%')
      .limit(4);
    if (kbInfo && kbInfo.length > 0) {
      kbAnswer = kbInfo.map(k => `*${k.title}*: ${k.content}`).join('\n\n');
    }
  } catch (e) { console.warn('[INFO_INTERCEPTOR] KB fetch error:', e.message); }

  const alsoWantsToSchedule = /\b(marcar|agendar|consulta|horário|vaga)\b/i.test(envelope.message_text) ||
    interceptarIntencaoDireta(envelope.message_text) === 'schedule_new';

  if (kbAnswer) {
    let finalKbMsg = kbAnswer;
    if (alsoWantsToSchedule)   finalKbMsg += '\n\n---\nGostaria de agendar uma consulta? 😊';
    else if (isInActiveBooking) finalKbMsg += '\n\n---\nPosso continuar seu agendamento quando quiser 😊';

    await saveConversationTurn({
      clinicId: envelope.clinic_id, fromNumber: envelope.from,
      correlationId: envelope.correlation_id, userText: envelope.message_text,
      assistantText: finalKbMsg, intentGroup: 'other', intent: 'info_kb_answered', slots: null,
    });
    clearTimeout(timeoutId);
    return res.json({
      correlation_id: envelope.correlation_id,
      final_message: finalKbMsg,
      actions: alsoWantsToSchedule || isInActiveBooking ? [{
        type: 'send_interactive_buttons',
        payload: { buttons: [
          { id: 'schedule_new', title: '📅 Agendar consulta' },
          { id: 'ask_question', title: '❓ Outra dúvida' },
        ]},
      }] : [],
      debug: DEBUG ? { source: 'info_interceptor_kb' } : undefined,
    });
  }

  // ── STEP 5: Nenhuma fonte encontrou resposta ─────────────────────────────
  if (isInActiveBooking) {
    const noSrcMsg = bookingStateNow === BOOKING_STATES.BOOKED
      ? `Para informações sobre valores e formas de pagamento, recomendo confirmar diretamente com a clínica. 📞`
      : `Sobre sua dúvida: não encontrei essa informação no sistema. Recomendo confirmar diretamente com a clínica. 📞\n\nPosso continuar com seu agendamento?`;
    await saveConversationTurn({
      clinicId: envelope.clinic_id, fromNumber: envelope.from,
      correlationId: envelope.correlation_id, userText: envelope.message_text,
      assistantText: noSrcMsg, intentGroup: 'other', intent: 'info_no_source', slots: null,
    });
    clearTimeout(timeoutId);
    return res.json({
      correlation_id: envelope.correlation_id,
      final_message: noSrcMsg,
      actions: bookingStateNow !== BOOKING_STATES.BOOKED ? [{
        type: 'send_interactive_buttons',
        payload: { buttons: [
          { id: 'continue_booking', title: '📅 Continuar agendamento' },
          { id: 'ask_question',     title: '❓ Outra dúvida' },
        ]},
      }] : [],
      debug: DEBUG ? { source: 'info_interceptor_no_source' } : undefined,
    });
  }
  // Se não há booking ativo e não encontrou resposta → deixa cair para o LLM
  console.log(`[INFO_INTERCEPTOR] Sem resposta determinística, passando ao LLM.`);
}

// ======================================================
// BOOKED STATE INTERCEPTOR
// Quando o paciente já agendou e pergunta sobre a consulta,
// responder com os dados do estado sem chamar o LLM.
// Isso evita que o bot "esqueça" o agendamento recém-feito.
// ======================================================
if (conversationState?.booking_state === BOOKING_STATES.BOOKED && conversationState?.doctor_name) {
  const bookedQuery = envelope.message_text.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, '').trim();
  const isAskingAboutAppointment = /\b(consulta|agenda|agendei|agendamento|horario|medico|quando|qual|data|marcado|confirmado|lembrar)\b/.test(bookedQuery);

  if (isAskingAboutAppointment) {
    const cs = conversationState;
    const bookedMsg = `Seu agendamento está confirmado! ✅\n\n👤 Paciente: ${cs.patient_name || 'Você'}\n👨‍⚕️ Médico: ${cs.doctor_name}\n📅 Data: ${cs.preferred_date_iso || cs.preferred_date || '—'}\n🕐 Horário: ${cs.preferred_time || '—'}\n\nSe precisar de algo mais, é só chamar! 😊`;
    await saveConversationTurn({
      clinicId: envelope.clinic_id, fromNumber: envelope.from,
      correlationId: envelope.correlation_id, userText: envelope.message_text,
      assistantText: bookedMsg, intentGroup: 'scheduling', intent: 'view_booked_appointment', slots: null,
    });
    clearTimeout(timeoutId);
    return res.json({
      correlation_id: envelope.correlation_id,
      final_message: bookedMsg,
      actions: [{
        type: 'send_interactive_buttons',
        payload: {
          buttons: [
            { id: 'schedule_new', title: '📅 Novo agendamento' },
            { id: 'ask_question', title: '❓ Outra dúvida' },
          ],
        },
      }],
      debug: DEBUG ? { source: 'booked_interceptor' } : undefined,
    });
  }
}

// ======================================================
// TAREFA 2 — FIX 1: Interceptor de intenções curtas
// Executa ANTES do LLM — zero latência para respostas simples
// ======================================================
const intentoDireto = interceptarIntencaoDireta(envelope.message_text);

if (intentoDireto) {
  console.log(`[FIX1] Intentão direta detectada: '${envelope.message_text}' → '${intentoDireto}' (sem LLM)`);

  // FIX v5.2: Tratar view_appointments por texto deterministicamente
  if (intentoDireto === 'view_appointments') {
    try {
      const appointments = await executeSchedulingTool(
        'listar_meus_agendamentos',
        { patient_phone: envelope.from },
        { clinicId: envelope.clinic_id, userPhone: envelope.from }
      );
      let viewMsg;
      if (appointments?.success && appointments?.appointments?.length > 0) {
        const list = appointments.appointments.map(a => 
          `📅 ${a.date || a.appointment_date} às ${a.time || a.start_time} — ${a.doctor_name || 'Médico'} (${a.status || 'agendado'})`
        ).join('\n');
        viewMsg = `Seus agendamentos:\n\n${list}\n\nDeseja remarcar, cancelar ou agendar uma nova consulta?`;
      } else {
        viewMsg = 'Você ainda não tem agendamentos. Gostaria de agendar uma consulta? 😊';
      }
      await saveConversationTurn({
        clinicId: envelope.clinic_id,
        fromNumber: envelope.from,
        correlationId: envelope.correlation_id,
        userText: envelope.message_text,
        assistantText: viewMsg,
        intentGroup: 'scheduling',
        intent: 'view_appointments',
        slots: null,
      });
      clearTimeout(timeoutId);
      return res.json({
        correlation_id: envelope.correlation_id,
        final_message: viewMsg,
        actions: [],
      });
    } catch (viewErr) {
      console.error('[VIEW_APPOINTMENTS-TEXT] Erro:', viewErr);
    }
  }

  // FIX v5.2: Tratar reschedule deterministicamente — listar agendamentos primeiro
  if (intentoDireto === 'reschedule') {
    try {
      const appointments = await executeSchedulingTool(
        'listar_meus_agendamentos',
        { patient_phone: envelope.from },
        { clinicId: envelope.clinic_id, userPhone: envelope.from }
      );
      let reschedMsg;
      if (appointments?.success && appointments?.appointments?.length > 0) {
        const upcoming = appointments.appointments.filter(a => 
          a.status === 'agendado' || a.status === 'scheduled' || a.status === 'confirmed'
        );
        if (upcoming.length > 0) {
          const list = upcoming.map((a, i) => 
            `${i + 1}. 📅 ${a.date || a.appointment_date} às ${a.time || a.start_time} — ${a.doctor_name || 'Médico'}`
          ).join('\n');
          reschedMsg = `Seus agendamentos atuais:\n\n${list}\n\nQual consulta você gostaria de reagendar?`;
        } else {
          reschedMsg = 'Você não tem agendamentos futuros para reagendar. Gostaria de agendar uma nova consulta? 😊';
        }
      } else {
        reschedMsg = 'Você não tem agendamentos para reagendar. Gostaria de agendar uma consulta? 😊';
      }
      await saveConversationTurn({
        clinicId: envelope.clinic_id,
        fromNumber: envelope.from,
        correlationId: envelope.correlation_id,
        userText: envelope.message_text,
        assistantText: reschedMsg,
        intentGroup: 'scheduling',
        intent: 'reschedule',
        slots: null,
      });
      clearTimeout(timeoutId);
      return res.json({
        correlation_id: envelope.correlation_id,
        final_message: reschedMsg,
        actions: [],
      });
    } catch (reschedErr) {
      console.error('[RESCHEDULE-TEXT] Erro:', reschedErr);
    }
  }

  // Handler de saudações simples — resposta imediata sem LLM
  if (intentoDireto === 'greeting') {
    const greetHour = Number(new Date().toLocaleString('pt-BR', { hour: 'numeric', hour12: false, timeZone: clinicRules?.timezone || 'America/Cuiaba' }));
    const greetSd = greetHour < 12 ? 'Bom dia' : greetHour < 18 ? 'Boa tarde' : 'Boa noite';
    const isInBooking = conversationState?.booking_state &&
      ![BOOKING_STATES.IDLE, BOOKING_STATES.BOOKED].includes(conversationState.booking_state);
    let greetReply;
    if (isInBooking && conversationState?.doctor_name) {
      greetReply = `${greetSd}! 😊 Estávamos no agendamento com *${conversationState.doctor_name}*. Quer continuar ou prefere pausar?`;
    } else {
      greetReply = `${greetSd}! Sou a Lara 😊 Como posso te ajudar hoje?`;
    }
    await saveConversationTurn({
      clinicId: envelope.clinic_id, fromNumber: envelope.from,
      correlationId: envelope.correlation_id, userText: envelope.message_text,
      assistantText: greetReply, intentGroup: 'other', intent: 'greeting', slots: null,
    });
    clearTimeout(timeoutId);
    return res.json({
      correlation_id: envelope.correlation_id,
      final_message: greetReply,
      actions: isInBooking ? [{
        type: 'send_interactive_buttons',
        payload: { buttons: [
          { id: 'continue_booking', title: '▶️ Continuar agendamento' },
          { id: 'schedule_new',     title: '🔄 Começar do zero' },
        ]},
      }] : [{
        type: 'send_interactive_buttons',
        payload: { buttons: [
          { id: 'schedule_new',      title: '📅 Agendar consulta' },
          { id: 'view_appointments', title: '📋 Meus agendamentos' },
          { id: 'ask_question',      title: '❓ Tirar uma dúvida' },
        ]},
      }],
    });
  }

  // FIX v5.3: Handler "esta semana" / "próxima semana" por texto
  if (intentoDireto === 'week_current' || intentoDireto === 'week_next') {
    const isCurrentWeek = intentoDireto === 'week_current';
    const allDates = conversationState?.last_suggested_dates || [];
    const doctorDisplayName = conversationState?.doctor_name || 'Médico';

    const now = new Date();
    const currentDay = now.getDay();
    let weekStart, weekEnd;
    if (isCurrentWeek) {
      weekStart = new Date(now);
      weekEnd = new Date(now);
      weekEnd.setDate(now.getDate() + (6 - currentDay));
    } else {
      weekStart = new Date(now);
      weekStart.setDate(now.getDate() + (7 - currentDay + 1));
      weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 5);
    }
    const weekStartStr = weekStart.toISOString().split('T')[0];
    const weekEndStr = weekEnd.toISOString().split('T')[0];

    const weekDates = allDates.filter(d => {
      const dateStr = d.date_iso || d.date;
      return dateStr >= weekStartStr && dateStr <= weekEndStr;
    });

    const todayStr = now.toISOString().split('T')[0];
    const currentTotalMin = now.getHours() * 60 + now.getMinutes();

    let weekMsg;
    if (weekDates.length > 0) {
      const label = isCurrentWeek ? 'Esta semana' : 'Próxima semana';
      weekMsg = `📅 *${doctorDisplayName}* — ${label}:\n\n`;
      weekDates.forEach(d => {
        let slots = d.slots || [];
        if ((d.date_iso || d.date) === todayStr) {
          slots = slots.filter(s => {
            const [h, m] = s.split(':').map(Number);
            return (h * 60 + m) > currentTotalMin;
          });
        }
        if (slots.length > 0) {
          const slotsFormatted = slots.slice(0, 6).join(' · ');
          weekMsg += `📅 *${d.day_of_week}, ${d.formatted_date}*\n   ${slotsFormatted}\n\n`;
        }
      });
      weekMsg += `Qual dia e horário você prefere?`;
    } else {
      const otherLabel = isCurrentWeek ? 'próxima semana' : 'esta semana';
      weekMsg = `Não há horários disponíveis ${isCurrentWeek ? 'nesta' : 'na próxima'} semana. Gostaria de verificar ${otherLabel}?`;
    }

    await saveConversationTurn({
      clinicId: envelope.clinic_id,
      fromNumber: envelope.from,
      correlationId: envelope.correlation_id,
      userText: envelope.message_text,
      assistantText: weekMsg,
      intentGroup: 'scheduling',
      intent: intentoDireto,
      slots: null,
    });
    clearTimeout(timeoutId);
    return res.json({
      correlation_id: envelope.correlation_id,
      final_message: weekMsg,
      actions: [],
    });
  }

  extracted = {
    intent_group: intentoDireto === 'cancel' ? 'scheduling' : (intentoDireto === 'info' ? 'other' : 'scheduling'),
    intent: intentoDireto,
    slots: {},
    missing_fields: [],
    confidence: 1.0,
    source: 'direct_map',
  };
  step++;
} else {
  // ── INTERCEPTOR NUMÉRICO: "4", "4)", "4) Quinta-feira, ..." → 4ª opção da lista ──
  // CORREÇÃO PROBLEMA-4: Tratar também o caso onde idx >= sugDates.length com aviso claro
  // Captura: dígito puro OU dígito seguido de ) . ou espaço (usuário copiou a opção inteira)
  // O índice vem SEMPRE do número, nunca do texto da opção — determinístico.
  const numericMsg = envelope.message_text.trim().match(/^([1-9])[).\s]|^([1-9])$/);
  if (numericMsg) {
    const numericDigit = numericMsg[1] || numericMsg[2]; // grupo 1 = "4)[...]", grupo 2 = "4" puro
    const idx = parseInt(numericDigit) - 1;
    const sugDates = conversationState?.last_suggested_dates || [];
    const sugSlots = conversationState?.last_suggested_slots || [];

    // Prioridade: quando em AWAITING_SLOTS e há horários disponíveis, interpretar como
    // seleção de HORÁRIO, não de data (mesmo que sugDates ainda esteja populado do turno anterior)
    const isAwaitingSlots = conversationState?.booking_state === BOOKING_STATES.AWAITING_SLOTS;
    const shouldPickSlot = isAwaitingSlots && sugSlots.length > 0 && idx < sugSlots.length;

    if (!shouldPickSlot && sugDates.length > 0 && idx < sugDates.length) {
      // Usuário escolheu uma DATA da lista
      const chosen = sugDates[idx];
      const chosenDateISO = chosen.date_iso || chosen.date || null;
      const cachedSlots = chosen.slots || []; // Horários já conhecidos do buscar_proximas_datas

      if (chosenDateISO) {
        console.log(`[NUMERIC_INTERCEPT] "${numericDigit}" → data ${chosenDateISO}, slots cacheados: ${cachedSlots.length}`);

        if (cachedSlots.length > 0) {
          // Slots já disponíveis — pular verificar_disponibilidade e mostrar direto
          await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
            preferred_date: chosenDateISO,
            preferred_date_iso: chosenDateISO,
            booking_state: BOOKING_STATES.AWAITING_SLOTS,
            last_suggested_slots: cachedSlots,
          });
          const dateFormatted = formatDateBR(chosenDateISO);
          const doctorDisplay = conversationState.doctor_name || 'Médico selecionado';
          const displayMsg = `🕐 *${doctorDisplay}*\n📅 ${dateFormatted}\n\nHorários disponíveis:\n${cachedSlots.join(' · ')}\n\nQual horário você prefere?`;
          await saveConversationTurn({
            clinicId: envelope.clinic_id,
            fromNumber: envelope.from,
            correlationId: envelope.correlation_id,
            userText: envelope.message_text,
            assistantText: displayMsg,
            intentGroup: 'scheduling',
            intent: 'show_time_slots_cached',
            slots: null,
          });
          clearTimeout(timeoutId);
          return res.json({
            correlation_id: envelope.correlation_id,
            final_message: displayMsg,
            actions: [buildTimeListAction(cachedSlots, doctorDisplay, dateFormatted)],
            debug: DEBUG ? { source: 'numeric_intercept_cached_slots', date: chosenDateISO, slots_count: cachedSlots.length } : undefined,
          });
        }

        // Sem slots cacheados — chamar verificar_disponibilidade inline para garantir
        // que o usuário sempre veja os horários (evita "Não encontrei horários" por falha de cache)
        const doctorIdForCheck = conversationState.doctor_id || null;
        if (doctorIdForCheck) {
          console.log(`[NUMERIC_INTERCEPT] Sem cache — chamando verificar_disponibilidade inline para ${chosenDateISO}`);
          const inlineResult = await executeSchedulingTool(
            'verificar_disponibilidade',
            { doctor_id: doctorIdForCheck, data: chosenDateISO },
            { clinicId: envelope.clinic_id, userPhone: envelope.from }
          );
          const inlineSlots = inlineResult?.available_slots || inlineResult?.slots || [];
          if (inlineResult?.success && Array.isArray(inlineSlots) && inlineSlots.length > 0) {
            // Encontrou slots — salvar e retornar direto (mesmo caminho do cache hit)
            await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
              preferred_date: chosenDateISO,
              preferred_date_iso: chosenDateISO,
              booking_state: BOOKING_STATES.AWAITING_SLOTS,
              last_suggested_slots: inlineSlots.map(s => ({ date: chosenDateISO, time: s })),
            });
            const dateFormatted = formatDateBR(chosenDateISO);
            const doctorDisplay = conversationState.doctor_name || 'Médico selecionado';
            const displayMsg = `🕐 *${doctorDisplay}*\n📅 ${dateFormatted}\n\nHorários disponíveis:\n${inlineSlots.join(' · ')}\n\nQual horário você prefere?`;
            await saveConversationTurn({
              clinicId: envelope.clinic_id,
              fromNumber: envelope.from,
              correlationId: envelope.correlation_id,
              userText: envelope.message_text,
              assistantText: displayMsg,
              intentGroup: 'scheduling',
              intent: 'show_time_slots_inline',
              slots: null,
            });
            clearTimeout(timeoutId);
            return res.json({
              correlation_id: envelope.correlation_id,
              final_message: displayMsg,
              actions: [buildTimeListAction(inlineSlots, doctorDisplay, dateFormatted)],
              debug: DEBUG ? { source: 'numeric_intercept_inline_verify', date: chosenDateISO, slots_count: inlineSlots.length } : undefined,
            });
          }
          // Sem slots nessa data → tentar buscar próximas datas disponíveis
          console.log(`[NUMERIC_INTERCEPT] Inline sem slots — buscando próximas datas para ${doctorIdForCheck}`);
          const inlineFallback = await executeSchedulingTool(
            'buscar_proximas_datas',
            { doctor_id: doctorIdForCheck, dias: BUSCA_SLOTS_ABERTA_DIAS, busca_aberta: true },
            { clinicId: envelope.clinic_id, userPhone: envelope.from }
          );
          if (inlineFallback?.success && inlineFallback?.dates?.length > 0) {
            await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
              last_suggested_dates: normalizeDatesForState(inlineFallback.dates),
              last_suggested_slots: normalizeDatesForState(inlineFallback.dates).flatMap(d => (d.slots || []).map(s => ({ date: d.date_iso, time: s }))),
              booking_state: BOOKING_STATES.COLLECTING_DATE,
              preferred_date: null,
              preferred_date_iso: null,
              ...(conversationState.doctor_id ? { doctor_id: conversationState.doctor_id } : {}),
              ...(conversationState.doctor_name ? { doctor_name: conversationState.doctor_name } : {}),
            });
            const dateList = inlineFallback.dates.slice(0, 5).map((d, i) => {
              const sp = (d.slots || []).slice(0, 4).join(' · ');
              return `${i + 1}) ${d.day_of_week}, ${d.formatted_date}${sp ? ` — ${sp}` : ''}`;
            }).join('\n');
            const fallbackMsg = `Essa data não tem horários disponíveis. As próximas datas com vagas são:\n\n${dateList}\n\nQual dessas datas funciona melhor?`;
            await saveConversationTurn({
              clinicId: envelope.clinic_id,
              fromNumber: envelope.from,
              correlationId: envelope.correlation_id,
              userText: envelope.message_text,
              assistantText: fallbackMsg,
              intentGroup: 'scheduling',
              intent: 'numeric_intercept_no_slots_fallback',
              slots: null,
            });
            clearTimeout(timeoutId);
            return res.json({
              correlation_id: envelope.correlation_id,
              final_message: fallbackMsg,
              actions: [buildDateListAction(inlineFallback.dates, conversationState.doctor_name)],
              debug: DEBUG ? { source: 'numeric_intercept_inline_fallback', date: chosenDateISO } : undefined,
            });
          }
        }

        // Sem doctor_id ou sem datas disponíveis — retornar erro imediato e limpar preferred_date
        // para evitar que REGRA 1 re-dispare verificar_disponibilidade em loop nas próximas mensagens
        await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
          preferred_date: null,
          preferred_date_iso: null,
          booking_state: BOOKING_STATES.COLLECTING_DATE,
          last_suggested_slots: [],
        });
        const errorMsg = `Essa data não tem horários disponíveis. Por favor, escolha outra data ou entre em contato com a clínica.`;
        await saveConversationTurn({
          clinicId: envelope.clinic_id,
          fromNumber: envelope.from,
          correlationId: envelope.correlation_id,
          userText: envelope.message_text,
          assistantText: errorMsg,
          intentGroup: 'scheduling',
          intent: 'no_slots_no_fallback',
          slots: null,
        });
        clearTimeout(timeoutId);
        return res.json({
          correlation_id: envelope.correlation_id,
          final_message: errorMsg,
          actions: [],
          debug: DEBUG ? { source: 'numeric_intercept_no_slots_no_fallback', date: chosenDateISO } : undefined,
        });
        // NOTA: código abaixo é inalcançável quando acima retorna — mantido para não quebrar lint
        extracted = {
          intent_group: 'scheduling',
          intent: 'schedule_new',
          slots: { preferred_date_text: chosenDateISO, preferred_date_iso: chosenDateISO },
          missing_fields: [],
          confidence: 1.0,
          source: 'numeric_intercept',
        };
        step++;
      }
    } else if (shouldPickSlot || (sugSlots.length > 0 && idx < sugSlots.length)) {
      // Usuário escolheu um HORÁRIO da lista
      const chosenSlot = typeof sugSlots[idx] === 'string' ? sugSlots[idx] : sugSlots[idx]?.time;
      if (chosenSlot) {
        console.log(`[NUMERIC_INTERCEPT] "${numericDigit}" → horário ${chosenSlot}`);
        await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
          preferred_time: chosenSlot,
        });
        extracted = {
          intent_group: 'scheduling',
          intent: 'schedule_new',
          slots: { preferred_time: chosenSlot },
          missing_fields: [],
          confidence: 1.0,
          source: 'numeric_intercept_slot',
        };
        step++;
      }
    } else if (numericMsg && idx >= 0 && (sugDates.length > 0 || sugSlots.length > 0)) {
      // CORREÇÃO PROBLEMA-4: Usuário digitou um número válido mas fora do range da lista apresentada
      // Ex: lista tem 3 datas mas usuário digitou "5"
      const listaDisponivel = sugSlots.length > 0 ? sugSlots : sugDates;
      const totalOpcoes = listaDisponivel.length;
      console.log(`[NUMERIC_INTERCEPT] Índice "${numericDigit}" fora do range (lista tem ${totalOpcoes} itens)`);
      const rangeMsg = `A opção ${numericDigit} não está disponível. Temos ${totalOpcoes} opção${totalOpcoes !== 1 ? 'ões' : ''} — por favor, escolha um número entre 1 e ${totalOpcoes}.`;
      await saveConversationTurn({
        clinicId: envelope.clinic_id, fromNumber: envelope.from,
        correlationId: envelope.correlation_id, userText: envelope.message_text,
        assistantText: rangeMsg, intentGroup: 'scheduling', intent: 'numeric_out_of_range', slots: null,
      });
      clearTimeout(timeoutId);
      return res.json({ correlation_id: envelope.correlation_id, final_message: rangeMsg, actions: [] });
    }
  }

  if (!extracted) {
  const extraction = await openai.chat.completions.create(
    {
      model: OPENAI_MODEL,
      messages: messages,
      tools: [tools[0]],
      tool_choice: { type: 'function', function: { name: 'extract_intent' } },
      temperature: 0.3,
    },
    { signal: controller.signal }
  );

  // Acumular usage da chamada extract_intent
  if (extraction.usage) {
    totalTokensInput += extraction.usage.prompt_tokens || 0;
    totalTokensOutput += extraction.usage.completion_tokens || 0;
  }

  // Parse resultado da extração (JG-P0-002)
  const callExtract = extraction.choices[0]?.message?.tool_calls?.[0];
  extracted = callExtract?.function?.arguments
    ? safeJsonParse(callExtract.function.arguments)
    : null;

  // FIX v5.4: Se detectInfoQuestion() identifica pergunta informativa E o paciente
  // NÃO está num fluxo de agendamento ativo → forçar intent_group = 'other'
  // Isso impede que o scheduling agent rode e deixa o LLM responder naturalmente
  const bookingState = conversationState?.booking_state || BOOKING_STATES.IDLE;
  const isInfoQuery = detectInfoQuestion(envelope.message_text);
  if (isInfoQuery && bookingState === BOOKING_STATES.IDLE && extracted) {
    console.log(`[INFO_DETECT] Pergunta informativa detectada: "${envelope.message_text}" — forçando intent_group='other'`);
    extracted.intent_group = 'other';
    extracted.intent = extracted.intent || 'info_query';
  }

  step++;
  } // fecha if (!extracted) do bloco LLM
}

if (DEBUG) {
  log.debug({ extracted }, 'extraction_result');
}

// ========== MERGEAR SLOTS NO ESTADO PERSISTENTE ==========
const updatedState = await mergeExtractedSlots(
  activeConvState,
  extracted?.slots || {},
  doctors,
  services,
  supabase,            // cliente Supabase disponível no escopo da rota
  envelope.clinic_id,
  clinicRules?.timezone || 'America/Cuiaba'
);

// Salvar estado atualizado (sem sobrescrever last_question_asked ainda)
await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
  ...updatedState,
  intent: extracted?.intent || conversationState.intent,
});

// Se doctor_id foi resolvido agora e booking_state ainda é IDLE → avançar para COLLECTING_DATE
if (updatedState.doctor_id && !activeConvState.doctor_id &&
    (!updatedState.booking_state || updatedState.booking_state === BOOKING_STATES.IDLE || updatedState.booking_state === BOOKING_STATES.COLLECTING_SPECIALTY)) {
  console.log(`[STATE] doctor_id preenchido - mantendo COLLECTING_SPECIALTY para interceptor`);
  if (updatedState.booking_state !== BOOKING_STATES.COLLECTING_SPECIALTY) {
    await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
      booking_state: BOOKING_STATES.COLLECTING_SPECIALTY,
    });
    updatedState.booking_state = BOOKING_STATES.COLLECTING_SPECIALTY;
  }
  logDecision('state_transition', {
    from: BOOKING_STATES.IDLE,
    to: BOOKING_STATES.COLLECTING_SPECIALTY,
    trigger: 'doctor_id_resolved',
    doctor_id: updatedState.doctor_id,
    doctor_name: updatedState.doctor_name,
  }, envelope.clinic_id, envelope.from);
}

console.log('📊 Estado após merge:', JSON.stringify(updatedState, null, 2));

    // ======================================================
    // 7) CONFIDENCE GUARD + TAREFA 2 FIX 3: PRESERVAÇÃO DE ESTADO
    // Não resetar estado quando mensagem é inesperada mas há fluxo ativo.
    // ======================================================
    // FIX: Pré-computar hasActiveFlow e isCancelIntent antes do guard
    // para também capturar mensagens off-topic com alta confiança (ex: "oi tudo bem")
    const activeBookingStates = [
      BOOKING_STATES.COLLECTING_SPECIALTY,
      BOOKING_STATES.COLLECTING_DATE,
      BOOKING_STATES.AWAITING_SLOTS,
      BOOKING_STATES.COLLECTING_TIME,
      BOOKING_STATES.CONFIRMING,
      BOOKING_STATES.COLLECTING_DOCTOR,
    ];
    const hasActiveFlow = activeBookingStates.includes(conversationState.booking_state)
      || !!conversationState.doctor_id
      || !!conversationState.specialty;
    const isCancelIntent = /cancelar|desistir|não quero|nao quero|para|chega/i.test(envelope.message_text);

    // Disparar guard se: (a) sem extração / confiança baixa OU
    // (b) fluxo ativo + mensagem off-topic (cumprimentos, chit-chat) — evita que
    //     o LLM gere um cumprimento e destrua o contexto de agendamento
    if (!extracted || extracted.confidence < 0.6 ||
        (hasActiveFlow && !isCancelIntent && extracted?.intent_group === 'other')) {

      if (hasActiveFlow && !isCancelIntent) {
        // FIX 3: Preservar estado — incrementar stuck_counter_off_topic
        const currentStuckOffTopic = (conversationState.stuck_counter_off_topic || 0) + 1;
        await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
          stuck_counter_off_topic: currentStuckOffTopic,
        });
        console.log(`[FIX3] Mensagem fora do fluxo. Estado preservado. stuck_counter_off_topic=${currentStuckOffTopic}`);

        if (currentStuckOffTopic >= STUCK_LIMIT) {
          // Fallback definitivo após STUCK_LIMIT mensagens fora do fluxo
          await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
            booking_state: BOOKING_STATES.IDLE,
            stuck_counter_off_topic: 0,
            doctor_id: null,
            specialty: null,
            preferred_date: null,
            preferred_time: null,
          });
          const stuckLimitMsg = 'Parece que você saiu do fluxo de agendamento. Quando quiser, é só me dizer: você quer marcar, remarcar, cancelar ou tirar uma dúvida?';
          // CORREÇÃO 2: Salvar histórico antes de retornar
          await saveConversationTurn({
            clinicId: envelope.clinic_id,
            fromNumber: envelope.from,
            correlationId: envelope.correlation_id,
            userText: envelope.message_text,
            assistantText: stuckLimitMsg,
            intentGroup: 'other',
            intent: 'stuck_limit',
            slots: null,
          });
          clearTimeout(timeoutId);
          return res.json({
            correlation_id: envelope.correlation_id,
            final_message: stuckLimitMsg,
            actions: [],
            debug: DEBUG ? { fix3: 'stuck_limit_reached', stuck_counter_off_topic: currentStuckOffTopic } : undefined,
          });
        }

        // Retornar mensagem de contexto mantendo o estado
        const specialtyDisplay = conversationState.specialty || conversationState.doctor_name;
        const contextMsg = specialtyDisplay
          ? `Ainda estou buscando horários para ${specialtyDisplay}. Um momento por favor... Se quiser continuar o agendamento, é só me dizer a data de preferência.`
          : `Ainda estou aqui para te ajudar! Você quer marcar, remarcar, cancelar ou tirar uma dúvida?`;

        // CORREÇÃO 2: Salvar histórico antes de retornar
        await saveConversationTurn({
          clinicId: envelope.clinic_id,
          fromNumber: envelope.from,
          correlationId: envelope.correlation_id,
          userText: envelope.message_text,
          assistantText: contextMsg,
          intentGroup: 'other',
          intent: 'state_preserved',
          slots: null,
        });
        clearTimeout(timeoutId);
        return res.json({
          correlation_id: envelope.correlation_id,
          final_message: contextMsg,
          actions: [],
          debug: DEBUG ? { fix3: 'state_preserved', booking_state: conversationState.booking_state, specialty: conversationState.specialty } : undefined,
        });
      }

      // Sem fluxo ativo — comportamento original
      const noFlowMsg = 'Só para confirmar: você quer marcar, remarcar, cancelar ou tirar uma dúvida?';
      // CORREÇÃO 2: Salvar histórico antes de retornar
      await saveConversationTurn({
        clinicId: envelope.clinic_id,
        fromNumber: envelope.from,
        correlationId: envelope.correlation_id,
        userText: envelope.message_text,
        assistantText: noFlowMsg,
        intentGroup: 'other',
        intent: 'no_flow',
        slots: null,
      });
      clearTimeout(timeoutId);
      return res.json({
        correlation_id: envelope.correlation_id,
        final_message: noFlowMsg,
        actions: [],
        debug: DEBUG ? { extracted } : undefined,
      });
    }

    // ======================================================
    // 7b) CHECK DE ESTADO CONFIRMING (ANTES do LLM)
    // Quando todos os campos estão preenchidos → pedir confirmação.
    // Quando usuário responde SIM/NÃO → executar ação.
    // ======================================================
    const allFieldsReady = (state) => calculatePendingFields(state).length === 0;
    const userSaidConfirmation = envelope.message_text.toLowerCase().trim();

    if (updatedState.booking_state === BOOKING_STATES.CONFIRMING) {
      logDecision('confirmation', {
        user_said: userSaidConfirmation,
        booking_state: BOOKING_STATES.CONFIRMING,
      }, envelope.clinic_id, envelope.from);

      // CAMADA 1: Botão de confirmação tem prioridade sobre regex
      if (envelope.intent_override === 'confirm_yes') {
        // Ir direto para BOOKED
        const newState = await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
          booking_state: BOOKING_STATES.BOOKED,
        });
        Object.assign(updatedState, newState);
        logDecision('state_transition', {
          from: BOOKING_STATES.CONFIRMING,
          to: BOOKING_STATES.BOOKED,
          trigger: 'button_confirm_yes',
        }, envelope.clinic_id, envelope.from);
        // FIX v5.1: Chamar criar_agendamento DETERMINISTICAMENTE (sem depender do LLM)
        // VALIDAÇÃO PRÉ-CONFIRMAÇÃO: garantir que nenhum campo crítico está corrompido
        const _ISO_RE_CONFIRM = /^\d{4}-\d{2}-\d{2}$/;
        const _dateToBook = updatedState.preferred_date_iso || updatedState.preferred_date;
        const _dateValid = _dateToBook && _ISO_RE_CONFIRM.test(_dateToBook);
        const _confirmPayload = {
          doctor_id: updatedState.doctor_id,
          doctor_name: updatedState.doctor_name,
          patient_name: updatedState.patient_name,
          patient_phone: envelope.from,
          data: _dateToBook,
          horario: updatedState.preferred_time,
          service_id: updatedState.service_id || null,
        };
        console.log('[CONFIRM] 🔍 PAYLOAD VALIDAÇÃO:', JSON.stringify(_confirmPayload));
        if (!updatedState.doctor_id || !_dateValid || !updatedState.preferred_time) {
          console.error('[CONFIRM] ❌ Payload inválido:', { doctor_id: updatedState.doctor_id, data: _dateToBook, horario: updatedState.preferred_time });
          const invalidMsg = 'Não foi possível confirmar: alguns dados do agendamento estão incompletos. Vamos recomeçar? Por favor, informe novamente a data e horário desejados.';
          await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
            booking_state: BOOKING_STATES.COLLECTING_DATE,
            preferred_date: null, preferred_date_iso: null, preferred_time: null,
          });
          await saveConversationTurn({ clinicId: envelope.clinic_id, fromNumber: envelope.from, correlationId: envelope.correlation_id, userText: envelope.message_text, assistantText: invalidMsg, intentGroup: 'scheduling', intent: 'confirm_invalid_payload', slots: null });
          clearTimeout(timeoutId);
          return res.json({ correlation_id: envelope.correlation_id, final_message: invalidMsg, actions: [] });
        }
        try {
          const agendResult = await executeSchedulingTool(
            'criar_agendamento',
            _confirmPayload,
            { clinicId: envelope.clinic_id, userPhone: envelope.from }
          );
          console.log('[CONFIRM] criar_agendamento result:', JSON.stringify(agendResult));
          const displayDate1 = updatedState.preferred_date_iso
            || updatedState.preferred_date
            || 'Data a confirmar';
          const successMsg = agendResult?.success
            ? `✅ Agendamento confirmado!\n\n👤 Paciente: ${updatedState.patient_name}\n👨‍⚕️ Médico: ${updatedState.doctor_name}\n📅 Data: ${displayDate1}\n🕐 Horário: ${updatedState.preferred_time}\n\nAté lá! Se precisar de algo, é só chamar. 😊`
            : `Não foi possível concluir o agendamento: ${agendResult?.message || 'erro desconhecido'}. Tente novamente ou fale com um atendente.`;
          // Salvar appointmentId no state para processPostConversation usar
          const confirmedAppointmentId = agendResult?.appointment?.id || null;
          await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
            appointment_confirmed: agendResult?.success || false,
            last_appointment_id: confirmedAppointmentId,
          });
          await saveConversationTurn({
            clinicId: envelope.clinic_id,
            fromNumber: envelope.from,
            correlationId: envelope.correlation_id,
            userText: envelope.message_text,
            assistantText: successMsg,
            intentGroup: 'scheduling',
            intent: 'confirm_yes',
            slots: null,
          });
          clearTimeout(timeoutId);
          return res.json({
            correlation_id: envelope.correlation_id,
            final_message: successMsg,
            actions: [],
            debug: DEBUG ? { agendResult } : undefined,
          });
        } catch (agendErr) {
          console.error('[CONFIRM] Erro ao criar agendamento:', agendErr);
          const errMsg = 'Houve um erro ao confirmar seu agendamento. Por favor, tente novamente ou fale com um atendente.';
          await saveConversationTurn({
            clinicId: envelope.clinic_id,
            fromNumber: envelope.from,
            correlationId: envelope.correlation_id,
            userText: envelope.message_text,
            assistantText: errMsg,
            intentGroup: 'scheduling',
            intent: 'confirm_yes_error',
            slots: null,
          });
          clearTimeout(timeoutId);
          return res.json({
            correlation_id: envelope.correlation_id,
            final_message: errMsg,
            actions: [],
          });
        }
      } else if (envelope.intent_override === 'confirm_no') {
        // Ir direto para IDLE + cancelar
        const newState = await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
          booking_state: BOOKING_STATES.IDLE,
          preferred_date: null,
          preferred_date_iso: null,
          preferred_time: null,
        });
        logDecision('state_transition', {
          from: BOOKING_STATES.CONFIRMING,
          to: BOOKING_STATES.IDLE,
          trigger: 'button_confirm_no',
        }, envelope.clinic_id, envelope.from);
        const cancelMsg1 = 'Tudo bem! O agendamento foi cancelado. O que você gostaria de fazer? 😊';
        // CORREÇÃO 2: Salvar histórico antes de retornar
        await saveConversationTurn({
          clinicId: envelope.clinic_id,
          fromNumber: envelope.from,
          correlationId: envelope.correlation_id,
          userText: envelope.message_text,
          assistantText: cancelMsg1,
          intentGroup: 'scheduling',
          intent: 'confirm_no',
          slots: null,
        });
        clearTimeout(timeoutId);
        return res.json({
          correlation_id: envelope.correlation_id,
          final_message: cancelMsg1,
          actions: [],
          debug: DEBUG ? { state: newState } : undefined,
        });
      } else if (/^sim|^s$|confirmar|^ok$|^yes/.test(userSaidConfirmation)) {
        // PENDENTE-GUARD: responder dúvida pendente ANTES de confirmar agendamento
        if (updatedState.pending_info_question) {
          const pendingQ = updatedState.pending_info_question;
          await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
            pending_info_question: null,
          });
          const pendingMsg = `Antes de confirmar, quero esclarecer sua dúvida: sobre "${pendingQ}" — para valores e condições de pagamento, recomendo confirmar com a clínica. 📞\n\nSe quiser prosseguir com o agendamento mesmo assim, basta responder *sim* novamente. 😊`;
          await saveConversationTurn({
            clinicId: envelope.clinic_id, fromNumber: envelope.from,
            correlationId: envelope.correlation_id, userText: envelope.message_text,
            assistantText: pendingMsg, intentGroup: 'scheduling', intent: 'pending_question_before_confirm', slots: null,
          });
          clearTimeout(timeoutId);
          return res.json({ correlation_id: envelope.correlation_id, final_message: pendingMsg, actions: [] });
        }

        // Usuário confirmou → avançar para BOOKED e criar agendamento
        const newState = await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
          booking_state: BOOKING_STATES.BOOKED,
        });
        Object.assign(updatedState, newState);
        logDecision('state_transition', {
          from: BOOKING_STATES.CONFIRMING,
          to: BOOKING_STATES.BOOKED,
          trigger: 'user_confirmed',
        }, envelope.clinic_id, envelope.from);
        // FIX v5.1: Chamar criar_agendamento DETERMINISTICAMENTE (sem depender do LLM)
        // VALIDAÇÃO PRÉ-CONFIRMAÇÃO (texto "sim")
        const _ISO_RE_TEXT = /^\d{4}-\d{2}-\d{2}$/;
        const _dateToBookText = updatedState.preferred_date_iso || updatedState.preferred_date;
        const _dateValidText = _dateToBookText && _ISO_RE_TEXT.test(_dateToBookText);
        const _confirmPayloadText = {
          doctor_id: updatedState.doctor_id,
          doctor_name: updatedState.doctor_name,
          patient_name: updatedState.patient_name,
          patient_phone: envelope.from,
          data: _dateToBookText,
          horario: updatedState.preferred_time,
          service_id: updatedState.service_id || null,
        };
        console.log('[CONFIRM-TEXT] 🔍 PAYLOAD VALIDAÇÃO:', JSON.stringify(_confirmPayloadText));
        if (!updatedState.doctor_id || !_dateValidText || !updatedState.preferred_time) {
          console.error('[CONFIRM-TEXT] ❌ Payload inválido:', { doctor_id: updatedState.doctor_id, data: _dateToBookText, horario: updatedState.preferred_time });
          const invalidMsg2 = 'Não foi possível confirmar: alguns dados estão incompletos. Vamos recomeçar? Informe novamente a data e horário desejados.';
          await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
            booking_state: BOOKING_STATES.COLLECTING_DATE,
            preferred_date: null, preferred_date_iso: null, preferred_time: null,
          });
          await saveConversationTurn({ clinicId: envelope.clinic_id, fromNumber: envelope.from, correlationId: envelope.correlation_id, userText: envelope.message_text, assistantText: invalidMsg2, intentGroup: 'scheduling', intent: 'confirm_invalid_payload', slots: null });
          clearTimeout(timeoutId);
          return res.json({ correlation_id: envelope.correlation_id, final_message: invalidMsg2, actions: [] });
        }
        try {
          const agendResult = await executeSchedulingTool(
            'criar_agendamento',
            _confirmPayloadText,
            { clinicId: envelope.clinic_id, userPhone: envelope.from }
          );
          console.log('[CONFIRM-TEXT] criar_agendamento result:', JSON.stringify(agendResult));
          const displayDate2 = updatedState.preferred_date_iso
            || updatedState.preferred_date
            || 'Data a confirmar';
          const successMsg = agendResult?.success
            ? `✅ Agendamento confirmado!\n\n👤 Paciente: ${updatedState.patient_name}\n👨‍⚕️ Médico: ${updatedState.doctor_name}\n📅 Data: ${displayDate2}\n🕐 Horário: ${updatedState.preferred_time}\n\nAté lá! Se precisar de algo, é só chamar. 😊`
            : `Não foi possível concluir o agendamento: ${agendResult?.message || 'erro desconhecido'}. Tente novamente ou fale com um atendente.`;
          const confirmedAppointmentIdText = agendResult?.appointment?.id || null;
          await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
            appointment_confirmed: agendResult?.success || false,
            last_appointment_id: confirmedAppointmentIdText,
          });
          await saveConversationTurn({
            clinicId: envelope.clinic_id,
            fromNumber: envelope.from,
            correlationId: envelope.correlation_id,
            userText: envelope.message_text,
            assistantText: successMsg,
            intentGroup: 'scheduling',
            intent: 'confirm_yes',
            slots: null,
          });
          clearTimeout(timeoutId);
          return res.json({
            correlation_id: envelope.correlation_id,
            final_message: successMsg,
            actions: [],
            debug: DEBUG ? { agendResult } : undefined,
          });
        } catch (agendErr) {
          console.error('[CONFIRM-TEXT] Erro ao criar agendamento:', agendErr);
          const errMsg = 'Houve um erro ao confirmar seu agendamento. Por favor, tente novamente ou fale com um atendente.';
          await saveConversationTurn({
            clinicId: envelope.clinic_id,
            fromNumber: envelope.from,
            correlationId: envelope.correlation_id,
            userText: envelope.message_text,
            assistantText: errMsg,
            intentGroup: 'scheduling',
            intent: 'confirm_yes_error',
            slots: null,
          });
          clearTimeout(timeoutId);
          return res.json({
            correlation_id: envelope.correlation_id,
            final_message: errMsg,
            actions: [],
          });
        }

      } else if (/^n[aã]o|^n$|cancelar|^no$/.test(userSaidConfirmation)) {
        // Usuário cancelou → resetar campos de data/hora
        const newState = await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
          booking_state: BOOKING_STATES.IDLE,
          preferred_date: null,
          preferred_date_iso: null,
          preferred_time: null,
        });
        logDecision('state_transition', {
          from: BOOKING_STATES.CONFIRMING,
          to: BOOKING_STATES.IDLE,
          trigger: 'user_cancelled',
        }, envelope.clinic_id, envelope.from);
        const cancelMsg2 = 'Tudo bem! O agendamento foi cancelado. O que você gostaria de fazer? 😊';
        // CORREÇÃO 2: Salvar histórico antes de retornar
        await saveConversationTurn({
          clinicId: envelope.clinic_id,
          fromNumber: envelope.from,
          correlationId: envelope.correlation_id,
          userText: envelope.message_text,
          assistantText: cancelMsg2,
          intentGroup: 'scheduling',
          intent: 'cancel',
          slots: null,
        });
        clearTimeout(timeoutId);
        return res.json({
          correlation_id: envelope.correlation_id,
          final_message: cancelMsg2,
          actions: [],
          debug: DEBUG ? { state: newState } : undefined,
        });

      } else {
        // Resposta ambígua → validar data antes de reenviar confirmação
        const ISO_RE_AMB = /^\d{4}-\d{2}-\d{2}$/;
        const ambDateRaw = updatedState.preferred_date_iso || updatedState.preferred_date;
        const ambDateValid = ambDateRaw && ISO_RE_AMB.test(ambDateRaw) &&
          new Date(ambDateRaw + 'T00:00:00') >= new Date(new Date().toISOString().split('T')[0] + 'T00:00:00');
        if (!ambDateValid) {
          console.warn(`[CONFIRMING] Data inválida/passada no estado CONFIRMING: "${ambDateRaw}" — resetando`);
          await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
            preferred_date: null, preferred_date_iso: null, preferred_time: null,
            booking_state: BOOKING_STATES.COLLECTING_DATE,
            last_suggested_dates: [], last_suggested_slots: [],
          });
          const resetMsg = `Parece que houve um problema com a data do agendamento. Vamos recomeçar — para quando você gostaria de agendar?`;
          clearTimeout(timeoutId);
          return res.json({ correlation_id: envelope.correlation_id, final_message: resetMsg, actions: [] });
        }
        const ambiguousConfirmMsg = await buildConfirmationMessage(updatedState, updatedState.doctor_name, clinicRules?.name, envelope.clinic_id);
        // CORREÇÃO 2: Salvar histórico antes de retornar
        await saveConversationTurn({
          clinicId: envelope.clinic_id,
          fromNumber: envelope.from,
          correlationId: envelope.correlation_id,
          userText: envelope.message_text,
          assistantText: ambiguousConfirmMsg,
          intentGroup: 'scheduling',
          intent: 'awaiting_confirmation',
          slots: null,
        });
        clearTimeout(timeoutId);
        return res.json({
          correlation_id: envelope.correlation_id,
          final_message: ambiguousConfirmMsg,
          actions: [],
          debug: DEBUG ? { booking_state: BOOKING_STATES.CONFIRMING } : undefined,
        });
      }
    } else if (
      allFieldsReady(updatedState) &&
      updatedState.booking_state !== BOOKING_STATES.BOOKED &&
      extracted?.intent_group === 'scheduling'
    ) {
      // Validar data antes de confirmar: deve ser ISO e não estar no passado
      const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
      const dateToConfirm = updatedState.preferred_date_iso || updatedState.preferred_date;
      const dateIsValid = dateToConfirm && ISO_RE.test(dateToConfirm) &&
        new Date(dateToConfirm + 'T00:00:00') >= new Date(new Date().toISOString().split('T')[0] + 'T00:00:00');
      if (!dateIsValid) {
        console.warn(`[CONFIRMING] Data inválida ou passada detectada: "${dateToConfirm}" — resetando para coletar nova data`);
        await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
          preferred_date: null,
          preferred_date_iso: null,
          booking_state: BOOKING_STATES.COLLECTING_DATE,
          last_suggested_dates: [],
          last_suggested_slots: [],
        });
        decided = {
          decision_type: 'ask_missing',
          message: `Para quando você gostaria de agendar com ${updatedState.doctor_name || 'o médico'}? Me diga a data de preferência.`,
          actions: [],
          confidence: 1,
        };
        // Pular para o final — não entrar em CONFIRMING com data inválida
      } else {
      // Todos os campos preenchidos → entrar em CONFIRMING (uma única chamada atômica)
      await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
        booking_state: BOOKING_STATES.CONFIRMING,
        conversation_stage: 'awaiting_confirmation',
      });
      logDecision('state_transition', {
        from: updatedState.booking_state,
        to: BOOKING_STATES.CONFIRMING,
        trigger: 'all_fields_ready',
      }, envelope.clinic_id, envelope.from);
      const confirmMsg = await buildConfirmationMessage(updatedState, updatedState.doctor_name, clinicRules?.name, envelope.clinic_id);
      // CORREÇÃO 2: Salvar histórico antes de retornar
      await saveConversationTurn({
        clinicId: envelope.clinic_id,
        fromNumber: envelope.from,
        correlationId: envelope.correlation_id,
        userText: envelope.message_text,
        assistantText: confirmMsg,
        intentGroup: 'scheduling',
        intent: 'awaiting_confirmation',
        slots: null,
      });
      clearTimeout(timeoutId);
      return res.json({
        correlation_id: envelope.correlation_id,
        final_message: confirmMsg,
        // CAMADA 2 — Cenário B: Botões de confirmação interativos
        actions: [{
          type: 'send_interactive_buttons',
          payload: {
            buttons: [
              { id: 'confirm_yes', title: '\u2705 Confirmar' },
              { id: 'confirm_no',  title: '\u274C Cancelar' },
            ],
          },
        }],
        debug: DEBUG ? { booking_state: BOOKING_STATES.CONFIRMING } : undefined,
      });
      } // fecha else (data válida)
    }

    // ======================================================
    // 7c-pre) TAREFA 2 FIX 4: BOOKING STAGES INTERCEPTOR
    // Usa BOOKING_STAGES para interceptar antes do LLM por stage.
    // ======================================================
    const currentBookingStage = updatedState.booking_state;

    // COLLECTING_SPECIALTY: doctor_id ainda nulo, intent de agendamento
    if (
      extracted?.intent_group === 'scheduling' &&
      !updatedState.doctor_id &&
      !updatedState.specialty &&
      currentBookingStage === BOOKING_STATES.IDLE
    ) {
      // Transicionar para COLLECTING_SPECIALTY (estado intermediário)
      await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
        booking_state: BOOKING_STATES.COLLECTING_SPECIALTY,
        // CORREÇÃO 5: Atualizar conversation_stage para 'scheduling'
        conversation_stage: 'scheduling',
      });
      updatedState.booking_state = BOOKING_STATES.COLLECTING_SPECIALTY;
      console.log('[FIX4] COLLECTING_SPECIALTY: doctor_id nulo, pedindo especialidade');
      const doctorList = doctors.map(d => `• ${d.name} — ${d.specialty}`).join('\n');
      const specialtyMsg = `Qual especialidade você gostaria de agendar?\n\nMédicos disponíveis:\n${doctorList}`;
      // CORREÇÃO 2: Salvar histórico antes de retornar
      await saveConversationTurn({
        clinicId: envelope.clinic_id,
        fromNumber: envelope.from,
        correlationId: envelope.correlation_id,
        userText: envelope.message_text,
        assistantText: specialtyMsg,
        intentGroup: 'scheduling',
        intent: 'schedule_new',
        slots: null,
      });
      clearTimeout(timeoutId);
      return res.json({
        correlation_id: envelope.correlation_id,
        final_message: specialtyMsg,
        actions: [],
        debug: DEBUG ? { fix4: 'collecting_specialty', booking_state: BOOKING_STATES.COLLECTING_DATE } : undefined,
      });
    }

    // AWAITING_CONFIRMATION: todos os campos prontos, aguardar confirmação explícita
    // (já tratado no bloco 7b acima — apenas garantir stage correto)
    if (
      updatedState.booking_state === BOOKING_STATES.CONFIRMING ||
      updatedState.booking_state === BOOKING_STATES.BOOKED
    ) {
      // Persistir stage AWAITING_CONFIRMATION para compatibilidade com BOOKING_STAGES
      if (updatedState.booking_state === BOOKING_STATES.CONFIRMING) {
        // Já tratado no bloco 7b — não fazer nada aqui
      }
    }

    // ======================================================
    // 7c) INTERCEPTORES DETERMINÍSTICOS
    // Substitui o detectAvailabilityQuestion anterior.
    // ======================================================
    const forcedCall = applyDeterministicInterceptors(updatedState, envelope.message_text);

    if (forcedCall && forcedCall.tool !== '__await_confirmation__') {
      logDecision('tool_forced', {
        tool: forcedCall.tool,
        reason: forcedCall.reason,
        booking_state: updatedState.booking_state,
      }, envelope.clinic_id, envelope.from);
      console.log(`[INTERCEPTOR] Forced tool: ${forcedCall.tool} — reason: ${forcedCall.reason}`);

      const toolResult = await executeSchedulingTool(
        forcedCall.tool,
        forcedCall.params,
        { clinicId: envelope.clinic_id, userPhone: envelope.from }
      );

      const validation = validateAvailabilityResult(toolResult, forcedCall.tool);
      logDecision('tool_validated', {
        tool: forcedCall.tool,
        valid: validation.valid,
        slots_returned: toolResult?.available_slots?.length || toolResult?.dates?.length || 0,
      }, envelope.clinic_id, envelope.from);

      if (!validation.valid && validation.noSlots) {
        // FIX 3: Sem slots → incrementar stuck_counter_slots e tentar busca aberta
        const currentStuckSlots = (updatedState.stuck_counter_slots || 0) + 1;
        await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
          stuck_counter_slots: currentStuckSlots,
        });
        updatedState.stuck_counter_slots = currentStuckSlots;
        console.log(`[FIX3] stuck_counter_slots = ${currentStuckSlots}`);

        if (currentStuckSlots >= STUCK_LIMIT) {
          // Fallback definitivo: resetar estado e encerrar com mensagem clara
          await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
            booking_state: BOOKING_STATES.IDLE,
            stuck_counter_slots: 0,
            preferred_date: null,
            preferred_date_iso: null,
          });
          decided = {
            decision_type: 'proceed',
            message: `Não encontrei vagas disponíveis para ${updatedState.specialty || updatedState.doctor_name || 'o médico solicitado'} nos próximos ${BUSCA_SLOTS_ABERTA_DIAS} dias.`,
            // CAMADA 2 — Cenário C: Botões de alternativa quando sem disponibilidade
            actions: [{
              type: 'send_interactive_buttons',
              payload: {
                buttons: [
                  { id: 'try_other_date',   title: '\uD83D\uDCC5 Tentar outra data' },
                  { id: 'try_other_doctor', title: '\uD83D\uDC68\u200D\u2695\uFE0F Outro médico' },
                  { id: 'ask_question',     title: '\u2753 Tirar uma dúvida' },
                ],
              },
            }],
            confidence: 1,
          };
          skipSchedulingAgent = true;
          step = MAX_STEPS;
        } else {
          // Primeira ou segunda tentativa: tentar busca aberta antes de desistir
          console.log('[INTERCEPTOR] No slots found — falling back to buscar_proximas_datas (busca_aberta)');
          const fallbackResult = await executeSchedulingTool(
            'buscar_proximas_datas',
            { doctor_id: updatedState.doctor_id, dias: BUSCA_SLOTS_ABERTA_DIAS, busca_aberta: true },
            { clinicId: envelope.clinic_id, userPhone: envelope.from }
          );
          if (fallbackResult?.success && fallbackResult?.dates?.length > 0) {
            // FIX 3: Resetar stuck_counter ao encontrar slots
            // FIX loop: limpar preferred_date para que o guard rail não re-dispare com data antiga
            // FIX: Também salvar doctor_id para que o interceptor numérico funcione corretamente
            await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
              last_suggested_dates: normalizeDatesForState(fallbackResult.dates),
              last_suggested_slots: normalizeDatesForState(fallbackResult.dates).flatMap(d => (d.slots || []).map(s => ({ date: d.date_iso, time: s }))),
              booking_state: BOOKING_STATES.COLLECTING_DATE,
              stuck_counter_slots: 0,
              preferred_date: null,
              preferred_date_iso: null,
              ...(updatedState.doctor_id ? { doctor_id: updatedState.doctor_id } : {}),
              ...(updatedState.doctor_name ? { doctor_name: updatedState.doctor_name } : {}),
            });
            const dateList = fallbackResult.dates.slice(0, BUSCA_SLOTS_ABERTA_MAX)
              .map((d, i) => {
                const slotsPreview = (d.slots || []).slice(0, 4).join(' · ');
                return `${i + 1}) ${d.day_of_week}, ${d.formatted_date}${slotsPreview ? ` — ${slotsPreview}` : ''}`;
              }).join('\n');
            decided = {
              decision_type: 'proceed',
              message: `Essa data não tem horários disponíveis. As próximas datas com vagas para ${updatedState.doctor_name} são:\n\n${dateList}\n\nQual dessas datas funciona melhor?`,
              actions: [buildDateListAction(fallbackResult.dates, updatedState.doctor_name)],
              confidence: 1,
            };
            skipSchedulingAgent = true;
            step = MAX_STEPS;
          } else {
            // Busca aberta também vazia: aguardar próximo turno (não prometer nada)
            decided = {
              decision_type: 'proceed',
              message: `Não encontrei horários disponíveis para ${updatedState.doctor_name} no momento.`,
              // CAMADA 2 — Cenário C: Botões de alternativa
              actions: [{
                type: 'send_interactive_buttons',
                payload: {
                  buttons: [
                    { id: 'try_other_date',   title: '\uD83D\uDCC5 Tentar outra data' },
                    { id: 'try_other_doctor', title: '\uD83D\uDC68\u200D\u2695\uFE0F Outro médico' },
                    { id: 'ask_question',     title: '\u2753 Tirar uma dúvida' },
                  ],
                },
              }],
              confidence: 1,
            };
            skipSchedulingAgent = true;
            step = MAX_STEPS;
          }
        }
      } else if (toolResult?.success) {
        if (forcedCall.tool === 'buscar_proximas_datas' && toolResult?.dates?.length > 0) {
          // FIX v5.3: Salvar datas e slots no state para uso pelos botões "Esta semana / Próxima semana"
          // FIX: Também salvar doctor_id/doctor_name para que o interceptor numérico funcione corretamente
          await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
            last_suggested_dates: normalizeDatesForState(toolResult.dates),
            last_suggested_slots: normalizeDatesForState(toolResult.dates).flatMap(d => (d.slots || []).map(s => ({ date: d.date_iso, time: s }))),
            booking_state: BOOKING_STATES.COLLECTING_DATE,
            stuck_counter_slots: 0,
            preferred_date: null,
            preferred_date_iso: null,
            ...(updatedState.doctor_id ? { doctor_id: updatedState.doctor_id } : {}),
            ...(updatedState.doctor_name ? { doctor_name: updatedState.doctor_name } : {}),
          });
          updatedState.booking_state = BOOKING_STATES.COLLECTING_DATE;
          updatedState.last_suggested_dates = toolResult.dates;

          const dateList = toolResult.dates.slice(0, 5).map((d, i) => {
            const slotsPreview = (d.slots || []).slice(0, 4).join(' · ');
            return `${i + 1}) ${d.day_of_week}, ${d.formatted_date}${slotsPreview ? ` — ${slotsPreview}` : ''}`;
          }).join('\n');
          const weekMsg = `📅 *${updatedState.doctor_name || 'Médico selecionado'}* tem as seguintes datas disponíveis:\n\n${dateList}\n\nResponda com o número da data:`;
          await saveConversationTurn({
            clinicId: envelope.clinic_id,
            fromNumber: envelope.from,
            correlationId: envelope.correlation_id,
            userText: envelope.message_text,
            assistantText: weekMsg,
            intentGroup: 'scheduling',
            intent: 'buscar_proximas_datas',
            slots: null,
          });
          clearTimeout(timeoutId);
          return res.json({
            correlation_id: envelope.correlation_id,
            final_message: weekMsg,
            actions: [buildDateListAction(toolResult.dates, updatedState.doctor_name)],
            debug: DEBUG ? { booking_state: BOOKING_STATES.COLLECTING_DATE, dates_count: toolResult.dates.length } : undefined,
          });
        } else if (forcedCall.tool === 'buscar_proximas_datas' && (!toolResult?.dates || toolResult.dates.length === 0)) {
          // FIX 3: buscar_proximas_datas retornou vazio — incrementar stuck_counter
          const currentStuckSlots = (updatedState.stuck_counter_slots || 0) + 1;
          await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
            stuck_counter_slots: currentStuckSlots,
          });
          updatedState.stuck_counter_slots = currentStuckSlots;
          console.log(`[FIX3] buscar_proximas_datas vazio, stuck_counter_slots = ${currentStuckSlots}`);

          if (currentStuckSlots >= STUCK_LIMIT) {
            await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
              booking_state: BOOKING_STATES.IDLE,
              stuck_counter_slots: 0,
            });
            decided = {
              decision_type: 'proceed',
              message: `Não encontrei vagas disponíveis para ${updatedState.specialty || updatedState.doctor_name || 'o médico solicitado'} nos próximos ${BUSCA_SLOTS_ABERTA_DIAS} dias.`,
              // CAMADA 2 — Cenário C: Botões de alternativa (stuck_limit)
              actions: [{
                type: 'send_interactive_buttons',
                payload: {
                  buttons: [
                    { id: 'try_other_date',   title: '\uD83D\uDCC5 Tentar outra data' },
                    { id: 'try_other_doctor', title: '\uD83D\uDC68\u200D\u2695\uFE0F Outro médico' },
                    { id: 'ask_question',     title: '\u2753 Tirar uma dúvida' },
                  ],
                },
              }],
              confidence: 1,
            };
          } else {
            // CORREÇÃO 2: Avançar booking_state para COLLECTING_DATE para evitar
            // que o interceptor dispare novamente na próxima mensagem (loop)
            // FIX loop: limpar preferred_date para que o guard rail não re-dispare com data antiga
            await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
              booking_state: BOOKING_STATES.COLLECTING_DATE,
              preferred_date: null,
              preferred_date_iso: null,
            });
            decided = {
              decision_type: 'proceed',
              message: `Não encontrei horários disponíveis para ${updatedState.doctor_name || updatedState.specialty || 'o médico solicitado'} nos próximos ${BUSCA_SLOTS_ABERTA_DIAS} dias. Gostaria de escolher outro médico ou especialidade?`,
              actions: [{ type: 'log' }],
              confidence: 1,
            };
          }
          skipSchedulingAgent = true;
          step = MAX_STEPS;
        } else if (forcedCall.tool === 'verificar_disponibilidade') {
          const slots = toolResult.available_slots || toolResult.slots || [];

          // FIX v5.2: Filtrar horários passados no dia atual
          const now = new Date();
          const todayStr = now.toISOString().split('T')[0];
          const requestedDate = forcedCall.params?.data || forcedCall.params?.date || updatedState.preferred_date_iso || updatedState.preferred_date || '';
          let filteredSlots = slots;
          if (requestedDate === todayStr) {
            const currentTotalMin = now.getHours() * 60 + now.getMinutes();
            filteredSlots = slots.filter(s => {
              const [h, m] = (typeof s === 'string' ? s : s?.time || '').split(':').map(Number);
              return (h * 60 + m) > currentTotalMin;
            });
          }

          // FIX 3: Resetar stuck_counter ao encontrar slots com sucesso
          await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
            last_suggested_slots: filteredSlots,
            booking_state: BOOKING_STATES.AWAITING_SLOTS,
            stuck_counter_slots: 0,
          });

          // FIX v5.3: Retornar horários do dia deterministicamente com formatação melhorada
          if (filteredSlots.length > 0) {
            const dateFormatted = formatDateBR(requestedDate);
            const slotsStr = filteredSlots.map(s => typeof s === 'string' ? s : s?.time).join(' · ');
            const doctorDisplay = updatedState.doctor_name || 'Médico selecionado';
            const displayMsg = `🕐 *${doctorDisplay}*\n📅 ${dateFormatted}\n\nHorários disponíveis:\n${slotsStr}\n\nQual horário você prefere?`;
            await saveConversationTurn({
              clinicId: envelope.clinic_id,
              fromNumber: envelope.from,
              correlationId: envelope.correlation_id,
              userText: envelope.message_text,
              assistantText: displayMsg,
              intentGroup: 'scheduling',
              intent: 'show_time_slots',
              slots: null,
            });
            clearTimeout(timeoutId);
            return res.json({
              correlation_id: envelope.correlation_id,
              final_message: displayMsg,
              actions: [buildTimeListAction(filteredSlots.map(s => typeof s === 'string' ? s : s?.time), doctorDisplay, dateFormatted)],
              debug: DEBUG ? { booking_state: BOOKING_STATES.AWAITING_SLOTS, slots_count: filteredSlots.length } : undefined,
            });
          }
          // Se não há slots após filtro → cai no LLM para informar
        }
      } else if (!validation.valid) {
        // CORREÇÃO 2: Avançar booking_state para COLLECTING_DATE para evitar
        // que o interceptor dispare novamente na próxima mensagem (loop)
        // FIX LOOP: Limpar preferred_date para que o LLM não re-invoque verificar_disponibilidade
        // com a data antiga na próxima mensagem (ex: "oi tudo bem" → loop de "Não encontrei horários")
        await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
          booking_state: BOOKING_STATES.COLLECTING_DATE,
          preferred_date: null,
          preferred_date_iso: null,
        });
        decided = {
          decision_type: 'proceed',
          message: validation.fallback,
          actions: [{ type: 'log' }],
          confidence: 1,
        };
        skipSchedulingAgent = true;
        step = MAX_STEPS;
      }
    } else if (!forcedCall) {
      // LLM decide livremente — manter flow normal com detectAvailabilityQuestion como fallback
      const isAvailabilityQuery = detectAvailabilityQuestion(envelope.message_text);
      const hasDoctorInState = !!(updatedState.doctor_id);
      if (isAvailabilityQuery && hasDoctorInState && extracted?.intent_group === 'scheduling') {
        console.log('[INTERCEPTOR] Availability question detected — forcing buscar_proximas_datas');
        const availResult = await executeSchedulingTool(
          'buscar_proximas_datas',
          { doctor_id: updatedState.doctor_id, dias: BUSCA_SLOTS_ABERTA_DIAS, busca_aberta: true },
          { clinicId: envelope.clinic_id, userPhone: envelope.from }
        );
        if (availResult?.success && availResult?.dates?.length > 0) {
          await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
            last_suggested_dates: normalizeDatesForState(availResult.dates),
            last_suggested_slots: normalizeDatesForState(availResult.dates).flatMap(d => (d.slots || []).map(s => ({ date: d.date_iso, time: s }))),
            booking_state: BOOKING_STATES.COLLECTING_DATE,
            preferred_date: null,
            preferred_date_iso: null,
            ...(updatedState.doctor_id ? { doctor_id: updatedState.doctor_id } : {}),
            ...(updatedState.doctor_name ? { doctor_name: updatedState.doctor_name } : {}),
          });
          const dateList = availResult.dates.slice(0, 5).map((d, i) => {
            const slotsPreview = (d.slots || []).slice(0, 4).join(' · ');
            return `${i + 1}) ${d.day_of_week}, ${d.formatted_date}${slotsPreview ? ` — ${slotsPreview}` : ''}`;
          }).join('\n');
          decided = {
            decision_type: 'proceed',
            message: `📅 *${updatedState.doctor_name || 'Médico selecionado'}* tem as seguintes datas disponíveis:\n\n${dateList}\n\nResponda com o número da data:`,
            actions: [buildDateListAction(availResult.dates, updatedState.doctor_name)],
            confidence: 1,
          };
          skipSchedulingAgent = true;
          step = MAX_STEPS;
        }
      }
    }

    // ======================================================
    // 8) STEP 1: decide_next_action
    // ======================================================
    if (step < MAX_STEPS) {
      const decision = await openai.chat.completions.create(
        {
          model: OPENAI_MODEL,
          messages: [
            {
              role: 'system',
              content: buildSystemPrompt(clinicRules, doctors, services, kbContext, updatedState) +
                `\n\n## RESTRIÇÕES OPERACIONAIS\n` +
                `allow_prices=${clinicRules.allow_prices}. ` +
                (clinicRules.allow_prices === false ? 'Se pedir preço: decision_type=block_price.\n' : '\n') +
                `Se faltar dado essencial: decision_type=ask_missing com pergunta direta (1 frase).\n` +
                `Se tiver informação suficiente: decision_type=proceed.\n` +
                `Sua saída DEVE ser via ferramenta decide_next_action.`,
            },
            // Incluir histórico para que o modelo saiba o que já foi respondido
            ...previousMessages.map(msg => ({
              role: msg.role === 'user' ? 'user' : 'assistant',
              content: msg.content,
            })),
            {
              // Fix: LLM precisa ver a mensagem original para decidir corretamente.
              // Antes só recebia o objeto extracted (sem o texto do usuário).
              role: 'user',
              content: JSON.stringify({ message: envelope.message_text, extracted }),
            },
          ],
          tools: [tools[1]],
          tool_choice: { type: 'function', function: { name: 'decide_next_action' } },
        },
        { signal: controller.signal }
      );

      // Acumular usage da chamada decide_next_action
      if (decision.usage) {
        totalTokensInput += decision.usage.prompt_tokens || 0;
        totalTokensOutput += decision.usage.completion_tokens || 0;
      }

      // 🔧 CORREÇÃO: acessar choices[0].message.tool_calls
      const call = decision.choices[0]?.message?.tool_calls?.[0];
      const parsedArgs = call?.function?.arguments
        ? safeJsonParse(call.function.arguments)
        : null;

      if (!parsedArgs) {
        decided = {
          decision_type: 'ask_missing',
          message:
            'Perfeito. Me diga seu nome completo e o melhor dia/horário (manhã/tarde/noite).',
          actions: [{ type: 'log' }],
        };
      } else {
        decided = parsedArgs;
      }

      step++;
    }

    // Fallback: garantir que decided sempre está definido (JG-P0-002)
    if (!decided) {
      decided = {
        decision_type: 'ask_missing',
        message: 'Desculpe, não consegui processar sua solicitação. Pode fornecer mais detalhes?',
        actions: [{ type: 'log' }],
        confidence: 0.5,
      };
    }

    // Registrar gap de conhecimento quando a confiança da decisão está baixa
    if (decided.confidence !== undefined && decided.confidence < 0.7) {
      await logKnowledgeGap(
        envelope.clinic_id,
        envelope.correlation_id,
        envelope.message_text,
        { intent: extracted.intent, slots: extracted.slots }
      );
    }

    // ======================================================
    // 9) STEP 2: AGENTE DE AGENDAMENTO (apenas quando proceed + scheduling)
    // ======================================================
    if (
      !skipSchedulingAgent &&
      decided.decision_type === 'proceed' &&
      extracted.intent_group === 'scheduling'
    ) {
      const agentSystemPrompt = buildSystemPrompt(clinicRules, doctors, services, kbContext, updatedState) +
        '\n\n## INSTRUÇÕES DE AGENDAMENTO\n' +
        'Use as ferramentas disponíveis para verificar disponibilidade REAL e criar agendamentos.\n' +
        'Nunca invente horários ou convênios — consulte sempre as tools.\n' +
        'Responda diretamente ao paciente em no máximo 3 frases.';

      const agentMessages = [
        { role: 'system', content: agentSystemPrompt },
        ...previousMessages.map(msg => ({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: msg.content,
        })),
        { role: 'user', content: envelope.message_text },
      ];

      // Loop do agente com tool_calls (máx 3 iterações)
      let agentStep = 0;
      // Rastreador: conta quantas vezes cada tool foi chamada neste ciclo
      // Evita o LLM chamar verificar_disponibilidade 3x e gerar 3 respostas iguais
      const toolCallCount = {};
      const MAX_CALLS_PER_TOOL = 1;
      while (agentStep < 3) {
        const agentResp = await openai.chat.completions.create(
          {
            model: OPENAI_MODEL,
            messages: agentMessages,
            tools: schedulingToolsDefinitions,
            temperature: 0.4,
          },
          { signal: controller.signal }
        );

        // Acumular usage da chamada do scheduling agent
        if (agentResp.usage) {
          totalTokensInput += agentResp.usage.prompt_tokens || 0;
          totalTokensOutput += agentResp.usage.completion_tokens || 0;
        }

        const choice = agentResp.choices[0];

        if (!choice.message.tool_calls || choice.message.tool_calls.length === 0) {
          // Resposta textual final — substituir mensagem do decided
          if (choice.message.content) {
            decided.message = choice.message.content;
          }
          break;
        }

        // Processar chamadas de tool
        agentMessages.push(choice.message);
        for (const toolCall of choice.message.tool_calls) {
          // Verificar limite de chamadas por tool
          const toolName = toolCall.function.name;

          // ANTI-LOOP: Bloquear verificar_disponibilidade quando em COLLECTING_DATE.
          // Neste estado não há preferred_date válida — o LLM pode tentar re-verificar
          // uma data obsoleta do contexto histórico, gerando loop de "Não encontrei horários".
          if (toolName === 'verificar_disponibilidade' &&
              updatedState?.booking_state === BOOKING_STATES.COLLECTING_DATE) {
            log.warn({ booking_state: updatedState.booking_state }, '[ANTI-LOOP] verificar_disponibilidade bloqueada em COLLECTING_DATE');
            agentMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify({
                success: false,
                blocked: true,
                message: 'Aguardando paciente selecionar nova data. Use buscar_proximas_datas para mostrar datas disponíveis, ou aguarde a seleção do usuário.',
              }),
            });
            continue;
          }

          toolCallCount[toolName] = (toolCallCount[toolName] || 0) + 1;
          if (toolCallCount[toolName] > MAX_CALLS_PER_TOOL) {
            log.warn({ tool: toolName, count: toolCallCount[toolName] }, '[LOOP] Tool chamada mais de uma vez neste ciclo — bloqueando');
            agentMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify({
                success: false,
                blocked: true,
                message: 'Esta ferramenta já foi usada neste ciclo. Encerre sua resposta com o que você já sabe.',
              }),
            });
            continue;
          }

          let toolArgs = {};
          try { toolArgs = JSON.parse(toolCall.function.arguments); } catch { /* sem args */ }

          const toolResult = await executeSchedulingTool(
            toolCall.function.name,
            toolArgs,
            { clinicId: envelope.clinic_id, userPhone: envelope.from }
          );

          agentMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolResult),
          });

          // Validar resultado de tools de disponibilidade
          const availTools = ['verificar_disponibilidade', 'buscar_proximas_datas'];
          if (availTools.includes(toolCall.function.name)) {
            const valResult = validateAvailabilityResult(toolResult, toolCall.function.name);
            logDecision('tool_validated', {
              tool: toolCall.function.name,
              valid: valResult.valid,
              slots_returned: toolResult?.available_slots?.length || toolResult?.dates?.length || 0,
            }, envelope.clinic_id, envelope.from);

            if (!valResult.valid && valResult.noSlots && toolCall.function.name === 'verificar_disponibilidade') {
              // FIX-FALLBACK: Sem slots nessa data → buscar a partir da data solicitada (não de hoje)
              const dataSolicitada = valResult.requestedDate || updatedState.preferred_date || null;
              console.log(`[TOOL] No slots em ${dataSolicitada} — auto-fallback to buscar_proximas_datas a partir de ${dataSolicitada}`);
              const fallbackArgs = {
                doctor_id: updatedState.doctor_id,
                dias: 14,
              };
              // Passar dataInicio para buscar a partir da data solicitada, não de hoje
              if (dataSolicitada) {
                fallbackArgs.data_inicio = dataSolicitada;
              }
              const fallbackRes = await executeSchedulingTool(
                'buscar_proximas_datas',
                fallbackArgs,
                { clinicId: envelope.clinic_id, userPhone: envelope.from }
              );
              // Injetar resultado do fallback como contexto de sistema
              // (não como tool result com ID fictício — isso causa erro na API da OpenAI)
              if (fallbackRes?.dates?.length > 0) {
                // CORREÇÃO 3+5: Salvar last_suggested_dates e last_suggested_slots
                await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
                  last_suggested_dates: normalizeDatesForState(fallbackRes.dates),
                  last_suggested_slots: normalizeDatesForState(fallbackRes.dates).flatMap(d => (d.slots || []).map(s => ({ date: d.date_iso, time: s }))),
                  booking_state: BOOKING_STATES.COLLECTING_DATE,
                  stuck_counter_slots: 0,
                  preferred_date: null,
                  preferred_date_iso: null,
                });
                // CORREÇÃO 3: Usar mensagem já formatada com horários reais
                const fallbackMsg = fallbackRes.message && fallbackRes.message.includes('horários disponíveis')
                  ? fallbackRes.message
                  : (() => {
                      const dateList = fallbackRes.dates.slice(0, 5)
                        .map(d => {
                          const slotsStr = d.slots ? d.slots.join(', ') : `${d.slots_count || '?'} horários`;
                          return `${d.day_of_week}, ${d.formatted_date} — ${slotsStr}`;
                        }).join('\n');
                      return `${updatedState.doctor_name || 'O médico'} não atende nessa data. Os próximos horários disponíveis são:\n\n${dateList}\n\nQual dia e horário você prefere?`;
                    })();
                agentMessages.push({
                  role: 'system',
                  content: `[BUSCA AUTOMÁTICA DE ALTERNATIVAS] Não havia horários na data solicitada. ` +
                    `Use EXATAMENTE esta mensagem para responder ao paciente: "${fallbackMsg}". ` +
                    `Não invente outros horários. Não pergunte a data novamente.`,
                });
              } else {
                // Busca também vazia: limpar preferred_date para não fazer loop nas próximas msgs
                await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
                  preferred_date: null,
                  preferred_date_iso: null,
                  booking_state: BOOKING_STATES.IDLE,
                  stuck_counter_slots: 0,
                });
                agentMessages.push({
                  role: 'system',
                  content: '[BUSCA AUTOMÁTICA DE ALTERNATIVAS] Não encontrei horários disponíveis nos próximos 14 dias. ' +
                    'Informe o paciente UMA Única VEZ e pergunte se deseja tentar outro médico ou especialidade.',
                });
              }
            }
          }

          // CORREÇÃO 5: Persistir opções apresentadas no estado com slots reais
          if (toolCall.function.name === 'buscar_proximas_datas' && toolResult?.success) {
            const datesWithSlots = (toolResult.dates || []).map(d => ({
              date: d.date,
              date_iso: d.date_iso || d.date,
              formatted_date: d.formatted_date,
              day_of_week: d.day_of_week,
              slots_count: d.slots_count || (d.slots || []).length,
              slots: d.slots || [], // CORREÇÃO 5: Incluir slots reais
            }));
            // CORREÇÃO 5: Salvar last_suggested_slots como lista plana de {date, time}
            const flatSlots = datesWithSlots.flatMap(d =>
              (d.slots || []).map(s => ({ date: d.date, time: s }))
            );
            // FIX: Extrair doctor_id dos args da tool call para preservar no estado
            const toolArgs = safeJsonParse(toolCall.function.arguments) || {};
            const doctorIdFromTool = toolArgs.doctor_id || updatedState.doctor_id || null;
            const doctorFromList = doctorIdFromTool ? doctors.find(d => d.id === doctorIdFromTool) : null;
            const doctorNameFromTool = doctorFromList?.name || updatedState.doctor_name || null;
            await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
              last_suggested_dates: datesWithSlots,
              last_suggested_slots: flatSlots,
              booking_state: BOOKING_STATES.COLLECTING_DATE,
              preferred_date: null,
              preferred_date_iso: null,
              ...(doctorIdFromTool ? { doctor_id: doctorIdFromTool } : {}),
              ...(doctorNameFromTool ? { doctor_name: doctorNameFromTool } : {}),
            });
            // FIX: Retornar lista de datas diretamente (mesmo formato do forced path)
            // Evita que o LLM reformule a mensagem usando apenas slots_count do service,
            // garantindo que o que é exibido = o que está salvo em last_suggested_dates
            if (datesWithSlots.length > 0) {
              const dateListFormatted = datesWithSlots.slice(0, 5).map((d, i) => {
                const slotsPreview = (d.slots || []).slice(0, 4).join(' · ');
                return `${i + 1}) ${d.day_of_week}, ${d.formatted_date}${slotsPreview ? ` — ${slotsPreview}` : ''}`;
              }).join('\n');
              const weekMsg = `📅 *${updatedState.doctor_name || 'Médico selecionado'}* tem as seguintes datas disponíveis:\n\n${dateListFormatted}\n\nResponda com o número da data:`;
              await saveConversationTurn({
                clinicId: envelope.clinic_id,
                fromNumber: envelope.from,
                correlationId: envelope.correlation_id,
                userText: envelope.message_text,
                assistantText: weekMsg,
                intentGroup: 'scheduling',
                intent: 'buscar_proximas_datas',
                slots: null,
              });
              clearTimeout(timeoutId);
              return res.json({
                correlation_id: envelope.correlation_id,
                final_message: weekMsg,
                actions: [buildDateListAction(datesWithSlots, updatedState.doctor_name)],
                debug: DEBUG ? { booking_state: BOOKING_STATES.COLLECTING_DATE, dates_count: datesWithSlots.length, source: 'llm_buscar_proximas_datas' } : undefined,
              });
            }
          }
          if (toolCall.function.name === 'verificar_disponibilidade' && toolResult?.success) {
            const availSlots = toolResult.available_slots || toolResult.slots || [];
            await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
              last_suggested_slots: availSlots.map(s => ({ date: toolResult.date || null, time: s })),
              booking_state: BOOKING_STATES.AWAITING_SLOTS,
            });
          }
          if (toolCall.function.name === 'criar_agendamento' && toolResult?.success) {
            await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
              booking_state: BOOKING_STATES.BOOKED,
              appointment_confirmed: true,
            });
            logDecision('state_transition', {
              from: BOOKING_STATES.BOOKED,
              to: 'appointment_confirmed',
              trigger: 'criar_agendamento_success',
            }, envelope.clinic_id, envelope.from);

            // — Finalizar tracking da conversa (PONTO E) —
            if (conversationRecord) {
              try {
                await finalizeConversation(
                  supabase,
                  conversationRecord.id,
                  'completed',
                  'booked',
                  toolResult.appointment_id || null,
                  toolResult.patient_id || null
                );
              } catch (trackingError) {
                console.warn('[ConversationTracker] Erro ao finalizar:', trackingError.message);
              }
            }
          }

          if (DEBUG) {
            log.debug({ tool: toolCall.function.name, result: toolResult }, 'scheduling_tool_executed');
          }
        }

        agentStep++;
      }
    }

    // ======================================================
    // 10) VALIDAÇÃO BACKEND (proteção extra)
    // ======================================================
    if (
      extracted.intent_group === 'billing' &&
      clinicRules.allow_prices === false
    ) {
      decided = {
        decision_type: 'block_price',
        message:
          'Por aqui não informamos valores. Posso agendar uma avaliação — me diga seu nome e o melhor dia/horário 🙂',
        actions: [{ type: 'log' }],
        confidence: 1,
      };
    }

    // ======================================================
    // 10b) ANTI-REPETIÇÃO: salvar última pergunta no estado
    // ======================================================
    const finalMessage = decided.message;
    const questionMatch = finalMessage.match(/[^.!]*\?/);
    const lastQuestion = questionMatch ? questionMatch[0].trim() : null;

    if (isRepetition(finalMessage, updatedState.last_question_asked)) {
      log.warn({ msg: finalMessage, prev: updatedState.last_question_asked }, '⚠️ repetição detectada');
    }

    if (lastQuestion) {
      await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
        last_question_asked: lastQuestion,
      });
    }

    // ======================================================
    // 10c) BUG 3 FIX: CONTROLE DE ENVIO DUPLICADO
    // Verificar se a mesma mensagem já foi enviada nos últimos 30 segundos
    // para este número. Se sim, bloquear envio duplicado.
    // ======================================================
    try {
      const DEDUP_WINDOW_MS = 30 * 1000; // 30 segundos
      const { data: recentMessages } = await supabase
        .from('conversation_history')
        .select('message_text, created_at')
        .eq('clinic_id', envelope.clinic_id)
        .eq('from_number', envelope.from)
        .eq('role', 'assistant')
        .gte('created_at', new Date(Date.now() - DEDUP_WINDOW_MS).toISOString())
        .order('created_at', { ascending: false })
        .limit(3);

      if (recentMessages && recentMessages.length > 0) {
        const isDuplicate = recentMessages.some(msg => {
          // Normalizar para comparação (remover espaços extras e emojis)
          const normalize = (s) => s.replace(/\s+/g, ' ').trim().substring(0, 100);
          return normalize(msg.message_text) === normalize(finalMessage);
        });

        if (isDuplicate) {
          log.warn({
            from: envelope.from,
            clinic_id: envelope.clinic_id,
            msg_preview: finalMessage.substring(0, 80),
          }, '[BUG3-FIX] Mensagem duplicada detectada nos últimos 30s — bloqueando envio');
          clearTimeout(timeoutId);
          return res.json({
            correlation_id: envelope.correlation_id,
            final_message: null, // sinal para o Worker n8n não enviar
            actions: [{ type: 'dedup_blocked', payload: { reason: 'duplicate_within_30s' } }],
            debug: DEBUG ? { dedup: true, blocked_message: finalMessage.substring(0, 80) } : undefined,
          });
        }
      }
    } catch (dedupErr) {
      // Silencioso: não bloquear o fluxo por erro na dedup
      log.warn({ err: String(dedupErr) }, '[BUG3-FIX] Erro na verificação de dedup — continuando');
    }

    // ======================================================
    // 10) LOG ESTRUTURADO
    // ======================================================
    try {
      await supabase.from('agent_logs').insert({
        clinic_id: envelope.clinic_id,
        correlation_id: envelope.correlation_id,
        log_type: 'intent',
        intent_group: extracted.intent_group,
        intent: extracted.intent,
        confidence: extracted.confidence,
        decision_type: decided?.decision_type || null,
        latency_ms: Date.now() - started,
        extra_data: {
          // NOVOS campos de custo (PASSO 1.4)
          tokens: {
            input: totalTokensInput,
            output: totalTokensOutput,
            total: totalTokensInput + totalTokensOutput,
          },
          cost_usd: calculateCost(totalTokensInput, totalTokensOutput),
          model: process.env.OPENAI_MODEL || 'gpt-4.1',
        },
      });
    } catch (e) {
      log.warn({ err: String(e) }, 'agent_logs_insert_failed');
    }

    // ======================================================
    // 11) SALVAR HISTÓRICO + RESPOSTA FINAL
    // ======================================================
    await saveConversationTurn({
      clinicId: envelope.clinic_id,
      fromNumber: envelope.from,
      correlationId: envelope.correlation_id,
      userText: envelope.message_text,
      assistantText: decided.message,
      intentGroup: extracted?.intent_group,
      intent: extracted?.intent,
      slots: extracted?.slots,
    });

    // Limpar pending_info_question após o agente responder (evitar persistência indesejada)
    if (conversationState?.pending_info_question) {
      await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
        pending_info_question: null,
      });
    }

    // CORREÇÃO 5: Atualizar conversation_stage com base no intent_group
    // para que o estado reflita o estágio atual da conversa
    try {
      let newStage = null;
      const ig = extracted?.intent_group;
      if (ig === 'scheduling') {
        const bs = updatedState?.booking_state;
        if (bs === BOOKING_STATES.BOOKED) newStage = 'booked';
        else if (bs === BOOKING_STATES.CONFIRMING) newStage = 'awaiting_confirmation';
        else newStage = 'scheduling';
      } else if (ig === 'cancellation') {
        newStage = 'cancellation';
      } else if (ig === 'reschedule') {
        newStage = 'reschedule';
      } else if (ig === 'info') {
        newStage = 'info';
      } else {
        newStage = 'active';
      }
      if (newStage) {
        await updateConversationState(supabase, envelope.clinic_id, envelope.from, {
          conversation_stage: newStage,
        });
      }
    } catch (stageErr) {
      log.warn({ err: String(stageErr) }, 'conversation_stage_update_failed');
    }

    // — Atualizar tracking com dados do turno (PONTO C) —
    if (conversationRecord) {
      try {
        await updateConversationTurn(supabase, conversationRecord.id, {
          tokensInput: totalTokensInput,
          tokensOutput: totalTokensOutput,
          costEstimated: calculateCost(totalTokensInput, totalTokensOutput),
        });
      } catch (trackingError) {
        console.warn('[ConversationTracker] Erro no update de turno:', trackingError.message);
      }
    }

    clearTimeout(timeoutId);

    // — CRM V2: Fire-and-forget (não bloqueia resposta ao paciente) —
    try {
      let conversationOutcome = 'conversation';
      if (updatedState?.booking_state === BOOKING_STATES.BOOKED) {
        conversationOutcome = 'booked';
      } else if (extracted?.intent === 'cancel' || extracted?.intent === 'confirm_no') {
        conversationOutcome = 'cancelled';
      } else if (extracted?.intent_group === 'info' || extracted?.intent === 'info_query') {
        conversationOutcome = 'info_provided';
      }

      // Fix: appointmentId agora é salvo no state durante CONFIRMING → disponível aqui
      const lastAppointmentId = updatedState?.last_appointment_id || null;
      processPostConversation(
        supabase,
        envelope.from,
        envelope.clinic_id,
        conversationOutcome,
        conversationRecord?.id || null,
        lastAppointmentId
      ).catch(err => console.error('[CRM] Erro no pós-processamento:', err.message));
    } catch (crmErr) {
      // Erro síncrono na preparação — nunca deve derrubar o agente
      console.error('[CRM] Erro ao iniciar CRM V2:', crmErr.message);
    }

    // Se o LLM apresentou horários mas não gerou lista interativa, injetar aqui
    const finalActions = decided.actions ?? [];
    const hasTimeList = finalActions.some(a => a.type === 'send_interactive_list');
    if (!hasTimeList && updatedState?.booking_state === BOOKING_STATES.AWAITING_SLOTS) {
      const sugSlotsFinal = updatedState?.last_suggested_slots || [];
      if (sugSlotsFinal.length > 0) {
        const doctorDisplayFinal = updatedState?.doctor_name || 'Médico selecionado';
        const dateFinalISO = updatedState?.last_selected_date || (sugSlotsFinal[0]?.date || '');
        const dateFinalFormatted = dateFinalISO ? formatDateBR(dateFinalISO) : '';
        finalActions.push(buildTimeListAction(sugSlotsFinal, doctorDisplayFinal, dateFinalFormatted));
      }
    }

    return res.json({
      correlation_id: envelope.correlation_id,
      final_message: decided.message,
      actions: finalActions,
      debug: DEBUG
        ? {
            extracted,
            decided,
            kb_hits: (kbRows ?? []).length,
            latency_ms: Date.now() - started,
          }
        : undefined,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    const errName = err?.name || 'UnknownError';
    const errMessage = err?.message || String(err);

    log.error(
      {
        err_name: errName,
        err_message: errMessage,
        correlation_id: envelope.correlation_id,
        clinic_id: envelope.clinic_id,
      },
      'process_error'
    );

    const isTimeout = String(err?.name || '').toLowerCase().includes('abort');

    return res.status(200).json({
      correlation_id: envelope.correlation_id,
      final_message: isTimeout
        ? 'Demorei um pouco para responder. Pode repetir sua mensagem, por favor? 🙏'
        : 'Tive uma instabilidade agora. Pode repetir sua mensagem em 1 minuto?',
      actions: [{ type: 'log', payload: { event: 'agent_error' } }],
      debug: DEBUG
        ? { error_message: errMessage, error_name: errName }
        : undefined,
    });
  } finally {
    clearTimeout(timeoutId);
    // Liberar lock atômico ao final do processamento (sucesso ou erro).
    // Ao setar last_processed_at no passado, a próxima mensagem passa imediatamente.
    if (processingLockAcquired && envelope?.clinic_id && envelope?.from) {
      updateConversationState(supabase, envelope.clinic_id, envelope.from, {
        last_processed_at: '1970-01-01T00:00:00.000Z',
      }).catch(() => {});
    }
  }
});

// ======================================================
// INICIAR SERVIDOR
// ======================================================
app.get("/health", async (req, res) => {
  const redisStatus = await redisHealthCheck();
  res.json({ ok: true, service: "agent-service", redis: redisStatus });
});

app.listen(PORT, "0.0.0.0", () => {
  log.info({ port: PORT }, '🚀 agent-service listening');

  // — CRM Fase 3: Iniciar Task Processor (varredura de crm_tasks pendentes) —
  // Fire-and-forget — se falhar, o server continua operando normalmente
  try {
    startTaskProcessor(supabase);
  } catch (err) {
    log.warn({ err: err.message }, '[TASK-PROCESSOR] Falha ao iniciar — server continua sem processor');
  }

  // — F9D: Campaign Scheduler (verifica campanhas agendadas a cada 30s) —
  try {
    startCampaignScheduler();
  } catch (err) {
    log.warn({ err: err.message }, '[CampaignScheduler] Falha ao iniciar — server continua sem scheduler');
  }
});
