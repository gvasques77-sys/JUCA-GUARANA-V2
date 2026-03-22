# Checklist de Validação v4 — JUCA GUARANÁ
> Executar APÓS aplicar migrations_v4_foundation.sql no Supabase.
> Substituir `<CLINIC_ID>`, `<API_KEY>` e `<URL>` pelos valores reais.

---

## Configuração base

```bash
BASE_URL="https://seu-servico.railway.app"   # ou http://localhost:3000
API_KEY="sua-agent-api-key"
CLINIC_ID="09e5240f-9c26-47ee-a54d-02934a36ebfd"
FROM="5565999990001"
```

---

## TESTE 1 — Mensagem duplicada (inbound_dedup)

**O que valida:** `INSERT ON CONFLICT DO NOTHING` na tabela `inbound_dedup` bloqueia reprocessamento do mesmo `wa_message_id`.

**Ação:**
```bash
# Enviar a MESMA mensagem duas vezes com o mesmo correlation_id
MSG='{"correlation_id":"DEDUP-TEST-001","clinic_id":"'$CLINIC_ID'","from":"'$FROM'","message_text":"quero consulta"}'

curl -s -X POST $BASE_URL/process \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d "$MSG"

# Mesma mensagem imediatamente
curl -s -X POST $BASE_URL/process \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d "$MSG"
```

**SQL de verificação:**
```sql
SELECT clinic_id, wa_message_id, received_at
FROM public.inbound_dedup
WHERE wa_message_id = 'DEDUP-TEST-001'
ORDER BY received_at;
-- Esperado: APENAS 1 linha
```

| Verificação | Esperado | Passou? |
|---|---|---|
| Apenas 1 linha em inbound_dedup | ✅ | |
| Segunda resposta HTTP tem `final_message: null` | ✅ | |
| Nenhum agendamento duplicado criado | ✅ | |

---

## TESTE 2 — Lock concorrente (novos usuários)

**O que valida:** `try_acquire_processing_lock` com INSERT ON CONFLICT — 2 requests simultâneos só 1 passa.

**Ação:**
```bash
# Número completamente novo (nunca usou o sistema)
FROM_NEW="5565999990099"

MSG='{"correlation_id":"LOCK-TEST-001","clinic_id":"'$CLINIC_ID'","from":"'$FROM_NEW'","message_text":"oi"}'

# Disparar 2 requests quase simultâneos (background + foreground)
curl -s -X POST $BASE_URL/process \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d "$MSG" &

curl -s -X POST $BASE_URL/process \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d "${MSG/LOCK-TEST-001/LOCK-TEST-002}"

wait
```

**SQL de verificação:**
```sql
SELECT from_number, state_json->>'last_processed_at' AS lock_at
FROM public.conversation_state
WHERE from_number = '5565999990099';
-- Esperado: 1 linha, 1 timestamp (lock único)
```

| Verificação | Esperado | Passou? |
|---|---|---|
| Exatamente 1 resposta com `final_message` não nulo | ✅ | |
| 1 resposta com `actions: [{"type":"cooldown_active"}]` | ✅ | |
| 1 linha em conversation_state | ✅ | |

---

## TESTE 3 — Merge de estado (não apaga dados)

**O que valida:** `updateConversationState` preserva campos anteriores ao fazer merge.

**Ação:**
```bash
# Mensagem 1: intenção de consulta
curl -s -X POST $BASE_URL/process \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"correlation_id":"STATE-001","clinic_id":"'$CLINIC_ID'","from":"'$FROM'","message_text":"quero consulta"}'

sleep 11  # aguardar cooldown de 10s

# Mensagem 2: data
curl -s -X POST $BASE_URL/process \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"correlation_id":"STATE-002","clinic_id":"'$CLINIC_ID'","from":"'$FROM'","message_text":"amanhã de manhã"}'

sleep 11

# Mensagem 3: nome
curl -s -X POST $BASE_URL/process \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"correlation_id":"STATE-003","clinic_id":"'$CLINIC_ID'","from":"'$FROM'","message_text":"me chamo Bruno Silva"}'
```

**SQL de verificação:**
```sql
SELECT state_json
FROM public.conversation_state
WHERE clinic_id = '<CLINIC_ID>'
  AND from_number = '5565999990001';
-- Esperado: state_json tem patient_name, preferred_date E outros campos (não apagados)
```

| Verificação | Esperado | Passou? |
|---|---|---|
| `state_json.patient_name` = "Bruno Silva" | ✅ | |
| `state_json.preferred_date` ainda preenchido | ✅ | |
| `state_json.booking_state` avançou | ✅ | |

---

## TESTE 4 — Turn count incremental

**O que valida:** `increment_conversation_turn` via RPC — não fica parado nem pula.

**SQL de verificação (após 3 mensagens do Teste 3):**
```sql
SELECT id, total_turns, total_messages_user, total_messages_agent
FROM public.conversations
WHERE clinic_id = '<CLINIC_ID>'
  AND patient_phone = '5565999990001'
  AND status = 'open'
ORDER BY started_at DESC
LIMIT 1;
-- Esperado: total_turns = 3, total_messages_user = 3, total_messages_agent = 3
```

