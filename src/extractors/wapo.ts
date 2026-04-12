import type { Article } from '../types.js';
import { fetchBypass } from './fetch-bypass.js';

interface WaPoNextData {
  props?: {
    pageProps?: {
      globalContent?: {
        headlines?: { basic?: string };
        subheadlines?: { basic?: string };
        publish_date?: string;
        restricted?: boolean;
        credits?: { by?: Array<{ name?: string }> };
        promo_items?: { basic?: { url?: string } };
        content_elements?: Array<{
          type: string;
          content?: string;
          level?: number;
        }>;
        summaries?: {
          summary?: string;
          key_points?: string[];
        };
      };
    };
  };
}

function extractWaPo(html: string): Article | null {
  // Buscar __NEXT_DATA__
  const nextDataMatch = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/s
  );

  if (!nextDataMatch) return null;

  try {
    const data: WaPoNextData = JSON.parse(nextDataMatch[1]);
    const gc = data.props?.pageProps?.globalContent;

    if (!gc) return null;

    // Extraer content_elements de tipo "text"
    const textElements = gc.content_elements?.filter(
      (e) => e.type === 'text' && e.content
    ) || [];

    // Build body — use summaries as fallback for paywalled articles
    let body: string;
    if (textElements.length >= 3) {
      body = textElements.map((e) => `<p>${e.content}</p>`).join('\n');
    } else if (gc.summaries?.summary || gc.summaries?.key_points?.length) {
      // Paywalled: WaPo returns ≤1 text element + summaries
      const parts: string[] = [];
      if (textElements.length > 0) {
        parts.push(...textElements.map((e) => `<p>${e.content}</p>`));
      }
      if (gc.summaries.summary) {
        parts.push(`<p>${gc.summaries.summary}</p>`);
      }
      if (gc.summaries.key_points?.length) {
        const items = gc.summaries.key_points.map((p) => `<li>${p}</li>`).join('');
        parts.push(`<ul>${items}</ul>`);
      }
      if (gc.restricted) {
        parts.push('<p><i>Artículo con paywall — contenido parcial vía resumen editorial.</i></p>');
      }
      body = parts.join('\n');
    } else if (textElements.length > 0) {
      body = textElements.map((e) => `<p>${e.content}</p>`).join('\n');
    } else {
      return null;
    }

    // Extraer autores
    const authors = gc.credits?.by
      ?.map((a) => a.name)
      .filter(Boolean)
      .join(', ');

    // Extraer imagen
    const imageUrl = gc.promo_items?.basic?.url;

    return {
      title: gc.headlines?.basic || 'Sin título',
      subtitle: gc.subheadlines?.basic,
      author: authors || undefined,
      date: gc.publish_date,
      body,
      images: imageUrl ? [{ url: imageUrl }] : undefined,
      url: '',
      source: 'wapo',
    };
  } catch {
    return null;
  }
}

export async function extract(url: string): Promise<Article> {
  const html = await fetchBypass(url, 'https://www.google.com/');
  const article = extractWaPo(html);

  if (!article) {
    throw new Error('No se pudo extraer el contenido del artículo');
  }

  article.url = url;
  return article;
}
