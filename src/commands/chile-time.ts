/** Local-time helpers for Chile (America/Santiago). Used by command modules. */

export function getChileTime(): string {
  return new Date().toLocaleTimeString('en-GB', {
    timeZone: 'America/Santiago',
    hour: '2-digit',
    minute: '2-digit',
  });
}
