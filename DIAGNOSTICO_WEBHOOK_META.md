# Diagnóstico: webhook-meta-production
Data: 2026-04-16 17:35 UTC

---

## 1. Status HTTP do endpoint

### Teste 1 — HEAD /webhook
```
HTTP/2 503
content-length: 18
content-type: text/plain
date: Thu, 16 Apr 2026 17:30:59 GMT
```

### Teste 2 — GET /webhook?hub.mode=subscribe&hub.challenge=test123&hub.verify_token=fake
```
HTTP/2 503
content-length: 18
content-type: text/plain
body: DNS cache overflow
date: Thu, 16 Apr 2026 17:31:01 GMT
```

### Teste 3 — POST /webhook (simula evento Meta)
```
HTTP/2 503
content-length: 18
content-type: text/plain
body: DNS cache overflow
```

### Teste 4 — GET / (raiz — para isolar se o processo está vivo)
```
HTTP/2 200
content-type: text/html; charset=utf-8
x-powered-by: Express
content-length: 2
body: OK
tempo de resposta: 1.19s
```

### Teste 5 — GET /health
```
HTTP/2 404
body: Cannot GET /health
```

**Interpretação:**
- O processo Express está **VIVO** e respondendo na raiz (`/` → 200 OK).
- **Todos** os paths `/webhook` (GET, HEAD, POST) retornam **503 "DNS cache overflow"**.
- `DNS cache overflow` é um erro interno do Node.js que ocorre quando o processo tenta resolver muitos hostnames distintos e o cache DNS interno fica saturado. Isso indica que o handler `/webhook` está tentando conectar a algum serviço externo (ex: n8n, CLINICORE, Supabase) via hostname, e essa resolução DNS está falhando.
- O `/health` retorna 404 — esse path não existe no serviço.

**Conclusão:** Endpoint `/webhook` — **MORTO** ❌ (processo vivo, mas handler com falha crítica de DNS)

---

## 2. Status do serviço Railway

> **Railway MCP não está disponível nesta sessão.** Os passos 2 e 3 foram parcialmente executados via HTTP direto.

- **Service ID:** não obtido (Railway MCP indisponível)
- **Status inferido:** RUNNING (processo responde na raiz), mas handler em falha
- **Último deploy:** não obtido (Railway MCP indisponível)
- **Env vars configuradas (nomes):** não obtido (Railway MCP indisponível)

**O que se pode inferir pelos headers HTTP:**
```
server: railway-edge
x-railway-edge: railway/us-east4-eqdc4a
x-powered-by: Express
x-railway-cdn-edge: fastly/cache-chi-kigq8000102-CHI
```
O serviço está deployado na região `us-east4` (GCP / eqdc4a), atrás do Fastly CDN do Railway.

---

## 3. Logs do serviço (últimas 2h)

> **Railway MCP não disponível** — logs não puderam ser puxados diretamente.

**O que se pode inferir do comportamento HTTP:**
- O processo Node/Express inicializou com sucesso (rota `/` funcional).
- O handler `/webhook` está lançando um erro `DNS cache overflow` que resulta em 503. Esse erro é repetível e consistente — não é intermitente. Todos os 3 métodos testados (HEAD, GET, POST) falham igualmente.
- Não é possível confirmar requests anteriores da Meta sem acesso aos logs.
- Não é possível confirmar eventos `account_update` históricos sem acesso aos logs.

- Erros encontrados: **sim** — `DNS cache overflow` em todos os requests `/webhook`
- Requests da Meta recebidos (últimas 2h): não verificável
- Eventos account_update no histórico: não verificável

---

## 4. Código-fonte

### 4a. Repositório `webhook-meta` (serviço-alvo do diagnóstico)

> O código do serviço `webhook-meta-production` está no repositório **separado** `gvasques77-sys/webhook-meta` (criado em 2026-02-07, última atualização 2026-02-10, JavaScript).
>
> **Acesso negado pela política desta sessão** — apenas o repo `gvasques77-sys/juca-guarana-v2` está autorizado para GitHub MCP.

- **Handler POST /webhook:** não verificável (repo restrito) — comportamento HTTP confirma que o Express **roteia** o path (retorna 503, não 404)
- **Handler GET /webhook (verificação):** não verificável (repo restrito) — comportamento HTTP confirma que o Express **roteia** o path (retorna 503, não 404)
- **Tratamento de account_update:** não verificável
- **Destino dos eventos:** não verificável diretamente — mas o erro `DNS cache overflow` fortemente sugere forward para serviço externo (n8n, CLINICORE, ou Supabase) via hostname que não resolve

### 4b. Repositório `JUCA-GUARANA-V2` (CLINICORE principal — inspecionado integralmente)

O CLINICORE **NÃO é um webhook receiver da Meta**. Ele expõe um endpoint `/process` (não `/webhook`) que recebe mensagens **já processadas pelo N8n**.

**Arquitetura real do fluxo:**
```
Meta Cloud API
      ↓
webhook-meta-production  ← Este serviço (tem /webhook, está com 503)
      ↓
   N8n (processa hub.challenge, filtra eventos)
      ↓
POST /process  ← CLINICORE/JUCA-GUARANA-V2 (recebe envelope do N8n)
      ↓
Supabase + OpenAI + Meta Graph API (envio de resposta)
```

O CLINICORE (`server.js`, 6072 linhas):
- **NÃO tem** handler GET `/webhook`
- **NÃO tem** handler POST `/webhook`
- **NÃO processa** eventos `account_update`
- Valida assinatura HMAC via `X-Webhook-Signature` no `/process` (gerada pelo N8n, não pela Meta)

