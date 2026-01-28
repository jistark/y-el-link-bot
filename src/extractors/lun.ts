import type { Article } from '../types.js';

interface LunParams {
  fecha: string;
  newsId: string;
  paginaId: string;
  supplementId: string;
  bodyId: string;
}

function parseLunUrl(url: string): LunParams {
  const params: Record<string, string> = {};
  const matches = url.matchAll(/[?&](\w+)=([^&]+)/gi);
  for (const match of matches) {
    params[match[1].toLowerCase()] = match[2];
  }

  return {
    fecha: params.dt || '',
    newsId: params.newsid || '',
    paginaId: params.paginaid || '1',
    supplementId: params.supplementid || '0',
    bodyId: params.bodyid || '0',
  };
}

function buildHomemobUrl(params: LunParams): string {
  return `https://www.lun.com/lunmobileiphone/Homemob.aspx?dt=${params.fecha}&bodyid=${params.bodyId}&SupplementId=${params.supplementId}&PaginaId=${params.paginaId}&NewsId=${params.newsId}`;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&iquest;/g, '¿')
    .replace(/&aacute;/g, 'á')
    .replace(/&eacute;/g, 'é')
    .replace(/&iacute;/g, 'í')
    .replace(/&oacute;/g, 'ó')
    .replace(/&uacute;/g, 'ú')
    .replace(/&ntilde;/g, 'ñ')
    .replace(/&Aacute;/g, 'Á')
    .replace(/&Eacute;/g, 'É')
    .replace(/&Iacute;/g, 'Í')
    .replace(/&Oacute;/g, 'Ó')
    .replace(/&Uacute;/g, 'Ú')
    .replace(/&Ntilde;/g, 'Ñ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
}

interface ExtractedContent {
  titulo: string | null;
  subtitulo: string | null;
  bajada: string | null;
  texto: string | null;
  seccion: string | null;
  imagenes: string[];
  newsId: string | null;
  fecha: string | null;
}

function extractLunContent(html: string): ExtractedContent {
  const result: ExtractedContent = {
    titulo: null,
    subtitulo: null,
    bajada: null,
    texto: null,
    seccion: null,
    imagenes: [],
    newsId: null,
    fecha: null,
  };

  // NewsID from div with class noticia
  let m = html.match(/<div id='(\d+)' class="noticia"/);
  if (m) result.newsId = m[1];

  // Título from div id="titulo"
  m = html.match(/<div id="titulo">([^<]+)<\/div>/);
  if (m) result.titulo = decodeHtmlEntities(m[1].trim());

  // Sección from div id="seccion"
  m = html.match(/<div id="seccion">([^<]+)<\/div>/);
  if (m) result.seccion = decodeHtmlEntities(m[1].trim());

  // Fecha from div id="fecha_publicacion_av"
  m = html.match(/<div id="fecha_publicacion_av">([^<]+)<\/div>/);
  if (m) result.fecha = m[1].trim();

  // Subtítulo (volada) from lblSubTitulo span
  m = html.match(/lblSubTitulo"[^>]*>([^<]+)<\/span>/);
  if (m) result.subtitulo = decodeHtmlEntities(m[1].trim());

  // Bajada from lblSubTitulo3 span
  m = html.match(/lblSubTitulo3"[^>]*>([^<]+)<\/span>/);
  if (m) result.bajada = decodeHtmlEntities(m[1].trim());

  // Texto principal from _pText span
  m = html.match(/_pText">(.+?)<\/span>/s);
  if (m) {
    let textoHtml = m[1];

    // Convertir subtítulos internos <sub> a formato legible
    textoHtml = textoHtml.replace(/<sub[^>]*>([^<]+)<\/sub>/g, '\n\n## $1\n');

    // Limpiar el HTML
    textoHtml = textoHtml.replace(/<big[^>]*>([^<]*)<\/big>/g, '$1'); // Letra capital
    textoHtml = textoHtml.replace(/<br\s*\/?>/gi, '\n'); // Saltos de línea
    textoHtml = textoHtml.replace(/<[^>]+>/g, ''); // Remover tags restantes

    // Decode HTML entities
    textoHtml = decodeHtmlEntities(textoHtml);

    // Normalizar espacios
    textoHtml = textoHtml.replace(/\n{3,}/g, '\n\n');

    result.texto = textoHtml.trim();
  }

  // Imágenes from src attributes - using single quotes in Homemob
  const imagenes = html.matchAll(/src='(https:\/\/images\.lun\.com\/LunServerContents\/Noticias[^']+)'/g);
  const imageSet = new Set<string>();
  for (const imgMatch of imagenes) {
    imageSet.add(imgMatch[1]);
  }
  result.imagenes = Array.from(imageSet);

  return result;
}

export async function extract(url: string): Promise<Article> {
  const params = parseLunUrl(url);

  // Si es URL desktop (no tiene NewsID), primero obtener el NewsID
  if (!params.newsId) {
    const desktopResponse = await fetch(url);
    if (!desktopResponse.ok) {
      throw new Error(`Error al obtener página desktop: ${desktopResponse.status}`);
    }
    // LUN servers return ISO-8859-1 encoded content
    const desktopBuffer = await desktopResponse.arrayBuffer();
    const desktopDecoder = new TextDecoder('iso-8859-1');
    const desktopHtml = desktopDecoder.decode(desktopBuffer);

    // Buscar NewsID en JavaScript de la página
    // Primero intentar NewsIDRepeater (contiene el ID real de la noticia principal)
    // Si no, intentar NewsID directo
    const newsIdRepeaterMatch = desktopHtml.match(/var NewsIDRepeater = '(\d+)'/);
    const newsIdMatch = desktopHtml.match(/var NewsID = '(\d+)'/);

    const foundNewsId = newsIdRepeaterMatch?.[1] || (newsIdMatch?.[1] !== '0' ? newsIdMatch?.[1] : null);

    if (!foundNewsId) {
      throw new Error('No se pudo obtener NewsID de la página desktop. Esta página no tiene un artículo específico asociado.');
    }
    params.newsId = foundNewsId;
  }

  // Construir URL de Homemob.aspx y obtener contenido
  const homemobUrl = buildHomemobUrl(params);
  const response = await fetch(homemobUrl);
  if (!response.ok) {
    throw new Error(`Error al obtener contenido: ${response.status}`);
  }
  // LUN servers return ISO-8859-1 encoded content
  const buffer = await response.arrayBuffer();
  const decoder = new TextDecoder('iso-8859-1');
  const html = decoder.decode(buffer);

  const content = extractLunContent(html);

  if (!content.titulo || !content.texto) {
    throw new Error('No se pudo extraer el contenido del artículo');
  }

  // Construir body con subtitulo y bajada si existen
  let body = '';
  if (content.subtitulo) {
    body += `<p><strong>${content.subtitulo}</strong></p>\n`;
  }
  if (content.bajada) {
    body += `<p><em>${content.bajada}</em></p>\n`;
  }

  // Convertir texto plano con ## subtítulos a HTML
  const paragraphs = content.texto.split('\n\n');
  for (const p of paragraphs) {
    const trimmed = p.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('## ')) {
      body += `<h4>${trimmed.slice(3)}</h4>\n`;
    } else {
      body += `<p>${trimmed.replace(/\n/g, '<br>')}</p>\n`;
    }
  }

  const images: Article['images'] = content.imagenes.map((imgUrl) => ({
    url: imgUrl,
  }));

  return {
    title: content.titulo,
    subtitle: content.bajada || undefined,
    date: content.fecha || params.fecha || undefined,
    body,
    images: images.length > 0 ? images : undefined,
    url,
    source: 'lun',
  };
}
