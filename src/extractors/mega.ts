import type { Article } from '../types.js';

// Extractor compartido para meganoticias.cl y mega.cl (mismo CMS MediaStream)
// JSON-LD tiene metadata pero articleBody está contaminado con sidebar — usar HTML para body

export async function extract(url: string): Promise<Article> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });

  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }

  const html = await response.text();
  const hostname = new URL(url).hostname;
  const source: Article['source'] = hostname.includes('meganoticias') ? 'meganoticias' : 'mega';

  let title: string | undefined;
  let subtitle: string | undefined;
  let author: string | undefined;
  let date: string | undefined;
  let imageUrl: string | undefined;

  // JSON-LD para metadata (viene después del comentario <!-- data estructurada nota -->)
  // El tag tiene espacios extras: <script type = "application/ld+json">
  // Puede ser un array [{...}] con NewsArticle
  const jsonLdMatches = html.matchAll(/<script[^>]*type\s*=\s*"application\/ld\+json"[^>]*>([\s\S]+?)<\/script>/g);
  for (const match of jsonLdMatches) {
    try {
      const raw = match[1].trim();
      const data = JSON.parse(raw);
      const articles = Array.isArray(data) ? data : [data];
      for (const item of articles) {
        if (item['@type'] === 'NewsArticle' || item['@type'] === 'Article') {
          title = item.headline;
          subtitle = item.description;
          date = item.datePublished;
          // Author puede ser array de objetos
          if (item.author) {
            if (Array.isArray(item.author)) {
              author = item.author.map((a: any) => a.name).filter(Boolean).join(', ');
            } else {
              author = typeof item.author === 'string' ? item.author : item.author.name;
            }
          }
          // Imagen
          if (item.image) {
            const img = item.image;
            imageUrl = typeof img === 'string' ? img : img.url;
          }
          break;
        }
      }
    } catch {
      // JSON inválido
    }
  }

  // Fallback metadata desde meta tags (JSON-LD de Mega suele estar malformado)
  if (!title) {
    const ogTitle = html.match(/<meta\s+(?:property|name)="og:title"\s+content="([^"]+)"/);
    title = ogTitle?.[1];
  }
  if (!title) throw new Error('No se pudo extraer el título del artículo');

  if (!author) {
    const authorMeta = html.match(/<meta\s+(?:property|name)="author"\s+content="([^"]+)"/);
    author = authorMeta?.[1];
  }
  if (!date) {
    const pubDate = html.match(/<meta\s+(?:property|name)="article:published_time"\s+content="([^"]+)"/);
    date = pubDate?.[1];
  }
  if (!subtitle) {
    const ogDesc = html.match(/<meta\s+(?:property|name)="og:description"\s+content="([^"]+)"/);
    subtitle = ogDesc?.[1];
  }
  if (!imageUrl) {
    const ogImage = html.match(/<meta\s+(?:property|name)="og:image"\s+content="([^"]+)"/);
    imageUrl = ogImage?.[1];
  }

  // Body: extraer de contenido-nota (NO usar articleBody del JSON-LD — está contaminado)
  // El div contenido-nota incluye sidebars (loMasVisto) intercalados con los párrafos,
  // así que tomamos un chunk grande y extraemos solo los <p> sustanciales
  let body = '';
  const contentIdx = html.indexOf('class="contenido-nota"');

  if (contentIdx > -1) {
    // Tomar chunk generoso — los artículos raramente pasan 20k chars
    const chunk = html.slice(contentIdx, contentIdx + 30000);
    // Buscar el fin del área de contenido
    const endIdx = chunk.search(/<div[^>]*class="[^"]*(?:area-usuario-articulo|leer-mas|contenedor-tags|pie-nota)[^"]*"/);
    const content = endIdx > 0 ? chunk.slice(0, endIdx) : chunk;

    // Extraer párrafos — filtrar los que son contenido real (no sidebars)
    const paragraphs = [...content.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)]
      .map(m => {
        let text = m[1].trim();
        // Mantener em, strong, a
        text = text.replace(/<(?!\/?(em|strong|a|b|i)\b)[^>]+>/g, '');
        text = text.replace(/&nbsp;/g, ' ').trim();
        return text;
      })
      .filter(p => p.length > 30); // Más estricto para evitar basura de sidebar

    if (paragraphs.length > 0) {
      body = paragraphs.map(p => `<p>${p}</p>`).join('\n');
    }
  }

  if (!body) {
    throw new Error('No se pudo extraer el contenido del artículo');
  }

  // Decodificar entidades HTML en título
  title = title
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'");

  const images: Article['images'] = [];
  if (imageUrl) images.push({ url: imageUrl });

  return {
    title,
    subtitle,
    author,
    date,
    body,
    images: images.length > 0 ? images : undefined,
    url,
    source,
  };
}
