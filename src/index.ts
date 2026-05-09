import { createBot } from './bot.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
const webhookSecret = process.env.WEBHOOK_SECRET || crypto.randomUUID();

if (!token) {
  console.error('Error: TELEGRAM_BOT_TOKEN no está configurado');
  process.exit(1);
}

const bot = createBot(token);

// Registrar comandos en el menú de Telegram
await bot.api.setMyCommands([
  { command: 'rz', description: 'Rating de canales de TV (Zapping)' },
  { command: 'ryt', description: 'Rating de streams chilenos en YouTube' },
  { command: 'dolar', description: 'Precio del dólar en Chile' },
  { command: 'tiayoli', description: 'Horóscopo de Yolanda Sultana' },
  { command: 'donar', description: 'Apoyar la mantención del bot' },
  { command: 'mundial', description: 'Partidos del Mundial FIFA 2026' },
]);

// Modo: webhook (producción) o polling (desarrollo)
const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (WEBHOOK_URL) {
  // Producción: webhook con Bun.serve
  const PORT = parseInt(process.env.PORT || '10000');

  const server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url);

      // Health check para Render
      if (url.pathname === '/health' || url.pathname === '/') {
        return new Response('OK', { status: 200 });
      }

      // Webhook de Telegram (verificar secret token)
      if (req.method === 'POST' && url.pathname === '/webhook') {
        if (req.headers.get('x-telegram-bot-api-secret-token') !== webhookSecret) {
          return new Response('Forbidden', { status: 403 });
        }
        // Fire-and-forget: ack a Telegram al toque y procesa la actualización en
        // background. Si esperamos la extracción + subidas a Telegraph, grammy
        // expira a los 10 s y Telegram reintenta (mensajes duplicados).
        try {
          const update = await req.json();
          bot.handleUpdate(update).catch(err =>
            console.error(JSON.stringify({
              event: 'webhook_handler_failed',
              error: err instanceof Error ? err.message : String(err),
              timestamp: new Date().toISOString(),
            }))
          );
        } catch (err) {
          console.error(JSON.stringify({
            event: 'webhook_parse_failed',
            error: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }));
        }
        return new Response('', { status: 200 });
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  // Configurar webhook en Telegram (con secret token para validar origen)
  await bot.api.setWebhook(`${WEBHOOK_URL}/webhook`, { secret_token: webhookSecret });
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

  // Verificar si hay webhook activo antes de iniciar polling
  const webhookInfo = await bot.api.getWebhookInfo();
  if (webhookInfo.url) {
    console.warn(`⚠️  Webhook activo detectado: ${webhookInfo.url}`);
    console.warn('   Iniciar polling desactivará el webhook de producción.');
    console.warn('   Presiona Ctrl+C en 3 segundos para cancelar...');
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  console.log('Bot iniciando en polling mode...');
  bot.start();
}