| Verificação | Esperado | Passou? |
|---|---|---|
| `total_turns` = número de mensagens enviadas | ✅ | |
| `total_messages_user` > 0 | ✅ | |
| `total_cost_estimated` > 0 | ✅ | |

---

## TESTE 5 — Agendamento completo + appointmentId

**O que valida:** `last_appointment_id` salvo no state e passado ao processPostConversation.

**Ação:** Fazer fluxo completo até confirmar.
```bash
# Requer médico e horário disponível no banco.
# Usar botão de confirmação (intent_override):

curl -s -X POST $BASE_URL/process \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "correlation_id": "BOOK-CONFIRM-001",
    "clinic_id": "'$CLINIC_ID'",
    "from": "'$FROM'",
    "message_text": "Confirmar",
    "intent_override": "confirm_yes"
  }'
```

**SQL de verificação:**
```sql
-- 1. Appointment criado
SELECT id, status, patient_id, doctor_id, appointment_date
FROM public.appointments
WHERE clinic_id = '<CLINIC_ID>'
ORDER BY created_at DESC
LIMIT 1;

-- 2. last_appointment_id salvo no state
SELECT state_json->>'last_appointment_id' AS appt_id,
       state_json->>'booking_state'       AS booking_state
FROM public.conversation_state
WHERE clinic_id = '<CLINIC_ID>'
  AND from_number = '5565999990001';
-- Esperado: appt_id = UUID válido, booking_state = 'booked'

-- 3. CRM event criado (processPostConversation)
SELECT event_type, appointment_id, created_at
FROM public.crm_events
WHERE clinic_id = '<CLINIC_ID>'
ORDER BY created_at DESC
LIMIT 3;
```

| Verificação | Esperado | Passou? |
|---|---|---|
| Appointment criado em `appointments` | ✅ | |
| `state_json.last_appointment_id` = UUID do appointment | ✅ | |
| `crm_events` tem `appointment_id` não nulo | ✅ | |
| Resposta HTTP tem mensagem de confirmação | ✅ | |

---

## TESTE 6 — Timezone da clínica

**O que valida:** Data/hora exibida usa `clinicSettings.timezone` em vez de UTC.

**SQL — verificar timezone configurado:**
```sql
SELECT clinic_id, timezone FROM public.clinic_settings
WHERE clinic_id = '<CLINIC_ID>';
-- Deve ter timezone = 'America/Cuiaba' (UTC-4)
```

**Ação:** Enviar mensagem às 23:00 UTC (= 19:00 Cuiabá).
```bash
curl -s -X POST $BASE_URL/process \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"correlation_id":"TZ-TEST-001","clinic_id":"'$CLINIC_ID'","from":"'$FROM'","message_text":"quero amanhã"}' \
  | grep -o '"final_message":"[^"]*"'
```

| Verificação | Esperado | Passou? |
|---|---|---|
| Data "amanhã" no prompt é dia correto em Cuiabá | ✅ | |
| Dia da semana está correto para a timezone | ✅ | |
| Sem erro de "data no passado" para horários de hoje à noite | ✅ | |

---

## TESTE 7 — Summary cooldown (não dispara toda hora)

**O que valida:** `last_summary_at` impede regeneração de summary em menos de 30 min.

**SQL de verificação:**
```sql
SELECT
  state_json->>'last_summary_at' AS last_summary,
  state_json->>'running_summary' AS summary_preview
FROM public.conversation_state
WHERE clinic_id = '<CLINIC_ID>'
  AND from_number = '5565999990001';
```

**Ação:** Mandar 12 mensagens seguidas (acima do trigger=10).
```bash
for i in $(seq 1 12); do
  sleep 11  # cooldown entre msgs
  curl -s -X POST $BASE_URL/process \
    -H "Content-Type: application/json" \
    -H "x-api-key: $API_KEY" \
    -d '{"correlation_id":"SUM-'$i'","clinic_id":"'$CLINIC_ID'","from":"'$FROM'","message_text":"mensagem '$i'"}'
done
```

| Verificação | Esperado | Passou? |
|---|---|---|
| `last_summary_at` foi registrado apenas 1 vez após 10+ msgs | ✅ | |
| Segunda rodada de 10 msgs NÃO gera novo summary dentro de 30 min | ✅ | |
| `running_summary` tem conteúdo não vazio | ✅ | |

---

## TESTE 8 — LLM recebe mensagem original

**O que valida:** `decide_next_action` agora recebe `{ message, extracted }`.

**Ação:**
```bash
curl -s -X POST $BASE_URL/process \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "correlation_id": "LLM-MSG-001",
    "clinic_id": "'$CLINIC_ID'",
    "from": "'$FROM'",
    "message_text": "quero consulta com dermatologista semana que vem de manhã"
  }' | python3 -m json.tool 2>/dev/null || cat
```

