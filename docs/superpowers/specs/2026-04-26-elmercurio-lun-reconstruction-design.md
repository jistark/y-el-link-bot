# Reconstrucción mejorada de El Mercurio y LUN

**Fecha**: 2026-04-26
**Status**: aprobado, listo para implementar

## Problema

1. Las notas reconstruidas de El Mercurio (papel digital) y LUN no traen antetítulo (`head_label`), citas destacadas (`quotes[]`), créditos de foto ni autor en LUN. El usuario percibe el resultado lejos del "papel digital".
2. Cuando una página de El Mercurio contiene una sola nota dividida en ancla + recuadros (ej. `T1_…_Büchi.ART` + `T1_2_…_Büchi_R1.ART` ... `_R4.ART`), el bot la presenta como 5 artículos sueltos y obliga al usuario a elegir uno, perdiendo el reportaje completo.
3. El selector muestra markup propio de El Mercurio sin limpiar (`<bold>`, `<italic>`).
4. Las fotos con `name` que empieza con `NO_WEB_` pero `noExport: false` (caso típico: la foto principal del entrevistado) se descartan por error.

## Solución

Tres frentes paralelos, entregables en 6 fases independientes.

### A. Enriquecer el extractor individual de El Mercurio (`extractFromDigitalJson`)

Cambios al sanitizer y a la construcción del `Article`:

- **Sanitizer whitelist-based** para tags propios:
  - `<head_label>{x}</head_label>` → capturado aparte como volada/`kicker`.
  - `<head_deck>{x}</head_deck>` → `subtitle` (ya existe; mejorar limpieza).
  - `<byline>{x}</byline>`, `<byline_credit>{x}</byline_credit>` → `author`.
  - `<quote><P><leadin>{a}</leadin>{b}</P></quote>` → `<blockquote><b>{a}</b> {b}</blockquote>` (sin leadin: `<blockquote>{b}</blockquote>`).
  - `<bold_intro>{x}</bold_intro>` → `<p><b>{x}</b></p>` (preguntas de entrevista).
  - `<dropcap/>` → eliminar.
  - `<leadin>{x}</leadin>` (dentro del body) → `<b>{x}</b>`.
  - `<P>` → `<p>`, `<subhead>` → `<h3>`, `<bold>` → `<b>`, `<italic>` → `<i>`.
  - Cualquier tag desconocido → eliminar tag, preservar contenido.

- **Composición del cuerpo Telegraph**:
  ```
  [si hay kicker] <p><b>{kicker}</b></p>
  [si hay autor]  <p>Por {author}</p>
  [si hay quotes] <blockquote>...</blockquote> × N
  [body sanitizado]
  ```
  La bajada (`subtitle`) la maneja el formatter de Telegraph aparte (no se duplica en el body).

- **Imágenes**:
  - Filtro: `noExport === false` Y `infographic === false`. **NO** filtrar por `name.startsWith('NO_WEB_')` — la foto principal del Büchi tiene `NO_WEB_73870227` con `noExport: false`.
  - URL: `https://digital.elmercurio.com/{date}/content/pages/img/mid/{path}` (verificado: `mid/` retorna 200; `big/` retorna 403 — no usar).
  - Caption: limpiar `<bold>`/`<italic>` con el sanitizer.
  - Créditos: si existe `credits`, agregar como sufijo en el caption: `{caption} (Foto: {credits})`.

### B. Detección y fusión de "story groups" en El Mercurio

Modificación en `fetchPageArticles` y nuevo handler en `bot.ts`.

**Filtros previos** (para no contaminar el grouping):
- Excluir `name` que NO termine en `.ART` (descarta banners de sección como `Chile.Nacional.Economía_y_Ne.AR1`).
- Excluir `noExport === true`.
- Excluir `name.startsWith('NO_WEB_')`.
- Mantener requisito existente: `id` y `title` no vacíos.

**Algoritmo de agrupación** (`groupPageArticles(articles)`):

1. Para cada artículo, parsear `name` con:
   ```typescript
   function parseArticleName(name: string): {
     topicKey: string | null;       // 'T1' si name empieza con /^T(\d+)_/
     isRecuadro: boolean;            // termina en /_R\d+\.ART$/
     recuadroIndex: number | null;   // el N de _R\d+
     normalizedKey: string;          // name sin _R\d+\.ART y sin segundo _\d_ tras T\d_
   }
   ```

   Ejemplos:
   - `T1_EyN_B12_2504_Büchi.ART` → `{topicKey: 'T1', isRecuadro: false, normalizedKey: 'T1_EyN_B12_2504_Büchi'}`
   - `T1_2_EyN_B12_2504_Büchi_R1.ART` → `{topicKey: 'T1', isRecuadro: true, recuadroIndex: 1, normalizedKey: 'T1_EyN_B12_2504_Büchi'}`

2. Para cada recuadro, buscar otro artículo en la misma página con el mismo `normalizedKey` y `isRecuadro === false`. Si lo encuentra → es el ancla del grupo.

