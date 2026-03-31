// Horóscopo de Yolanda Sultana desde primedigital.cl
import { fetchBypass } from '../extractors/fetch-bypass.js';

const DAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

interface SignoInfo {
  id: string;
  name: string;
  emoji: string;
  aliases: string[];
}

const SIGNOS: SignoInfo[] = [
  { id: 'aries', name: 'Aries', emoji: '♈', aliases: [] },
  { id: 'tauro', name: 'Tauro', emoji: '♉', aliases: ['taurus'] },
  { id: 'geminis', name: 'Géminis', emoji: '♊', aliases: ['gemini', 'géminis'] },
  { id: 'cancer', name: 'Cáncer', emoji: '♋', aliases: ['cáncer'] },
  { id: 'leo', name: 'Leo', emoji: '♌', aliases: [] },
  { id: 'virgo', name: 'Virgo', emoji: '♍', aliases: [] },
  { id: 'libra', name: 'Libra', emoji: '♎', aliases: [] },
  { id: 'escorpio', name: 'Escorpio', emoji: '♏', aliases: ['escorpion', 'escorpión'] },
  { id: 'sagitario', name: 'Sagitario', emoji: '♐', aliases: [] },
  { id: 'capricornio', name: 'Capricornio', emoji: '♑', aliases: [] },
  { id: 'acuario', name: 'Acuario', emoji: '♒', aliases: [] },
  { id: 'piscis', name: 'Piscis', emoji: '♓', aliases: [] },
];

interface HoroscopoEntry {
  amor: string;
  salud: string;
  dinero: string;
  color: string;
  numero: string;
}

interface HoroscopoData {
  date: string; // "Lunes 23 de Marzo 2026"
  signos: Map<string, HoroscopoEntry>;
}

// Cache por fecha (YYYY-MM-DD)
const cache = new Map<string, { data: HoroscopoData; expires: number }>();
const TTL = 24 * 60 * 60 * 1000;

// Cleanup cada hora
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of cache) {
    if (value.expires < now) cache.delete(key);
  }
}, 60 * 60 * 1000);

function findSigno(input: string): SignoInfo | null {
  const normalized = input.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // quitar acentos

  for (const signo of SIGNOS) {
    const signoNorm = signo.id.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (signoNorm === normalized) return signo;
    if (signo.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') === normalized) return signo;
    for (const alias of signo.aliases) {
      if (alias.normalize('NFD').replace(/[\u0300-\u036f]/g, '') === normalized) return signo;
    }
  }
  return null;
}

// URL estable que siempre redirige al horóscopo más reciente
const HOROSCOPO_URL = 'https://primedigital.cl/horoscopo/';

function extractDateFromSlug(finalUrl: string): string {
  // Extraer fecha del slug: horoscopo-lunes-23-de-marzo-2026
  const match = finalUrl.match(/horoscopo-(\w+)-(\d+)-de-(\w+)-(\d+)/);
  if (match) {
    const [, dayName, day, month, year] = match;
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    return `${cap(dayName)} ${day} de ${cap(month)} ${year}`;
  }
  // Fallback: fecha de hoy en Chile
  const now = new Date();
  const chileNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Santiago' }));
  const dayName = DAYS[chileNow.getDay()];
  const monthName = MONTHS[chileNow.getMonth()];
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return `${cap(dayName)} ${chileNow.getDate()} de ${cap(monthName)} ${chileNow.getFullYear()}`;
}

function parseHoroscopo(html: string, dateLabel: string): HoroscopoData {
  const signos = new Map<string, HoroscopoEntry>();

  // Extraer el contenido del post (div con clase elementor-widget-theme-post-content)
  const contentMatch = html.match(
    /class="[^"]*elementor-widget-theme-post-content[^"]*"[^>]*>[\s\S]*?<div[^>]*class="[^"]*elementor-widget-container[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i
  );

  const content = contentMatch ? contentMatch[1] : html;

  // Limpiar HTML: quitar tags excepto texto
  const text = content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .trim();

  // Buscar cada signo en el texto
  for (let i = 0; i < SIGNOS.length; i++) {
    const signo = SIGNOS[i];
    const nextSigno = SIGNOS[i + 1];

    // Buscar el bloque de este signo (desde su nombre hasta el siguiente signo o fin)
    const signoPattern = new RegExp(
      signo.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '.?') + '[:\\s]',
      'i'
    );
    const startIdx = text.search(signoPattern);
    if (startIdx === -1) continue;

    let endIdx = text.length;
    if (nextSigno) {
      const nextPattern = new RegExp(
        nextSigno.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '.?') + '[:\\s]',
        'i'
      );
      const nextIdx = text.slice(startIdx + 1).search(nextPattern);
      if (nextIdx !== -1) endIdx = startIdx + 1 + nextIdx;
    }

    const block = text.slice(startIdx, endIdx).trim();

    // Extraer cada categoría
    const amor = extractCategory(block, 'AMOR');
    const salud = extractCategory(block, 'SALUD');
    const dinero = extractCategory(block, 'DINERO');
    const color = extractCategory(block, 'COLOR');
    const numero = extractCategory(block, 'NUMERO');

    signos.set(signo.id, { amor, salud, dinero, color, numero });
  }

  return { date: dateLabel, signos };
}

