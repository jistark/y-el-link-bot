import { MATCHES, INAUGURAL, TEAM_ALIASES, type Match } from '../data/mundial.js';

const CHILE_TZ = 'America/Santiago';

const MONTH_NAMES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

// Obtener fecha actual en Chile como 'YYYY-MM-DD'
export function getChileDate(offset = 0): string {
  const now = new Date();
  now.setDate(now.getDate() + offset);
  return now.toLocaleDateString('en-CA', { timeZone: CHILE_TZ }); // 'YYYY-MM-DD'
}

// Obtener hora Chile actual como 'HH:mm'
export function getChileTimeNow(): string {
  return new Date().toLocaleTimeString('en-GB', { timeZone: CHILE_TZ, hour: '2-digit', minute: '2-digit' });
}

// Fecha formateada para display: "miércoles 11 de junio"
function formatDateLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const dayName = DAY_NAMES[date.getDay()];
  const monthName = MONTH_NAMES[m - 1];
  return `${dayName} ${d} de ${monthName}`;
}

export function getMatchesForDate(date: string): Match[] {
  return MATCHES.filter(m => m.date === date);
}

export function getMatchesForWeek(today: string): Match[] {
  const start = new Date(today + 'T00:00:00');
  const dayOfWeek = start.getDay(); // 0=dom
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(start);
  monday.setDate(monday.getDate() + mondayOffset);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);

  const mondayStr = monday.toISOString().slice(0, 10);
  const sundayStr = sunday.toISOString().slice(0, 10);

  return MATCHES.filter(m => m.date >= mondayStr && m.date <= sundayStr);
}

function resolveTeam(input: string): string | null {
  const normalized = input.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Buscar en aliases (sin tildes)
  for (const [alias, team] of Object.entries(TEAM_ALIASES)) {
    const aliasNorm = alias.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (aliasNorm === normalized) return team;
  }

  // Buscar directamente en nombres de equipos (match parcial)
  for (const match of MATCHES) {
    for (const team of [match.team1, match.team2]) {
      const teamNorm = team.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (teamNorm === normalized || teamNorm.includes(normalized)) return team;
    }
  }

  return null;
}

export function getMatchesForTeam(input: string): { team: string; matches: Match[] } | null {
  const team = resolveTeam(input);
  if (!team) return null;
  const matches = MATCHES.filter(m => m.team1 === team || m.team2 === team);
  return { team, matches };
}

function formatChannel(channels: Match['channels']): string {
  return channels.join(' | ');
}

function channelTag(m: Match): string {
  return m.channels.includes('ChileVisión') ? '  \u{1F4E1} TV abierta' : '';
}

function formatMatchLine(m: Match): string {
  return `\u{1F552} ${m.time} \u2014 ${m.team1} vs ${m.team2}  <i>(Grupo ${m.group})</i>\n   \u{1F4FA} ${formatChannel(m.channels)}${channelTag(m)}`;
}

export function formatMatchesForDate(matches: Match[], date: string, label: string): string {
  if (matches.length === 0) {
    return `\u26BD <b>Mundial 2026</b> \u2014 ${label}\n\nNo hay partidos programados.`;
  }

  const dateLabel = formatDateLabel(date);
  const lines = matches.map(m => formatMatchLine(m));
  const count = matches.length === 1 ? '1 partido' : `${matches.length} partidos`;

  return `\u26BD <b>Mundial 2026</b> \u2014 ${label}, ${dateLabel}\n\n${lines.join('\n\n')}\n\n<i>(${count})</i>`;
}

export function formatMatchesForWeek(matches: Match[]): string {
  if (matches.length === 0) {
    return '\u26BD <b>Mundial 2026</b> \u2014 Esta semana\n\nNo hay partidos esta semana.';
  }

  const byDate = new Map<string, Match[]>();
  for (const m of matches) {
    const list = byDate.get(m.date) || [];
    list.push(m);
    byDate.set(m.date, list);
  }

  const sections: string[] = [];
  for (const [date, dayMatches] of byDate) {
    const header = `\u{1F4C5} <b>${formatDateLabel(date)}</b>`;
    const lines = dayMatches.map(m => formatMatchLine(m));
    sections.push(`${header}\n${lines.join('\n')}`);
  }

  const count = matches.length === 1 ? '1 partido' : `${matches.length} partidos`;
  return `\u26BD <b>Mundial 2026</b> \u2014 Esta semana\n\n${sections.join('\n\n')}\n\n<i>(${count})</i>`;
}

export function formatMatchesForTeam(team: string, matches: Match[]): string {
  if (matches.length === 0) {
    return `\u26BD <b>Mundial 2026</b> \u2014 ${team}\n\nNo se encontraron partidos.`;
  }

  const lines = matches.map(m => {
    const dateLabel = formatDateLabel(m.date);
    return `\u{1F4C5} ${dateLabel}\n\u{1F552} ${m.time} \u2014 ${m.team1} vs ${m.team2}  <i>(Grupo ${m.group})</i>\n\u{1F4FA} ${formatChannel(m.channels)}${channelTag(m)}`;
  });

  return `\u26BD <b>Mundial 2026</b> \u2014 ${team}\n\n${lines.join('\n\n')}\n\n<i>(${matches.length} partidos en fase de grupos)</i>`;
}

export function getCountdown(): string | null {
  const inaugural = new Date(INAUGURAL);
  const now = new Date();
  if (now >= inaugural) return null;

  const diff = inaugural.getTime() - now.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  const parts: string[] = [];
  if (days > 0) parts.push(`<b>${days}</b> día${days !== 1 ? 's' : ''}`);
  if (hours > 0) parts.push(`<b>${hours}</b> hora${hours !== 1 ? 's' : ''}`);
  if (minutes > 0) parts.push(`<b>${minutes}</b> minuto${minutes !== 1 ? 's' : ''}`);

  return [
    '\u26BD <b>Copa Mundial FIFA 2026</b>',
    '',
    `Faltan ${parts.join(', ')} para el partido inaugural`,
    '',
    '\u{1F3DF}\uFE0F México vs Sudáfrica',
    '\u{1F4C5} Miércoles 11 de junio, 15:00 hrs',
    '\u{1F4FA} DSports | ChileVisión',
  ].join('\n');
}

export function getAllTeams(): string[] {
  const teams = new Set<string>();
  for (const m of MATCHES) {
    teams.add(m.team1);
    teams.add(m.team2);
  }
  return [...teams].sort();
}

// Para notificaciones automáticas
export function formatNotification(matches: Match[]): string {
  const lines = matches.map(m => {
    return `\u{1F552} ${m.time} \u2014 <b>${m.team1} vs ${m.team2}</b>  <i>(Grupo ${m.group})</i>\n\u{1F4FA} ${formatChannel(m.channels)}${channelTag(m)}`;
  });

  const header = matches.length === 1 ? 'Partido en 2 horas' : `${matches.length} partidos en 2 horas`;

  return `\u26BD <b>${header}</b>\n\n${lines.join('\n\n')}\n\n\u{1F3DF}\uFE0F Copa Mundial FIFA 2026`;
}

// Obtener partidos que empiezan a una hora específica
export function getMatchesAtTime(date: string, time: string): Match[] {
  return MATCHES.filter(m => m.date === date && m.time === time);
}
