import type { Article } from '../types.js';
import { decodeEntities } from '../utils/shared.js';

const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

export async function extract(url: string): Promise<Article> {
  const response = await fetch(url, {
    headers: { 'User-Agent': GOOGLEBOT_UA },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }

  const html = await response.text();

  // Extraer título
  const titleMatch = html.match(/<h1[^>]*class="enc-main__title"[^>]*>([^<]+)/i) ||
                     html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
  let title = titleMatch?.[1]?.trim();
  if (!title) {
    throw new Error('No se pudo extraer el título');
  }
  // Limpiar sufijo " | Diario Financiero"
  title = title.replace(/\s*\|\s*Diario Financiero$/i, '');

  // Extraer bajada
  const subtitleMatch = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
  const subtitle = subtitleMatch?.[1] ? decodeEntities(subtitleMatch[1].trim()) : undefined;

  // Extraer autor
  const authorMatch = html.match(/<meta\s+name="author"\s+content="([^"]+)"/i);
  const author = authorMatch?.[1]?.trim();

  // Extraer cuerpo desde div.CUERPO hasta el cierre antes de mrf-premium
  let body = '';
  const bodyMatch = html.match(/<div\s+class="CUERPO"[^>]*>([\s\S]*?)<\/div>\s*(?:<section class="mrf-premium|<div class="article-foot|$)/i);
  if (bodyMatch) {
    body = bodyMatch[1]
      // Limpiar secciones de "TE PUEDE INTERESAR" (prontus-card)
      .replace(/<p>\s*<div class="prontus-card-container">[\s\S]*?<\/div><\/div><\/p>/gi, '')
      .replace(/<div class="prontus-card-container">[\s\S]*?<\/div>\s*<\/div>/gi, '')
      // Limpiar templates {{...}}
      .replace(/\{\{[^}]*\}\}/g, '')
      // Limpiar ads
      .replace(/<div[^>]*class="[^"]*ad-df-slot[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
      .replace(/<div[^>]*class="[^"]*ad[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
      .replace(/<div[^>]*adUnit[^>]*>[\s\S]*?<\/div>/gi, '')
      // Limpiar secciones de artículos relacionados
      .replace(/<div[^>]*class="[^"]*relacionad[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
      .replace(/<div[^>]*class="[^"]*carousel[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
      // Convertir h2 a h3 para Telegraph (limpiar atributos style)
      .replace(/<h2[^>]*>/gi, '<h3>')
      .replace(/<\/h2>/gi, '</h3>')
      // Limpiar divs vacíos y con solo espacios
      .replace(/<div[^>]*>[\s]*<\/div>/gi, '')
      .replace(/<div[^>]*><span[^>]*>\s*<\/span><\/div>/gi, '')
      // Limpiar spans de estilo
      .replace(/<span[^>]*style="[^"]*font-family[^"]*"[^>]*>\s*<\/span>/gi, '')
      // Limpiar párrafos vacíos
      .replace(/<p>\s*<\/p>/gi, '')
      // Limpiar pie de foto suelto (moverlo a figcaption después)
      .replace(/<div[^>]*><span class="piefoto">([^<]+)<\/span><\/div>/gi, '<figcaption>$1</figcaption>')
      // Limpiar imágenes placeholder y de sistema
      .replace(/<img[^>]*src="[^"]*default[^"]*"[^>]*>/gi, '')
      .replace(/<img[^>]*src="[^"]*\/v1\/[^"]*"[^>]*>/gi, '')
      .replace(/<img[^>]*src="[^"]*\.svg"[^>]*>/gi, '')
      .replace(/<img[^>]*src="[^"]*icon[^"]*"[^>]*>/gi, '')
      .replace(/<img[^>]*src="[^"]*bloqueo[^"]*"[^>]*>/gi, '')
      // Limpiar sección de compartir
      .replace(/<ul[^>]*class="[^"]*share[^"]*"[^>]*>[\s\S]*?<\/ul>/gi, '')
      .replace(/<li[^>]*class="[^"]*share[^"]*"[^>]*>[\s\S]*?<\/li>/gi, '')
      // Limpiar figures vacías
      .replace(/<figure>\s*<\/figure>/gi, '')
      // Agrupar imagen con su caption en figure
      .replace(/<p>\s*<img([^>]+)>\s*<\/p>\s*<figcaption>([^<]+)<\/figcaption>/gi, '<figure><img$1><figcaption>$2</figcaption></figure>')
      // Convertir URLs relativas de imágenes a absolutas
      .replace(/src="(\/noticias\/[^"]+)"/gi, 'src="https://www.df.cl$1"')
      .trim();
  }

  // Extraer imagen principal
  const images: Article['images'] = [];
  const mainImageMatch = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  if (mainImageMatch) {
    images.push({ url: mainImageMatch[1] });
  }

  return {
    title,
    subtitle,
    author,
    body,
    images: images.length > 0 ? images : undefined,
    url,
    source: 'df',
  };
}
