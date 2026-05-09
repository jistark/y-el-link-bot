import type { Bot } from 'grammy';

/**
 * Resilient sendMessage: retries without `message_thread_id` if Telegram
 * rejects the thread. Telegram occasionally returns "message thread not
 * found" for valid topics during topic creation/migration races; falling
 * back to the chat root preserves the message at the cost of correct
 * thread placement.
 */
export async function safeSendMessage(
  api: Bot['api'],
  chatId: number,
  text: string,
  options?: Record<string, any>
) {
  try {
    return await api.sendMessage(chatId, text, options);
  } catch (err: any) {
    if (err?.description?.includes('message thread not found') && options?.message_thread_id) {
      const { message_thread_id, ...rest } = options;
      console.log(JSON.stringify({
        event: 'thread_fallback', action: 'sendMessage',
        threadId: message_thread_id, chatId,
        timestamp: new Date().toISOString(),
      }));
      return await api.sendMessage(chatId, text, rest);
    }
    throw err;
  }
}
