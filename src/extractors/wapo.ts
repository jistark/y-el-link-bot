import type { Article } from '../types.js';

const WAPO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
};

interface WaPoNextData {
  props?: {
    pageProps?: {
      globalContent?: {
        headlines?: { basic?: string };
        subheadlines?: { basic?: string };
        publish_date?: string;
        credits?: { by?: Array<{ name?: string }> };
        promo_items?: { basic?: { url?: string } };
        content_elements?: Array<{
          type: string;
          content?: string;
          level?: number;
        }>;
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

    if (textElements.length === 0) return null;

    // Construir body HTML
    const body = textElements
      .map((e) => `<p>${e.content}</p>`)
      .join('\n');

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
  const response = await fetch(url, { headers: WAPO_HEADERS });
  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }

  const html = await response.text();
  const article = extractWaPo(html);

  if (!article) {
    throw new Error('No se pudo extraer el contenido del artículo');
  }

  article.url = url;
  return article;
}