**Verificação visual na resposta:**
| Verificação | Esperado | Passou? |
|---|---|---|
| IA entendeu especialidade (dermatologista) | ✅ | |
| IA entendeu período (manhã) | ✅ | |
| IA entendeu janela temporal (semana que vem) | ✅ | |
| Não perguntou novamente o que o usuário já disse | ✅ | |

---

## TESTE 9 — Rate limit por tenant

**O que valida:** Chave Redis `rl:{clinicId}:{fromNumber}` isola tenants.

**Ação:**
```bash
# Mesmo número, clínica diferente (se tiver 2 clínicas no banco)
CLINIC_2="outro-uuid-da-segunda-clinica"

# Mandar 21 msgs na clínica 1 (limite é 20/min)
for i in $(seq 1 21); do
  curl -s -X POST $BASE_URL/process \
    -H "Content-Type: application/json" \
    -H "x-api-key: $API_KEY" \
    -d '{"correlation_id":"RL-C1-'$i'","clinic_id":"'$CLINIC_ID'","from":"'$FROM'","message_text":"msg"}' \
    | grep -o '"allowed":[^,}]*' &
done
wait

echo "--- Clínica 2 não deve estar limitada ---"
curl -s -X POST $BASE_URL/process \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"correlation_id":"RL-C2-001","clinic_id":"'$CLINIC_2'","from":"'$FROM'","message_text":"msg"}'
```

| Verificação | Esperado | Passou? |
|---|---|---|
| Clínica 1: após 20 msgs, recebe `429` ou mensagem de bloqueio | ✅ | |
| Clínica 2: mesmo número NÃO é afetado pelo limite da clínica 1 | ✅ | |

---

## TESTE 10 — Redis singleton (sem conexão dupla)

**O que valida:** `connectionPromise` evita dois clientes Redis simultâneos no boot.

**Ação:** Verificar logs no boot do serviço.
```bash
# Railway logs (ou docker logs)
railway logs --tail 50 | grep -i redis
```

| Verificação | Esperado | Passou? |
|---|---|---|
| Apenas 1 mensagem `[Redis] Conectado com sucesso` | ✅ | |
| Sem erros de "already connected" | ✅ | |
| Sem mensagem `[Redis] Falha ao reconectar` no boot normal | ✅ | |

---

## TESTE 11 — Performance de busca de datas (N+1 fix)

**O que valida:** `buscarProximasDatasDisponiveis` usa 4 queries em vez de 90.

**Ação:**
```bash
# Checar latência com days=30
time curl -s -X POST $BASE_URL/process \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "correlation_id": "PERF-001",
    "clinic_id": "'$CLINIC_ID'",
    "from": "'$FROM'",
    "message_text": "quais os próximos 30 dias disponíveis"
  }' > /dev/null
```

**SQL de verificação (Supabase — aba Logs > API):**
```
Filtrar por: buscar_proximas_datas ou verificar_disponibilidade
Contar quantas queries foram feitas por request
```

| Verificação | Esperado | Passou? |
|---|---|---|
| Latência < 2s (antes era > 5s com 90 queries) | ✅ | |
| Logs mostram no máximo 4-5 queries para a função | ✅ | |
| Resultado correto com datas disponíveis | ✅ | |

---

## TESTE 12 — Novo usuário: primeiro greeting

**O que valida:** Lock + state criado corretamente para usuário nunca visto.

**Ação:**
```bash
FROM_BRAND_NEW="5565999990123"

curl -s -X POST $BASE_URL/process \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{
    "correlation_id": "NEW-USER-001",
    "clinic_id": "'$CLINIC_ID'",
    "from": "'$FROM_BRAND_NEW'",
    "message_text": "oi"
  }'
```

**SQL de verificação:**
```sql
SELECT from_number,
       state_json->>'booking_state'     AS booking_state,
       state_json->>'last_processed_at' AS lock_acquired,
       turn_count
FROM public.conversation_state
WHERE from_number = '5565999990123';
-- Esperado: 1 linha, booking_state = 'idle', lock_acquired preenchido
```

| Verificação | Esperado | Passou? |
|---|---|---|
| 1 linha criada em conversation_state | ✅ | |
| Greeting enviado sem duplicar | ✅ | |
| `booking_state` = 'idle' | ✅ | |
| `turn_count` = 1 | ✅ | |

---

## Resumo final

| # | Teste | Status |
|---|-------|--------|
| 1 | Mensagem duplicada (inbound_dedup) | ⬜ |
| 2 | Lock concorrente (novos usuários) | ⬜ |
| 3 | Merge de estado | ⬜ |
| 4 | Turn count incremental | ⬜ |
| 5 | Agendamento completo + appointmentId | ⬜ |
| 6 | Timezone da clínica | ⬜ |
| 7 | Summary cooldown | ⬜ |
| 8 | LLM recebe mensagem original | ⬜ |
| 9 | Rate limit por tenant | ⬜ |
| 10 | Redis singleton | ⬜ |
| 11 | Performance busca de datas | ⬜ |
| 12 | Novo usuário: primeiro greeting | ⬜ |

**Meta: 12/12 ✅**
