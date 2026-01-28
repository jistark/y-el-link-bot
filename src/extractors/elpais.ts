import type { Article } from '../types.js';

const ELPAIS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
};

interface JsonLdArticle {
  '@type'?: string | string[];
  headline?: string;
  articleBody?: string;
  description?: string;
  author?: { name?: string; url?: string }[] | { name?: string } | string;
  datePublished?: string;
  image?: {
    '@type'?: string;
    url?: string | string[];
  } | string | string[];
}

// Patrones de texto de paywall/suscripción a filtrar
const PAYWALL_PATTERNS = [
  /¿Quieres añadir otro usuario/i,
  /Tu suscripción se está usando/i,
  /Si continúas leyendo en este dispositivo/i,
  /no se podrá leer en el otro/i,
  /¿Por qué estás viendo esto/i,
  /cambia tu suscripción a la modalidad Premium/i,
  /¿Tienes una suscripción de empresa/i,
  /te recomendamos cambiar tu contraseña/i,
  /Suscríbete para seguir leyendo/i,
  /Puedes seguir a EL PAÍS/i,
  /Regístrate gratis/i,
  /Inicia sesión para continuar/i,
  /Añadir usuario/i,
  /Continuar leyendo aquí/i,
  /términos y condiciones de la suscripción/i,
  /afectando a tu experiencia de lectura/i,
  /acceder a EL PAÍS desde un dispositivo/i,
  /personalizar vuestra experiencia/i,
  /contratar más cuentas/i,
  /este mensaje se mostrará en tu dispositivo/i,
];

function isPaywallText(text: string): boolean {
  return PAYWALL_PATTERNS.some(pattern => pattern.test(text));
}

function extractAuthor(author: JsonLdArticle['author']): string | undefined {
  if (!author) return undefined;
  if (Array.isArray(author)) {
    const names = author.map((a) => (typeof a === 'string' ? a : a.name)).filter(Boolean);
    return names.length > 0 ? names.join(', ') : undefined;
  }
  if (typeof author === 'object') return author.name || undefined;
  return String(author) || undefined;
}

function extractImage(image: JsonLdArticle['image']): string | undefined {
  if (!image) return undefined;
  if (typeof image === 'string') return image;
  if (Array.isArray(image)) {
    const first = image[0];
    return typeof first === 'string' ? first : undefined;
  }
  if (typeof image === 'object') {
    // image.url puede ser string o array
    if (Array.isArray(image.url)) return image.url[0];
    return image.url;
  }
  return undefined;
}

// Verificar si @type incluye Article o NewsArticle
function isArticleType(type: string | string[] | undefined): boolean {
  if (!type) return false;
  if (Array.isArray(type)) {
    return type.some(t => t === 'Article' || t === 'NewsArticle');
  }
  return type === 'Article' || type === 'NewsArticle';
}

function cleanHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"')
    .replace(/&ldquo;/g, '"')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    // Caracteres acentuados comunes en español
    .replace(/&aacute;/g, 'á')
    .replace(/&eacute;/g, 'é')
    .replace(/&iacute;/g, 'í')
    .replace(/&oacute;/g, 'ó')
    .replace(/&uacute;/g, 'ú')
    .replace(/&Aacute;/g, 'Á')
    .replace(/&Eacute;/g, 'É')
    .replace(/&Iacute;/g, 'Í')
    .replace(/&Oacute;/g, 'Ó')
    .replace(/&Uacute;/g, 'Ú')
    .replace(/&ntilde;/g, 'ñ')
    .replace(/&Ntilde;/g, 'Ñ')
    .replace(/&uuml;/g, 'ü')
    .replace(/&Uuml;/g, 'Ü')
    .replace(/&iquest;/g, '¿')
    .replace(/&iexcl;/g, '¡')
    // Entidades numéricas
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractParagraphsFromHtml(html: string): string[] {
  // 1. Eliminar secciones de paywall/suscripción antes de procesar
  let cleanHtml = html
    // Eliminar div de "dispositivo en uso" (me-dis)
    .replace(/<div class="me-dis[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi, '')
    // Eliminar modales de paywall
    .replace(/<div[^>]*class="[^"]*paywall[^"]*"[\s\S]*?<\/div>/gi, '')
    // Eliminar aside de suscripción/premium
    .replace(/<aside[^>]*class="[^"]*(?:premium|subscribe|paywall)[^"]*"[\s\S]*?<\/aside>/gi, '')
    // Eliminar divs de capping (límite de artículos)
    .replace(/<div[^>]*class="[^"]*capping[^"]*"[\s\S]*?<\/div>/gi, '');

  // 2. Buscar contenido principal en <div class="a_c"> (article content)
  const articleMatch = cleanHtml.match(
    /<div class="a_c[^"]*"[^>]*>([\s\S]*?)(?:<\/div>\s*<(?:aside|footer|div class="a_r)|<\/article>)/i
  );

  // Si no encontramos el div principal, buscar en <article id="main-content">
  let content = articleMatch ? articleMatch[1] : '';
  if (!content) {
    const mainArticle = cleanHtml.match(/<article[^>]*id="main-content"[^>]*>([\s\S]*?)<\/article>/i);
    content = mainArticle ? mainArticle[1] : cleanHtml;
  }

  const paragraphs: string[] = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let match;

  while ((match = pRegex.exec(content)) !== null) {
    let text = match[1]
      // Mantener texto de links
      .replace(/<a[^>]*>([^<]*)<\/a>/gi, '$1')
      // Mantener texto de spans
      .replace(/<span[^>]*>([^<]*)<\/span>/gi, '$1')
      // Mantener texto en cursiva/negrita
      .replace(/<(?:em|i|strong|b)[^>]*>([^<]*)<\/(?:em|i|strong|b)>/gi, '$1')
      // Eliminar otros tags
      .replace(/<[^>]+>/g, '');

    text = cleanHtmlEntities(text);

    // Filtrar párrafos cortos o que son paywall/CTAs
    if (text && text.length > 30 && !isPaywallText(text)) {
      paragraphs.push(text);
    }
  }

  return paragraphs;
}

