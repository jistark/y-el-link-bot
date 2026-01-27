# Y el Link Bot

Bot de Telegram para compartir artículos de noticias en formato legible.

## Características

- Convierte links de noticias a formato Instant View
- Soporta múltiples fuentes de noticias
- Botones de acción: borrar, buscar en Archive, buscar en Twitter
- Sistema de permisos para grupos

## Uso

1. Agrega el bot a tu grupo o chat privado
2. Envía un link de una fuente soportada
3. El bot generará una versión legible del artículo

## Configuración

```bash
cp .env.example .env
# Editar .env con tus tokens
```

Variables requeridas:
- `TELEGRAM_BOT_TOKEN` - Token de BotFather
- `TELEGRAPH_ACCESS_TOKEN` - Token de Telegraph API

## Desarrollo

```bash
# Instalar dependencias
bun install

# Ejecutar en desarrollo
bun run dev

# Ejecutar en producción
bun run start
```

## Stack

- Runtime: Bun
- Framework: grammy.js
- Formato: Telegraph API

## Licencia

MIT
