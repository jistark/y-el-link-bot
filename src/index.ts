import { createBot } from './bot.js';

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error('Error: TELEGRAM_BOT_TOKEN no está configurado');
  process.exit(1);
}

const bot = createBot(token);

// Graceful shutdown para Render/Docker
const shutdown = () => {
  console.log('Apagando bot...');
  bot.stop();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log('Bot iniciando...');
bot.start();
