// services/whatsappTyping.js
// Utilitário para simular digitação da secretaria IA no WhatsApp

/**
 * Marca a mensagem como lida (exibe ✓✓ azul + ativa "..." no cliente)
 * e aguarda um delay para simular digitação.
 *
 * IMPORTANTE: Falhas aqui não devem interromper o fluxo principal.
 *
 * @param {string} phoneNumberId - ID do número de telefone da clínica (WABA)
 * @param {string} messageId     - ID da mensagem recebida do paciente
 * @param {string} accessToken   - Token de acesso da clínica
 * @param {number} delayMs       - Tempo de espera em ms (padrão: 2000)
 */
export async function markAsReadAndSimulateTyping(
  phoneNumberId,
  messageId,
  accessToken,
  delayMs = 2000
) {
  try {
    const response = await fetch(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.warn('[TypingIndicator] Falha ao marcar como lida:', err);
    }
  } catch (error) {
    // Falha silenciosa — nunca interrompe o fluxo principal
    console.warn('[TypingIndicator] Erro silencioso:', error.message);
  }

  // Delay para simular digitação, independente do resultado acima
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