3. Construir `groups: StoryGroup[]` donde cada grupo tiene `{anchor: PageArticleInfo, recuadros: PageArticleInfo[]}` ordenado por `recuadroIndex` ascendente. Recuadros sin ancla → tratar como artículos individuales (orphans).

4. Resultado: `{groups: StoryGroup[], standalone: PageArticleInfo[]}`. Standalone incluye anclas sin recuadros y orphans.

**Selector UI**:

- Si hay **un solo grupo** y `standalone.length === 0` (todos pertenecen al grupo):
  - **Auto-ejecutar reportaje completo** sin prompt — equivalente al caso "1 solo artículo".

- Si hay grupos + standalone, mostrar:
  ```
  📋 Reportaje completo: "{anchor.title}" ({N} partes)
  1️⃣ "{title individual}"
  2️⃣ "{title individual}"
  ...
  ```
  Botones: `📋 Todo` por grupo + numerados para individuales.

- Callback data: `empage:g:{groupIdx}` (grupo) o `empage:a:{articleIdx}` (individual). Índices preservan compatibilidad con 64-byte limit.

- Persistir en `pendingPages` el resultado completo de `groupPageArticles` para que el handler del callback sepa qué fetchear.

**Reconstrucción del story group** (`extractStoryGroup(group, date)`):

1. Fetch paralelo (`Promise.allSettled`) del ancla y todos los recuadros, **timeout 8s por fetch**.
2. Si el ancla falla → throw (sin ancla no hay reportaje).
3. Componer body Telegraph:
   ```
   [kicker, author, quotes del ancla]
   [body sanitizado del ancla]
   [si hay imagen principal] <figure><img src="..."><figcaption>...</figcaption></figure>

   <aside>  ← contenedor visual de Telegraph para el primer recuadro
     <h3>{recuadro.title sanitizado}</h3>
     [quotes del recuadro]
     [body sanitizado del recuadro]
     [imagen del recuadro si existe]
   </aside>
   <aside>...</aside>  ← más recuadros
   ```
4. Para cada recuadro fallido, agregar `<aside><p><i>(Recuadro «{title}» no disponible)</i></p></aside>` al final.
5. **Guard de tamaño Telegraph**: serializar nodes a JSON; si `> 50_000` bytes, descartar último recuadro y agregar `<p><i>(Continúa en el original →)</i></p>`. Loggear `event: 'telegraph_payload_size_warning'`.

### C. Mejorar LUN (`extract` en `lun.ts`)

- **Autor**: agregar selector `<div id="autor">([^<]+)<\/div>` → poblar `Article.author`.
- **Bajada/volada**: regex no-greedy hasta `</span>` final para soportar markup interno.
- **Cover de página**: agregar `imageUrl` derivado de:
  ```
  https://images.lun.com/luncontents/NewsPaperPages/{YYYY}/{mes-abrev}/{DD}/p_{YYYY-MM-DD}_pag{N}.webp
  ```
  donde `mes-abrev` ∈ `['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic']`. Si webp da 404, fallback a `_768.jpg`.
- **Video (opcional, fase 6)**: si existe `<div id="video">{filename}</div>` → agregar `<video src="https://images.lun.com/luncontents/Videos/{filename}">` al inicio del body.

### D. Sanitización de markup en el selector

Aplicar el sanitizer Mercurio a los `title` que se muestran en el selector de páginas (hoy solo limpia `<highlight>`).

### E. Cover de página en Telegraph (Mercurio + LUN)

- Para Mercurio en ruta "story group", usar `https://digital.elmercurio.com/{date}/content/pages/img/mid/{pageId}.jpg` como `imageUrl`.
- Para LUN, el cover de página descrito en C.
- Para artículos individuales (no group), usar la primera imagen válida del artículo.

## Componentes y archivos

- `src/extractors/elmercurio.ts`:
  - Nuevo: `sanitizeMercurioMarkup(html: string): string` (whitelist).
  - Nuevo: `parseArticleName(name: string)`.
  - Nuevo: `groupPageArticles(articles: PageArticleInfo[])`.
  - Nuevo: `extractStoryGroup(group: StoryGroup, date: string): Promise<Article>`.
  - Modificar: `extractFromDigitalJson` (usar sanitizer, capturar kicker/quotes/imágenes correctamente).
  - Modificar: `fetchPageArticles` (filtros mejorados, retornar `groups + standalone`).
  - Modificar: `extractByArticleId` (usar nueva ruta de imágenes).

- `src/extractors/lun.ts`:
  - Nuevo: `buildLunPageCoverUrl(fecha: string, paginaId: string): string`.
  - Modificar: `extractLunContent` (capturar autor, video, mejorar bajada/volada).
  - Modificar: `extract` (poblar `imageUrl` con cover de página).

- `src/types.ts`:
  - Agregar `kicker?: string` a `Article` (volada/antetítulo).
  - Agregar `imageUrl?: string` a `Article` (cover para Telegraph).

- `src/formatters/telegraph.ts`:
  - Renderizar `kicker` como `<p><b>{kicker}</b></p>` antes del cuerpo.
  - Pasar `imageUrl` como `image_url` al endpoint `createPage` de Telegraph.