export async function extract(url: string): Promise<Article> {
  const response = await fetch(url, { headers: ELPAIS_HEADERS });
  if (!response.ok) {
    throw new Error(`Error al obtener artículo: ${response.status}`);
  }
  const html = await response.text();

  // Buscar JSON-LD con articleBody
  const scriptRegex = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let jsonLdData: JsonLdArticle | null = null;
  let match;

  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);

      // Manejar array de JSON-LD o objeto único
      if (Array.isArray(data)) {
        const article = data.find((d) => isArticleType(d['@type']));
        if (article) {
          jsonLdData = article;
          break;
        }
      } else if (isArticleType(data['@type'])) {
        jsonLdData = data;
        break;
      }
    } catch {
      continue;
    }
  }

  // Extraer body - preferir HTML si articleBody no tiene párrafos separados
  let body: string | null = null;

  if (jsonLdData?.articleBody) {
    const articleBody = jsonLdData.articleBody;

    // Verificar si tiene saltos de línea para párrafos
    if (articleBody.includes('\n')) {
      // Tiene párrafos naturales, usar directamente
      const paragraphs = articleBody
        .split(/\n+/)
        .map(p => p.trim())
        .filter(p => p.length > 30 && !isPaywallText(p));

      if (paragraphs.length > 0) {
        body = paragraphs.map((p) => `<p>${p}</p>`).join('\n');
      }
    }

    // Si no hay párrafos o es texto corrido, extraer del HTML
    if (!body) {
      const htmlParagraphs = extractParagraphsFromHtml(html);
      if (htmlParagraphs.length > 3) {
        body = htmlParagraphs.map((p) => `<p>${p}</p>`).join('\n');
      }
    }

    // Fallback final: dividir articleBody en párrafos por oraciones
    if (!body) {
      const sentences = articleBody.split(/(?<=[.!?])\s+/);
      const paragraphs: string[] = [];
      let currentParagraph: string[] = [];

      for (const sentence of sentences) {
        if (isPaywallText(sentence)) continue;

        currentParagraph.push(sentence);
        // Crear párrafo cada 3-4 oraciones
        if (currentParagraph.length >= 3) {
          paragraphs.push(currentParagraph.join(' '));
          currentParagraph = [];
        }
      }
      if (currentParagraph.length > 0) {
        paragraphs.push(currentParagraph.join(' '));
      }

      if (paragraphs.length > 0) {
        body = paragraphs.map((p) => `<p>${p}</p>`).join('\n');
      }
    }
  } else {
    // No hay articleBody en JSON-LD, extraer del HTML
    const htmlParagraphs = extractParagraphsFromHtml(html);
    if (htmlParagraphs.length > 0) {
      body = htmlParagraphs.map((p) => `<p>${p}</p>`).join('\n');
    }
  }

  if (!body) {
    throw new Error('No se pudo extraer el contenido del artículo');
  }

  // Título desde JSON-LD o meta tags
  let title = jsonLdData?.headline;
  if (!title) {
    const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/);
    title = ogTitle?.[1];
  }
  if (!title) {
    const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
    title = h1Match ? cleanHtmlEntities(h1Match[1]) : undefined;
  }
  if (!title) {
    throw new Error('No se pudo extraer el título');
  }

  const imageUrl = extractImage(jsonLdData?.image);

  return {
    title: cleanHtmlEntities(title),
    subtitle: jsonLdData?.description ? cleanHtmlEntities(jsonLdData.description) : undefined,
    author: extractAuthor(jsonLdData?.author),
    date: jsonLdData?.datePublished,
    body,
    images: imageUrl ? [{ url: imageUrl }] : undefined,
    url,
    source: 'elpais',
  };
}
