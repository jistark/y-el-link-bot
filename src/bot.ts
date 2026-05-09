import { Bot } from 'grammy';
import { registerCallbackDispatcher } from './bot/callbacks/dispatcher.js';
import { registerMessageHandler } from './bot/handlers/message-text.js';
import { setupErrorHandler, setupThreadPreservation } from './bot/setup.js';
import { registerDolarCommand } from './commands/dolar.js';
import { registerDonarCommand } from './commands/donar.js';
import { registerEncuestaCommand } from './commands/encuesta.js';
import { registerHoroscopoCommand } from './commands/horoscopo-bot.js';
import { registerMundialCommand, startMundialNotifier } from './commands/mundial-bot.js';
import { registerRatingCommands } from './commands/rating.js';
import { registerUltimoCommand } from './commands/ultimo.js';
import { startAdprensaPoller } from './services/adprensa-poller.js';
import { startFotoportadasPoller } from './services/fotoportadas-poller.js';
import { startRssPoller } from './services/rss-poller.js';


export function createBot(token: string): Bot {
  const bot = new Bot(token);

  // Bot-wide concerns — see src/bot/setup.ts.
  setupThreadPreservation(bot);
  setupErrorHandler(bot);

  // Each register* function registers one cohesive command/feature on the bot.
  // Order doesn't matter functionally; grouped here by domain for readability.
  registerRatingCommands(bot);
  registerEncuestaCommand(bot);
  registerDolarCommand(bot);
  registerDonarCommand(bot);
  registerHoroscopoCommand(bot);
  registerMundialCommand(bot);
  startMundialNotifier(bot);
  registerUltimoCommand(bot);

  // URL-extraction message handler + inline-button dispatcher.
  registerMessageHandler(bot);
  registerCallbackDispatcher(bot);

  // RSS pollers for private channel
  startRssPoller(bot.api).catch(err =>
    console.error(JSON.stringify({ event: 'rss_poller_fatal', error: err?.message || String(err), timestamp: new Date().toISOString() })));
  startAdprensaPoller(bot.api).catch(err =>
    console.error(JSON.stringify({ event: 'adprensa_poller_fatal', error: err?.message || String(err), timestamp: new Date().toISOString() })));
  startFotoportadasPoller(bot.api).catch(err =>
    console.error(JSON.stringify({ event: 'fotoportadas_poller_fatal', error: err?.message || String(err), timestamp: new Date().toISOString() })));

  return bot;
}

