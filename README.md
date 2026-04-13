# Y el Link Bot

Bot de Telegram que mejora la experiencia de lectura de enlaces compartidos en grupos.

## Qué hace

Cuando alguien comparte un enlace de noticias en un grupo, el bot genera una versión de lectura limpia usando [Telegraph](https://telegra.ph), aprovechando el **Instant View** nativo de Telegram — sin salir de la app, sin popups, sin ads.

## Funcionalidades

- Lectura limpia de artículos vía Instant View
- Soporte para múltiples fuentes de noticias
- Monitoreo de feeds RSS con publicación automática a canales
- Comandos utilitarios: horóscopo, tipo de cambio, Mundial 2026
- Botones de acción: borrar, buscar en Archive.org, buscar en X

## Stack

- **Runtime:** [Bun](https://bun.sh)
- **Bot framework:** [grammY](https://grammy.dev)
- **Formato:** [Telegraph API](https://telegra.ph/api)
- **Hosting:** [Render](https://render.com)

## Setup

```bash
cp .env.example .env
# Completar tokens en .env

bun install
bun run dev
```

## Variables de entorno

Ver `.env.example` para la lista completa de variables requeridas.

## Licencia

MIT
