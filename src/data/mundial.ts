export interface Match {
  date: string;      // 'YYYY-MM-DD' calendario Chile
  time: string;      // 'HH:mm' hora Chile (CLT, UTC-4 en junio)
  team1: string;
  team2: string;
  group: string;     // 'A' - 'L'
  channels: ('DSports' | 'ChileVisión')[];
}

// Partido inaugural: 11 de junio 2026, 15:00 Chile
export const INAUGURAL = '2026-06-11T15:00:00-04:00';

// Fase de grupos — Copa Mundial FIFA 2026
// Horarios: hora Chile (CLT, UTC-4). Fuente: fifa.com + canales @TorresTavoSports
export const MATCHES: Match[] = [
  // Junio 11 — Jornada 1
  { date: '2026-06-11', time: '15:00', team1: 'México', team2: 'Sudáfrica', group: 'A', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-11', time: '22:00', team1: 'Corea del Sur', team2: 'Chequia', group: 'A', channels: ['DSports'] },

  // Junio 12
  { date: '2026-06-12', time: '15:00', team1: 'Canadá', team2: 'Bosnia y Herzegovina', group: 'B', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-12', time: '21:00', team1: 'Estados Unidos', team2: 'Paraguay', group: 'D', channels: ['DSports', 'ChileVisión'] },

  // Junio 13
  { date: '2026-06-13', time: '15:00', team1: 'Catar', team2: 'Suiza', group: 'B', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-13', time: '18:00', team1: 'Brasil', team2: 'Marruecos', group: 'C', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-13', time: '21:00', team1: 'Haití', team2: 'Escocia', group: 'C', channels: ['DSports'] },

  // Junio 14 (00:00 = medianoche inicio del 14)
  { date: '2026-06-14', time: '00:00', team1: 'Australia', team2: 'Turquía', group: 'D', channels: ['DSports'] },
  { date: '2026-06-14', time: '01:00', team1: 'Alemania', team2: 'Curazao', group: 'E', channels: ['DSports'] },
  { date: '2026-06-14', time: '16:00', team1: 'Países Bajos', team2: 'Japón', group: 'F', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-14', time: '19:00', team1: 'Costa de Marfil', team2: 'Ecuador', group: 'E', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-14', time: '22:00', team1: 'Suecia', team2: 'Túnez', group: 'F', channels: ['DSports'] },

  // Junio 15
  { date: '2026-06-15', time: '12:00', team1: 'España', team2: 'Cabo Verde', group: 'H', channels: ['DSports'] },
  { date: '2026-06-15', time: '15:00', team1: 'Bélgica', team2: 'Egipto', group: 'G', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-15', time: '18:00', team1: 'Arabia Saudí', team2: 'Uruguay', group: 'H', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-15', time: '21:00', team1: 'Irán', team2: 'Nueva Zelanda', group: 'G', channels: ['DSports'] },

  // Junio 16
  { date: '2026-06-16', time: '15:00', team1: 'Francia', team2: 'Senegal', group: 'I', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-16', time: '18:00', team1: 'Irak', team2: 'Noruega', group: 'I', channels: ['DSports'] },
  { date: '2026-06-16', time: '21:00', team1: 'Argentina', team2: 'Argelia', group: 'J', channels: ['DSports', 'ChileVisión'] },

  // Junio 17 (00:00 = medianoche inicio del 17)
  { date: '2026-06-17', time: '00:00', team1: 'Austria', team2: 'Jordania', group: 'J', channels: ['DSports'] },
  { date: '2026-06-17', time: '13:00', team1: 'Portugal', team2: 'RD Congo', group: 'K', channels: ['DSports'] },
  { date: '2026-06-17', time: '16:00', team1: 'Inglaterra', team2: 'Croacia', group: 'L', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-17', time: '19:00', team1: 'Ghana', team2: 'Panamá', group: 'L', channels: ['DSports'] },
  { date: '2026-06-17', time: '22:00', team1: 'Uzbekistán', team2: 'Colombia', group: 'K', channels: ['DSports', 'ChileVisión'] },

  // Junio 18
  { date: '2026-06-18', time: '12:00', team1: 'Chequia', team2: 'Sudáfrica', group: 'A', channels: ['DSports'] },
  { date: '2026-06-18', time: '15:00', team1: 'Suiza', team2: 'Bosnia y Herzegovina', group: 'B', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-18', time: '18:00', team1: 'Canadá', team2: 'Catar', group: 'B', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-18', time: '21:00', team1: 'México', team2: 'Corea del Sur', group: 'A', channels: ['DSports'] },

  // Junio 19
  { date: '2026-06-19', time: '22:00', team1: 'Estados Unidos', team2: 'Australia', group: 'D', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-19', time: '18:00', team1: 'Escocia', team2: 'Marruecos', group: 'C', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-19', time: '21:00', team1: 'Brasil', team2: 'Haití', group: 'C', channels: ['DSports'] },

  // Junio 20 (00:00 = medianoche inicio del 20)
  { date: '2026-06-20', time: '00:00', team1: 'Turquía', team2: 'Paraguay', group: 'D', channels: ['DSports'] },
  { date: '2026-06-20', time: '13:00', team1: 'Países Bajos', team2: 'Suecia', group: 'F', channels: ['DSports'] },
  { date: '2026-06-20', time: '16:00', team1: 'Alemania', team2: 'Costa de Marfil', group: 'E', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-20', time: '20:00', team1: 'Ecuador', team2: 'Curazao', group: 'E', channels: ['DSports'] },

  // Junio 21 (00:00 = medianoche inicio del 21)
  { date: '2026-06-21', time: '00:00', team1: 'Túnez', team2: 'Japón', group: 'F', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-21', time: '12:00', team1: 'España', team2: 'Arabia Saudí', group: 'H', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-21', time: '15:00', team1: 'Bélgica', team2: 'Irán', group: 'G', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-21', time: '18:00', team1: 'Uruguay', team2: 'Cabo Verde', group: 'H', channels: ['DSports'] },
  { date: '2026-06-21', time: '21:00', team1: 'Nueva Zelanda', team2: 'Egipto', group: 'G', channels: ['DSports'] },

  // Junio 22
  { date: '2026-06-22', time: '13:00', team1: 'Argentina', team2: 'Austria', group: 'J', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-22', time: '17:00', team1: 'Francia', team2: 'Irak', group: 'I', channels: ['DSports'] },
  { date: '2026-06-22', time: '20:00', team1: 'Noruega', team2: 'Senegal', group: 'I', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-22', time: '23:00', team1: 'Jordania', team2: 'Argelia', group: 'J', channels: ['DSports'] },

  // Junio 23
  { date: '2026-06-23', time: '13:00', team1: 'Portugal', team2: 'Uzbekistán', group: 'K', channels: ['DSports'] },
  { date: '2026-06-23', time: '16:00', team1: 'Inglaterra', team2: 'Ghana', group: 'L', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-23', time: '19:00', team1: 'Panamá', team2: 'Croacia', group: 'L', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-23', time: '22:00', team1: 'Colombia', team2: 'RD Congo', group: 'K', channels: ['DSports'] },

  // Junio 24 — Jornada 3 (partidos simultáneos)
  { date: '2026-06-24', time: '15:00', team1: 'Suiza', team2: 'Canadá', group: 'B', channels: ['DSports'] },
  { date: '2026-06-24', time: '15:00', team1: 'Bosnia y Herzegovina', team2: 'Catar', group: 'B', channels: ['DSports'] },
  { date: '2026-06-24', time: '18:00', team1: 'Escocia', team2: 'Brasil', group: 'C', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-24', time: '18:00', team1: 'Marruecos', team2: 'Haití', group: 'C', channels: ['DSports'] },
  { date: '2026-06-24', time: '21:00', team1: 'Chequia', team2: 'México', group: 'A', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-24', time: '21:00', team1: 'Sudáfrica', team2: 'Corea del Sur', group: 'A', channels: ['DSports'] },

  // Junio 25
  { date: '2026-06-25', time: '16:00', team1: 'Curazao', team2: 'Costa de Marfil', group: 'E', channels: ['DSports'] },
  { date: '2026-06-25', time: '16:00', team1: 'Ecuador', team2: 'Alemania', group: 'E', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-25', time: '19:00', team1: 'Japón', team2: 'Suecia', group: 'F', channels: ['DSports'] },
  { date: '2026-06-25', time: '19:00', team1: 'Túnez', team2: 'Países Bajos', group: 'F', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-26', time: '00:00', team1: 'Turquía', team2: 'Estados Unidos', group: 'D', channels: ['DSports'] },
  { date: '2026-06-26', time: '00:00', team1: 'Paraguay', team2: 'Australia', group: 'D', channels: ['DSports', 'ChileVisión'] },

  // Junio 26
  { date: '2026-06-26', time: '15:00', team1: 'Noruega', team2: 'Francia', group: 'I', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-26', time: '15:00', team1: 'Senegal', team2: 'Irak', group: 'I', channels: ['DSports'] },
  { date: '2026-06-26', time: '20:00', team1: 'Cabo Verde', team2: 'Arabia Saudí', group: 'H', channels: ['DSports'] },
  { date: '2026-06-26', time: '20:00', team1: 'Uruguay', team2: 'España', group: 'H', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-26', time: '23:00', team1: 'Egipto', team2: 'Irán', group: 'G', channels: ['DSports'] },
  { date: '2026-06-26', time: '23:00', team1: 'Nueva Zelanda', team2: 'Bélgica', group: 'G', channels: ['DSports'] },

  // Junio 27
  { date: '2026-06-27', time: '17:00', team1: 'Panamá', team2: 'Inglaterra', group: 'L', channels: ['DSports'] },
  { date: '2026-06-27', time: '17:00', team1: 'Croacia', team2: 'Ghana', group: 'L', channels: ['DSports'] },
  { date: '2026-06-27', time: '19:30', team1: 'Colombia', team2: 'Portugal', group: 'K', channels: ['DSports', 'ChileVisión'] },
  { date: '2026-06-27', time: '19:30', team1: 'RD Congo', team2: 'Uzbekistán', group: 'K', channels: ['DSports'] },
  { date: '2026-06-28', time: '00:00', team1: 'Argelia', team2: 'Austria', group: 'J', channels: ['DSports'] },
  { date: '2026-06-28', time: '00:00', team1: 'Jordania', team2: 'Argentina', group: 'J', channels: ['DSports'] },
];

// Aliases para búsqueda de equipos (nombre normalizado → nombre en dataset)
export const TEAM_ALIASES: Record<string, string> = {
  // Español
  'eeuu': 'Estados Unidos',
  'usa': 'Estados Unidos',
  'paises bajos': 'Países Bajos',
  'holanda': 'Países Bajos',
  'arabia': 'Arabia Saudí',
  'arabia saudi': 'Arabia Saudí',
  'arabia saudita': 'Arabia Saudí',
  'costa marfil': 'Costa de Marfil',
  'costa de marfil': 'Costa de Marfil',
  'rd congo': 'RD Congo',
  'congo': 'RD Congo',
  'iran': 'Irán',
  'ri de iran': 'Irán',
  'bosnia': 'Bosnia y Herzegovina',
  'bosnia herzegovina': 'Bosnia y Herzegovina',
  'bosnia y herz': 'Bosnia y Herzegovina',
  'bosnia y herz.': 'Bosnia y Herzegovina',
  'corea': 'Corea del Sur',
  'corea del sur': 'Corea del Sur',
  'nueva zelanda': 'Nueva Zelanda',
  'cabo verde': 'Cabo Verde',
  'haiti': 'Haití',
  'tunez': 'Túnez',
  'turquia': 'Turquía',
  'panama': 'Panamá',
  'mexico': 'México',
  'belgica': 'Bélgica',
  'uzbekistan': 'Uzbekistán',
  'curazao': 'Curazao',
  'chequia': 'Chequia',
  'republica checa': 'Chequia',
  'sudafrica': 'Sudáfrica',
  // English
  'south korea': 'Corea del Sur',
  'south africa': 'Sudáfrica',
  'netherlands': 'Países Bajos',
  'ivory coast': 'Costa de Marfil',
  'saudi arabia': 'Arabia Saudí',
  'new zealand': 'Nueva Zelanda',
  'cape verde': 'Cabo Verde',
  'czech republic': 'Chequia',
  'czechia': 'Chequia',
  'morocco': 'Marruecos',
  'germany': 'Alemania',
  'france': 'Francia',
  'spain': 'España',
  'england': 'Inglaterra',
  'scotland': 'Escocia',
  'sweden': 'Suecia',
  'norway': 'Noruega',
  'switzerland': 'Suiza',
  'iraq': 'Irak',
  'egypt': 'Egipto',
  'algeria': 'Argelia',
  'tunisia': 'Túnez',
  'turkey': 'Turquía',
  'japan': 'Japón',
  'belgium': 'Bélgica',
  'qatar': 'Catar',
  'australia': 'Australia',
  'canada': 'Canadá',
  'croatia': 'Croacia',
  'senegal': 'Senegal',
  'portugal': 'Portugal',
  'argentina': 'Argentina',
  'colombia': 'Colombia',
  'ecuador': 'Ecuador',
  'brazil': 'Brasil',
};
