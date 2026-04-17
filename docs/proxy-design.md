# Diseño: IPRoyal Web Unblocker para Bypass de Bot Protection

## Problema

Sitios con Cloudflare Bot Management (FT, Bloomberg, NYT, Wired, The Atlantic, WaPo) y Vercel Security Checkpoint (dolar.cl) bloquean requests desde IPs de datacenter (Render), incluso con TLS impersonation via curl_cffi.

curl_cffi resuelve el fingerprint TLS (JA3/JA4) pero no la reputación de IP.

## Solución

Enrutar requests a sitios bloqueados a través de **IPRoyal Web Unblocker** — un servicio managed que combina IP rotation residencial + retries automáticos + UA randomization + opcional JS rendering, todo detrás de un endpoint HTTP proxy estándar.

```
Bot (Render) → curl_cffi (Chrome TLS) → Web Unblocker (managed) → Sitio Target
```

Decisión: **Web Unblocker > Residential Proxy puro** porque elimina la complejidad de orquestar retries/rotación/UA cycling nosotros mismos. A $0.0009-$0.001 por request, el costo no es un factor.

## Servicio: IPRoyal Web Unblocker

- Endpoint: `http://USER:PASS_country-us@unblocker.iproyal.com:12323`
- Auth: solo basic auth via URL — **no requiere IP allowlist** (perfecto para Render donde la IP no es estática).
- TLS: el servicio MITM-termina SSL → requests deben usar `verify=False`.
- Geo: incluido en password (`_country-us`, `_country-gb`, etc.).
- JS rendering: opt-in via `_render-1` en password.
- Concurrencia: hasta 200 conexiones simultáneas.

Alternativas no elegidas:
- IPRoyal Residential puro ($1.75/GB) — más barato a alto volumen pero requiere implementar bypass logic local.
- Bright Data Web Unlocker — más caro, sin ventaja para nuestro caso.
- Smartproxy Site Unblocker — similar pricing/features, Web Unblocker ya cubre.

## Implementación

### Variable de entorno

```
PROXY_URL=http://USER:PASS_country-us@unblocker.iproyal.com:12323
PROXY_DOMAINS=                # Opcional, CSV. Default: ver script.
PROXY_JS_DOMAINS=             # Opcional, CSV. Default: vacío (sin JS).
```

Setear en Render Dashboard → Environment Variables.

### Cambios en `scripts/fetch_bypass.py`

Implementado: la función `fetch_direct(url, headers, use_proxy=False, render=False)` acepta `proxies={"http": PROXY_URL, "https": PROXY_URL}` con `verify=False` cuando `use_proxy=True`.

Helpers:
- `needs_proxy(url)` — chequea si el dominio está en `PROXY_DOMAINS`.
- `needs_js(url)` — chequea si requiere JS rendering.
- `proxy_url_with_render()` — inyecta `_render-1` en el password.
- `log_proxy(...)` — JSON line a stderr para auditoría.

### Flujo (chrome mode)

1. Si `PROXY_URL` set y `needs_proxy(url)` → **Web Unblocker first** (skip directo, va a fallar).
2. Si falla o no aplica → fetch directo con curl_cffi (2 intentos con backoff).
3. Si falla → Google Webcache.
4. Si falla → exit 1.

Modos `googlebot` e `inspectiontool` siguen sin proxy — esos UAs bypassan reputación de IP por sí solos.

### Sitios que NO necesitan proxy

Funcionan directo desde Render:
- latercera.com (OpenResty)
- df.cl (AltaVoz)
- elmercurio.com (BigIP)
- lasegunda.com, lun.com, biobiochile.cl, cnnchile.com
- elpais.com (OpenResty)
- primedigital.cl (horóscopo)
- adnradio, t13, tvn, mega, chilevision, etc.

### Monitoreo de consumo

Web Unblocker cobra por request. Logging estructurado en stderr:

```json
{"event":"proxy_use","domain":"www.ft.com","bytes":86421,"status":200,"render":false}
```

Auditoría desde Render logs:

```bash
# Count del mes
grep '"event":"proxy_use"' logs.txt | wc -l

# Breakdown por dominio
grep '"event":"proxy_use"' logs.txt | jq -r .domain | sort | uniq -c | sort -rn

# Tasa de éxito (cada fallo = request gastado igual)
grep '"event":"proxy_use"' logs.txt | jq '.status' | \
  awk '$1>=200 && $1<300 {ok++} END {print ok"/"NR}'
```

## Costos

Pricing IPRoyal Web Unblocker (Apr 2026):

| Pack | Precio | $/1000 req | Vida útil estimada |
|---|---|---|---|
| 1.000 | $1.00 | $1.00 | ~2-4 semanas |
| **5.000 (Recomendado)** | **$4.50** | **$0.90 (-10%)** | **~2-3 meses** |
| 50.000 | $40.00 | $0.80 (-20%) | ~2-3 años |
| 100.000 | $70.00 | $0.70 (-30%) | ~5 años |

Volumen estimado: 50-200 paywalled requests/día = 1.500-6.000/mes.

**Recomendación**: empezar con pack de 5.000 ($4.50), validar arquitectura ~1-2 meses, después saltar a 50.000 si el uso es estable.

## Pasos para implementar

1. Crear cuenta en https://iproyal.com → Web Unblocker (no Residential Proxies — son productos distintos).
2. Comprar pack de 5.000 requests ($4.50).
3. Generar credenciales con país US: `USER:PASS_country-us`.
4. URL final: `http://USER:PASS_country-us@unblocker.iproyal.com:12323`.
5. Agregar `PROXY_URL` en Render dashboard.
6. Deploy y verificar con FT/Bloomberg.

## Verificación

```bash
# Sin proxy (debe funcionar igual que hoy)
python3 scripts/fetch_bypass.py https://www.ft.com/content/<id>

# Con Web Unblocker
PROXY_URL='http://USER:PASS_country-us@unblocker.iproyal.com:12323' \
  python3 scripts/fetch_bypass.py https://www.ft.com/content/<id>
# stderr esperado: {"event":"proxy_use","domain":"www.ft.com","bytes":NNNNN,"status":200,...}

# JS rendering opt-in
PROXY_URL='...' PROXY_JS_DOMAINS='ft.com' \
  python3 scripts/fetch_bypass.py https://www.ft.com/content/<id>
# stderr esperado: ..."render":true
```
