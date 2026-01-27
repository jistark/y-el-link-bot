FROM oven/bun:1-alpine

WORKDIR /app

# Copiar archivos de dependencias
COPY package.json bun.lock* ./

# Instalar dependencias
RUN bun install --frozen-lockfile --production

# Copiar código fuente
COPY src ./src
COPY tsconfig.json ./

# El bot corre como proceso principal
CMD ["bun", "run", "src/index.ts"]
