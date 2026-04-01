# Diseño: Proxy Residencial para Bypass de Bot Protection

## Problema

Sitios con Cloudflare Bot Management (FT, Bloomberg, NYT, Wired, The Atlantic, WaPo) y Vercel Security Checkpoint (dolar.cl) bloquean requests desde IPs de datacenter (Render), incluso con TLS impersonation via curl_cffi.

curl_cffi resuelve el fingerprint TLS (JA3/JA4) pero no la reputación de IP.

## Solución

Agregar un proxy residencial como capa intermedia. curl_cffi soporta proxies nativamente — la combinación de TLS impersonation + IP residencial es el estándar para bypass de Cloudflare.

```
Bot (Render) → curl_cffi (Chrome TLS) → Proxy Residencial → Sitio Target
```

## Servicio recomendado

**IPRoyal Residential** — $1.75/GB, ~$2-5/mes para el volumen del bot.

Alternativas:
- PacketStream ($1/GB, calidad menor)
- Webshare ($7/GB, más confiable)
- Bright Data ($8.40/GB, premium)

## Implementación

### 1. Variable de entorno

```
PROXY_URL=http://USER:PASS_country-us@geo.iproyal.com:12321
```

Agregar en Render Dashboard → Environment Variables.

### 2. Cambios en `scripts/fetch_bypass.py`

```python
import os

PROXY_URL = os.environ.get('PROXY_URL')

# Sites que requieren proxy (Cloudflare/Vercel bot protection)
PROXY_DOMAINS = ['ft.com', 'bloomberg.com', 'nytimes.com', 'dolar.cl',
                 'theatlantic.com', 'washingtonpost.com', 'wired.com']

def needs_proxy(url):
    from urllib.parse import urlparse
    domain = urlparse(url).hostname or ''
    return any(domain.endswith(d) for d in PROXY_DOMAINS)

def fetch(url, headers):
    proxies = None
    if PROXY_URL and needs_proxy(url):
        proxies = {"http": PROXY_URL, "https": PROXY_URL}

    return requests.get(
        url,
        impersonate='chrome',
        headers=headers,
        proxies=proxies,
        timeout=20,
        allow_redirects=True,
    )
```

### 3. Flujo con fallback

```
1. fetch directo (sin proxy) — funciona para sitios chilenos sin CF
2. si falla → fetch con proxy residencial
3. si falla → Google Webcache (último recurso)
```

### 4. Sitios que NO necesitan proxy

Los sitios chilenos sin Cloudflare funcionan directo desde Render:
- latercera.com (OpenResty)
- df.cl (AltaVoz)
- elmercurio.com (BigIP)
- lasegunda.com, lun.com, biobiochile.cl, cnnchile.com
- elpais.com (OpenResty)
- primedigital.cl (horóscopo)
- Todos los nuevos: adnradio, t13, tvn, mega, chilevision, etc.

### 5. Monitoreo de consumo

Agregar logging del uso de proxy para controlar costos:

```python
if proxies:
    print(f"proxy: {domain} {len(r.content)} bytes", file=sys.stderr)
```

Esto permite calcular GB/mes desde los logs de Render.

## Costos estimados

| Escenario | Requests/día | GB/mes | Costo/mes (IPRoyal) |
|-----------|-------------|--------|---------------------|
| Bajo | 50 | ~0.5 | ~$1 |
| Normal | 200 | ~2 | ~$3.50 |
| Alto | 500 | ~5 | ~$8.75 |

## Pasos para implementar

1. Crear cuenta en IPRoyal (o alternativa)
2. Obtener credenciales del proxy residencial
3. Agregar `PROXY_URL` en Render env vars
4. Modificar `scripts/fetch_bypass.py` según diseño arriba
5. Deploy y verificar con FT/Bloomberg
