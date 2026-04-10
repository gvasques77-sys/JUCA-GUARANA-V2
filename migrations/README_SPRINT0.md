# Sprint 0 — Migrations aplicadas via Supabase MCP

As seguintes migrations foram aplicadas diretamente em produção via Supabase MCP
pelo Claude principal antes do merge desta branch, para evitar conflito com a
tabela `clinic_ai_usage` que já existia em produção (com 74 registros populados
pelo F8 backoffice):

- `sprint0_010_extend_clinic_ai_usage` — adiciona colunas `cached_tokens`,
  `latency_ms`, `success`, `error_message`, `request_id`, `purpose` à tabela
  existente. Preserva os 74 registros históricos (defaults aplicados às
  colunas novas). **NÃO altera o CHECK constraint em `usage_type`.**
- `sprint0_011_create_lara_latency_log` — cria tabela nova de latência
  ponta-a-ponta (`lara_latency_log`), RLS lockdown (acesso só via service_role).

## Schema final

### `clinic_ai_usage` (tabela existente do F8, estendida)

- **Legado (migration 006):** `id`, `clinic_id`, `usage_type` (CHECK em
  `conversation|task_processing|report|other`), `conversation_id`,
  `report_type`, `model`, `tokens_input`, `tokens_output`, `tokens_total`
  (GENERATED), `cost_usd`, `metadata`, `created_at`.
- **Sprint 0 (migration sprint0_010):** `cached_tokens`, `latency_ms`,
  `success`, `error_message`, `request_id`, `purpose`.

A coluna `usage_type` continua sendo a categoria macro para compat com o F8
dashboard. A coluna `purpose` é a categoria fina da Sprint 0 em diante
(ex: `lara_classification`, `crm_report_patient`). O
`lib/openaiTracker.js` popula ambas via `deriveUsageType(purpose)`.

### `lara_latency_log` (tabela nova)

- `id`, `clinic_id`, `created_at`
- `whatsapp_message_id`, `conversation_stage`
- `total_latency_ms`, `webhook_to_processing_ms`, `context_load_ms`,
  `openai_total_ms`, `whatsapp_send_ms`
- `success`, `error_stage`, `openai_calls_count`
- RLS **habilitado sem policies** (lockdown — acesso só via service_role).

## ⚠️ NÃO recriar essas migrations localmente

Os arquivos `010_openai_usage_log.sql` e `011_lara_latency_log.sql` do plano
original foram **apagados** deste branch. Eles criariam uma tabela nova
`openai_usage_log` que entraria em conflito com o F8 backoffice. A versão
correta já está em produção via MCP.

## Proibições explícitas da Sprint 0

1. **NÃO** criar `openai_usage_log` localmente.
2. **NÃO** mexer no CHECK de `clinic_ai_usage.usage_type`. Usar o mapeamento
   `deriveUsageType()` em `lib/openaiTracker.js`.
3. **NÃO** mexer nos 74 registros históricos de `clinic_ai_usage`.
4. **NÃO** apagar `usage_type` nem substituí-lo por `purpose`. Os dois coexistem:
   `usage_type` para F8, `purpose` para granularidade Sprint 0+.
5. **NÃO** mudar `lib/latencyTracker.js` — continua escrevendo em
   `lara_latency_log`.