function extractCategory(block: string, category: string): string {
  // Buscar "AMOR:" o "AMOR :" seguido del texto hasta la siguiente categoría o fin de línea
  const pattern = new RegExp(
    category + '\\s*:?\\s*(.+?)(?=(?:AMOR|SALUD|DINERO|COLOR|NUMERO)\\s*:|$)',
    'is'
  );
  const match = block.match(pattern);
  return match ? match[1].trim() : '';
}

async function fetchAndParse(): Promise<HoroscopoData> {
  // Revisar cache (usar fecha Chile, no UTC)
  const chileNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Santiago' }));
  const today = `${chileNow.getFullYear()}-${String(chileNow.getMonth() + 1).padStart(2, '0')}-${String(chileNow.getDate()).padStart(2, '0')}`;
  const cached = cache.get(today);
  if (cached && cached.expires > Date.now()) {
    return cached.data;
  }

  // Seguir redirect de /horoscopo/ al post más reciente
  let html: string;
  let finalUrl: string;
  try {
    const response = await fetch(HOROSCOPO_URL, {
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    finalUrl = response.url;
    html = await response.text();
  } catch {
    // Fallback: curl_cffi for bot detection bypass
    html = await fetchBypass(HOROSCOPO_URL);
    // Extract final URL from HTML since fetchBypass follows redirects
    const canonicalMatch = html.match(/<link[^>]*rel="canonical"[^>]*href="([^"]+)"/i);
    finalUrl = canonicalMatch?.[1] || HOROSCOPO_URL;
  }
  const dateLabel = extractDateFromSlug(finalUrl);
  const data = parseHoroscopo(html, dateLabel);

  if (data.signos.size === 0) {
    throw new Error('No se encontraron signos en la página');
  }

  // Guardar en cache
  cache.set(today, { data, expires: Date.now() + TTL });

  return data;
}

export function getSignosList(): string {
  return SIGNOS.map(s => `${s.emoji} ${s.name}`).join('\n');
}

export async function getHoroscopo(input: string): Promise<string> {
  const signo = findSigno(input);
  if (!signo) {
    return `❌ Signo no reconocido: <b>${input}</b>\n\n🔮 Signos disponibles:\n${getSignosList()}`;
  }

  const data = await fetchAndParse();
  const entry = data.signos.get(signo.id);

  if (!entry) {
    return `❌ No encontré el horóscopo de ${signo.name} para hoy.`;
  }

  const lines = [
    `🔮 <b>Horóscopo de ${signo.name}</b> ${signo.emoji}`,
    `📅 ${data.date}`,
    '',
  ];

  if (entry.amor) lines.push(`❤️ <b>AMOR:</b> ${entry.amor}`);
  if (entry.salud) lines.push(`🏥 <b>SALUD:</b> ${entry.salud}`);
  if (entry.dinero) lines.push(`💰 <b>DINERO:</b> ${entry.dinero}`);
  if (entry.color) lines.push(`🎨 <b>COLOR:</b> ${entry.color}`);
  if (entry.numero) lines.push(`🔢 <b>NÚMERO:</b> ${entry.numero}`);

  lines.push('');
  lines.push('<i>🌭 Fuente: Yolanda Sultana (primedigital.cl)</i>');

  return lines.join('\n');
}
