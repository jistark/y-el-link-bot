import { createBot } from './bot.js';

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error('Error: TELEGRAM_BOT_TOKEN no está configurado');
  process.exit(1);
}

const bot = createBot(token);

console.log('Bot iniciando...');
bot.start();
