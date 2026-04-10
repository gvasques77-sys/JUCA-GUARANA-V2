// lib/sentry.js
// Módulo central de inicialização do Sentry (v10 API).
// Só ativa se SENTRY_DSN estiver presente no ambiente.
// LGPD: beforeSend mascara telefones, CPFs e campos de paciente.

import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

// Regex para detectar e mascarar dados sensíveis (LGPD)
const PHONE_RE = /\b\d{10,13}\b/g;
const CPF_RE = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;

// Nomes de chaves cujo valor nunca deve sair do servidor
const SENSITIVE_KEYS = [
  'message_text', 'content', 'body', 'text',
  'phone', 'from', 'to', 'patient_name', 'name',
  'cpf', 'email', 'birth_date', 'patient',
];

function scrubString(value) {
  if (typeof value !== 'string') return value;
  let v = value.replace(PHONE_RE, '[PHONE]');
  v = v.replace(CPF_RE, '[CPF]');
  return v;
}

function scrubValue(key, value) {
  if (typeof value !== 'string') return value;
  const lk = String(key).toLowerCase();
  if (SENSITIVE_KEYS.some(sk => lk.includes(sk))) return '[REDACTED]';
  return scrubString(value);
}

function scrubObject(obj, depth = 0) {
  if (depth > 6) return '[truncated]';
  if (obj == null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(v => (typeof v === 'object' ? scrubObject(v, depth + 1) : scrubString(v)));
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    const lk = String(k).toLowerCase();
    if (SENSITIVE_KEYS.some(sk => lk.includes(sk))) {
      result[k] = '[REDACTED]';
    } else if (v && typeof v === 'object') {
      result[k] = scrubObject(v, depth + 1);
    } else {
      result[k] = scrubValue(k, v);
    }
  }
  return result;
}

let sentryInitialized = false;

/**
 * Inicializa o Sentry. Deve ser chamada ANTES de importar qualquer
 * outro módulo que precise de instrumentação automática.
 */
export function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || dsn.trim() === '') {
    console.log('[Sentry] SENTRY_DSN não definido — Sentry desativado (ok em dev)');
    return;
  }

  try {
    Sentry.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT || 'development',
      tracesSampleRate: 0.1,
      profilesSampleRate: 0.1,
      integrations: [nodeProfilingIntegration()],
      // Evitar enviar dados completos de request por padrão — a gente enriquece manualmente
      sendDefaultPii: false,
      beforeSend(event) {
        try {
          // Mascarar dados sensíveis de pacientes (LGPD)
          if (event.request) {
            if (event.request.data) {
              event.request.data = scrubObject(event.request.data);
            }
            if (event.request.headers) {
              delete event.request.headers['authorization'];
              delete event.request.headers['cookie'];
              delete event.request.headers['x-webhook-signature'];
            }
            if (event.request.query_string) {
              event.request.query_string = scrubString(event.request.query_string);
            }
          }
          if (event.extra) event.extra = scrubObject(event.extra);
          if (event.contexts) event.contexts = scrubObject(event.contexts);
          if (event.breadcrumbs) {
            event.breadcrumbs = event.breadcrumbs.map(b => ({
              ...b,
              data: b.data ? scrubObject(b.data) : b.data,
              message: b.message ? scrubString(b.message) : b.message,
            }));
          }
          // Mascarar exception messages também (podem conter telefones/PII em stack traces)
          if (event.exception?.values) {
            for (const exc of event.exception.values) {
              if (exc.value) exc.value = scrubString(exc.value);
            }
          }
        } catch (scrubErr) {
          // Se falhar o scrubbing, descarta o evento por segurança
          console.warn('[Sentry] beforeSend scrub failed — dropping event:', scrubErr?.message);
          return null;
        }
        return event;
      },
    });

    sentryInitialized = true;
    console.log('[Sentry] Sentry initialized');
  } catch (err) {
    console.error('[Sentry] Falha ao inicializar:', err?.message);
  }
}

export function isSentryActive() {
  return sentryInitialized;
}

/**
 * Captura exceção com tags adicionais. No-op se Sentry não estiver ativo.
 * Wrapper seguro — nunca lança.
 */
export function captureException(err, context = {}) {
  if (!sentryInitialized) return;
  try {
    Sentry.withScope(scope => {
      if (context.clinicId) scope.setTag('clinic_id', context.clinicId);
      if (context.jobType) scope.setTag('job_type', context.jobType);
      if (context.module) scope.setTag('module', context.module);
      if (context.extra) {
        for (const [k, v] of Object.entries(scrubObject(context.extra))) {
          scope.setExtra(k, v);
        }
      }
      Sentry.captureException(err);
    });
  } catch (e) {
    // Sentry nunca deve derrubar o fluxo principal
  }
}

/**
 * Define o clinic_id na isolation scope da request atual.
 * Deve ser chamado no authMiddleware após identificar a clínica.
 */
export function setClinicContext(clinicId) {
  if (!sentryInitialized || !clinicId) return;
  try {
    Sentry.getIsolationScope().setTag('clinic_id', clinicId);
  } catch (e) {
    // noop
  }
}

export { Sentry };