**Env vars do CLINICORE** (para referência, pois podem ser compartilhadas com o webhook-meta):
```
AGENT_API_KEY, AGENT_MAX_STEPS, AGENT_TIMEOUT_MS, ALLOWED_ORIGINS,
CLINIC_ID, DEBUG, DEFAULT_CLINIC_ID, ENABLE_AGENT_DECISION_LOGS,
META_API_VERSION, META_PHONE_NUMBER_ID, META_WA_TOKEN,
N8N_WEBHOOK_SECRET, NODE_ENV, OPENAI_API_KEY, OPENAI_BASE_URL,
OPENAI_MODEL, PORT, SENTRY_DSN, SENTRY_ENVIRONMENT,
SESSION_COOLDOWN_MS, SESSION_TIMEOUT_HOURS, SUPABASE_SERVICE_ROLE_KEY,
SUPABASE_URL, SUMMARY_TRIGGER_MESSAGES, WHATSAPP_ACCESS_TOKEN,
WHATSAPP_BUSINESS_ACCOUNT_ID, WHATSAPP_PHONE_NUMBER_ID,
WHATSAPP_TEMPLATE_POST_CONSULTATION, WHATSAPP_TEMPLATE_REACTIVATION
```

### Pista importante sobre a causa raiz do 503

O erro `DNS cache overflow` do Node.js ocorre quando o processo tenta resolver um hostname e o cache DNS interno está saturado. Cenários prováveis:

1. **Hostname Railway interno inválido:** O `webhook-meta-production` tenta fazer forward para outro serviço Railway via URL `*.railway.internal` ou `*.up.railway.app` que foi **renomeado, removido, ou está em projeto diferente**. Ao tentar resolver esse hostname em toda requisição, o cache DNS do Node.js estoura.
2. **URL do N8n alterada:** Se a instância N8n mudou de hostname (comum em redeploys no Railway), a env var com a URL do N8n no `webhook-meta-production` ficou desatualizada.
3. **Env var vazia ou malformada:** Se a URL de destino está vazia/inválida, o Node.js pode tentar resolver um hostname inválido repetidamente.

---

## 5. Teste de verificação Meta (end-to-end)

> **Não executável** — Railway MCP indisponível para obter o `VERIFY_TOKEN` real das env vars.
> O endpoint `/webhook` retorna 503 em qualquer requisição, portanto mesmo com o token correto o teste falharia.

- **Retornou challenge corretamente:** **NÃO** ❌
- Qualquer requisição de verificação Meta para este endpoint receberia `503 DNS cache overflow` ao invés do `hub.challenge`.

---

## VEREDICTO

> ## ⛔ NÃO SEGURO para assinar novos campos de webhook na Meta.

**Motivo:** O endpoint `/webhook` está retornando HTTP 503 em 100% das requisições. Se você assinar novos campos (ex: `account_update`, `message_echoes`, `messaging_postbacks`) agora:

1. A Meta enviará eventos para o endpoint e receberá 503 repetidamente.
2. Após falhas consecutivas, a Meta pode **desinscrever automaticamente todos os campos** do webhook — incluindo o `messages` que hoje mantém a Lara funcionando.
3. A verificação do webhook (GET com hub.challenge) também falha, o que impede inclusive reconfigurar o webhook no painel.

---

## AÇÕES RECOMENDADAS

### Prioridade CRÍTICA (antes de qualquer mudança na Meta)

1. **Corrigir o erro `DNS cache overflow` no serviço `webhook-meta-production`:**
   - Acessar o Railway dashboard e verificar os logs do serviço nas últimas horas.
   - Identificar qual hostname o handler `/webhook` tenta resolver (provável: outro serviço Railway, n8n, ou CLINICORE).
   - Verificar se esse serviço-destino ainda existe e está com o mesmo hostname/URL.
   - Se a URL do serviço-destino mudou, atualizar a env var correspondente no `webhook-meta-production`.

2. **Verificar as env vars do serviço `webhook-meta-production` no Railway:**
   - Confirmar que `VERIFY_TOKEN` está configurado.
   - Confirmar que a URL de destino dos eventos (ex: `N8N_URL`, `CLINICORE_URL`, `WEBHOOK_FORWARD_URL`) aponta para um serviço ativo e acessível.

3. **Após corrigir, re-executar o teste de verificação:**
   ```bash
   curl -i "https://webhook-meta-production-dee6.up.railway.app/webhook?hub.mode=subscribe&hub.challenge=challenge_test_123&hub.verify_token=<VERIFY_TOKEN_REAL>"
   ```
   Deve retornar: `HTTP 200` com body `challenge_test_123`.

4. **Somente após receber HTTP 200 com o challenge correto**, assinar novos campos no painel Meta for Developers.

### Informação adicional

- O repositório do serviço é `gvasques77-sys/webhook-meta` (privado, JavaScript, criado 2026-02-07).
- O código-fonte precisa ser revisado para identificar para onde o handler repassa os eventos e por que a resolução DNS está falhando.
- Se o `account_update` não estiver tratado no código, ele precisará ser adicionado **antes** de assinar o campo na Meta.

---

*Diagnóstico executado por Claude Code em 2026-04-16. Railway MCP indisponível; passos 2, 3 e 5 executados parcialmente via HTTP direto. Acesso ao repo `webhook-meta` negado pela política da sessão — etapa 4 baseada em inferência comportamental.*
