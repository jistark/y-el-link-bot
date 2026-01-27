import { createBot } from './bot.js';
import { webhookCallback } from 'grammy';

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error('Error: TELEGRAM_BOT_TOKEN no está configurado');
  process.exit(1);
}

const bot = createBot(token);

// Modo: webhook (producción) o polling (desarrollo)
const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (WEBHOOK_URL) {
  // Producción: webhook con Bun.serve
  const handleUpdate = webhookCallback(bot, 'std/http');
  const PORT = parseInt(process.env.PORT || '10000');

  const server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);

      // Health check para Render
      if (url.pathname === '/health' || url.pathname === '/') {
        return new Response('OK', { status: 200 });
      }

      // Webhook de Telegram
      if (req.method === 'POST' && url.pathname === '/webhook') {
        return handleUpdate(req);
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  // Configurar webhook en Telegram
  await bot.api.setWebhook(`${WEBHOOK_URL}/webhook`);
  console.log(`Bot corriendo en webhook mode (puerto ${PORT})`);

} else {
  // Desarrollo: polling
  const shutdown = () => {
    console.log('Apagando bot...');
    bot.stop();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log('Bot iniciando en polling mode...');
  bot.start();
}