- `src/bot.ts`:
  - Cambiar callback de `empage:N` a `empage:g:{idx}` y `empage:a:{idx}`.
  - Auto-ejecutar reportaje completo cuando `groups.length === 1 && standalone.length === 0`.
  - Usar el sanitizer Mercurio para limpiar titles del selector.

## Manejo de errores

- Ancla del grupo falla → `extractStoryGroup` throws, mensaje al usuario "No pude reconstruir este reportaje".
- Recuadro falla → continuar, agregar nota al final del body.
- Image URL retorna 403/404 → omitir imagen, no fallar el artículo.
- Cover de página falla → omitir `imageUrl`, mantener artículo.
- LUN cover webp 404 → fallback a `_768.jpg`. Si también falla, omitir.
- Telegraph payload > 50KB → truncar último recuadro, log de warning.
- Parser de naming convention falla → caer al comportamiento anterior (lista plana de artículos).

## Edge cases documentados

| Caso | Comportamiento |
|------|----------------|
| Página con un solo grupo único, todos los items pertenecen | Auto-ejecutar grupo sin prompt |
| Página con varios grupos (`T1`, `T2`) | Selector ofrece un botón `📋` por grupo + individuales |
| Recuadro huérfano (sin ancla) | Tratar como artículo individual |
| Ancla sin recuadros | Tratar como artículo individual normal |
| Página sin nada agrupable | Selector plano actual |
| Página con banner de sección (`.AR1`) | Filtrar antes del grouping |
| LUN página sin cover image | Omitir `imageUrl` |
| LUN página con video | Embed `<video>` (fase 6) |
| Mercurio body con tags desconocidos | Sanitizer preserva contenido, descarta tag |
| Mercurio imagen `NO_WEB_*` con `noExport: false` | **Incluirla** (es la principal) |

## Plan de fases

| # | Fase | Riesgo | Valor inmediato |
|---|------|--------|-----------------|
| 1 | Sanitizer Mercurio + `kicker` + `quotes` + sanitizar titles del selector | Bajo | Soluciona "no aparecen antetítulos/citas" |
| 2 | Imágenes Mercurio con `mid/` + caption + créditos | Bajo | Visual mejorado |
| 3 | LUN: extraer `<div id="autor">` + cover de página + bajada/volada | Bajo | Paridad con Mercurio individual |
| 4 | Detección de story groups + nuevo selector + auto-merge | Medio | Feature principal |
| 5 | Cover de página en Telegraph (Mercurio + LUN ruta grupo) | Bajo | Pulido visual |
| 6 | LUN video (opcional) | Bajo | Plus |

## Testing

**Unit (sin red, rápido)**:
- `parseArticleName` con casos: ancla con `T\d`, ancla sin `T\d`, recuadro `_R1`-`_R9`, banner `.AR1`, `NO_WEB_*`, ñ/acentos.
- `groupPageArticles` con: 1 grupo + standalones, 0 grupos + N standalones, recuadro huérfano, varios grupos, página vacía.
- `sanitizeMercurioMarkup` con: tags conocidos, tags anidados, tags desconocidos, contenido vacío.
- `buildLunPageCoverUrl` con: fechas en distintos meses (verifica abreviatura).

**Integration con fixtures** (HTML/JSON guardado):
- `test/fixtures/elmercurio_b12_2026-04-25.json` (page B12, story group de 5).
- `test/fixtures/elmercurio_b1_2026-04-25.json` (page B1, sin grupos, banners).
- `test/fixtures/lun_p13_2026-04-26.html` (LUN simple).

**Smoke live** (skip en CI sin red):
- Fetch real `2026/04/25/B/3A4KSPJP` → verifica `body.length > 1000` y no excepción.
- Fetch real LUN `PaginaId=13` 2026-04-26 → idem.

## Logging

Eventos estructurados nuevos:
- `page_groups_detected`: `{url, groupCount, orphanCount, totalArticles}`.
- `story_group_extraction_partial_failure`: `{anchorId, failedRecuadroIds, durationMs}`.
- `mercurio_image_url_failure`: `{path, statusCode}`.
- `telegraph_payload_size_warning`: `{sizeBytes, articleCount, truncated}`.
- `lun_cover_image_fallback`: `{paginaId, fecha, format}` (`webp`→`jpg`).

## Métricas de éxito

- Para la URL `https://digital.elmercurio.com/2026/04/25/B/3A4KSPJP`, después del cambio:
  - El bot **no** muestra selector.
  - Auto-genera UNA Telegraph con: `head_label` ("Antonio Büchi, CEO de Entel:"), titular, bajada, byline, 2 quotes, body completo del ancla, foto principal con caption, 4 recuadros como `<aside>`, cover de página.
- Para LUN `PaginaId=13` 2026-04-26: incluye autor "Francisca Orellana" y `imageUrl` con cover de página.
- En el selector de B1 2026-04-25: solo aparecen 4 items legibles (1 ancla `Invariabi` + 3 llamados), sin banners ni `NO_WEB_*`.
