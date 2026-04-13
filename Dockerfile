FROM oven/bun:1-alpine

WORKDIR /app

# Instalar Python y curl_cffi (TLS impersonation para FT, Bloomberg, etc.)
# gcc/musl-dev son necesarios para compilar cffi en Alpine, se borran después
RUN apk add --no-cache python3 && \
    apk add --no-cache --virtual .build-deps py3-pip gcc musl-dev python3-dev libffi-dev && \
    python3 -m venv .venv && \
    .venv/bin/pip install --no-cache-dir curl_cffi && \
    apk del .build-deps

# Copiar archivos de dependencias
COPY package.json bun.lock* ./

# Instalar dependencias
RUN bun install --frozen-lockfile --production

# Copiar código fuente
COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json ./

# Copiar datos estáticos (bypass-rules.json va fuera de data/ porque
# el persistent disk se monta en /app/data y lo sobreescribiría)
COPY data/bypass-rules.json ./bypass-rules.json

# El bot corre como proceso principal
CMD ["bun", "run", "src/index.ts"]
