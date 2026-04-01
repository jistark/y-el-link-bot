import type { Article } from '../types.js';
import { fetchBypass } from './fetch-bypass.js';

interface BloombergBodyNode {
  type: string;
  value?: string;
  content?: BloombergBodyNode[];
  data?: Record<string, unknown>;
}

function extractText(nodes: BloombergBodyNode[]): string {
  const paragraphs: string[] = [];

  for (const block of nodes) {
    if (block.type === 'paragraph' && block.content) {
      let text = '';
      for (const node of block.content) {
        text += collectText(node);
      }
      if (text.trim()) paragraphs.push(text.trim());
    } else if (block.type === 'heading' && block.content) {
      let text = '';
      for (const node of block.content) {
        text += collectText(node);
      }
      if (text.trim()) paragraphs.push(`<h4>${text.trim()}</h4>`);
    }
  }

  return paragraphs
    .map((p) => (p.startsWith('<h4>') ? p : `<p>${p}</p>`))
    .join('\n');
}

function collectText(node: BloombergBodyNode): string {
  if (node.type === 'text') return node.value || '';
  if (node.content) return node.content.map(collectText).join('');
  return '';
}

function extractFromNextData(html: string): Partial<Article> | null {
  const nextDataMatch = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!nextDataMatch) return null;

  try {
    const nextData = JSON.parse(nextDataMatch[1]);
    const story = nextData?.props?.pageProps?.story;
    if (!story?.body?.content) return null;

    const body = extractText(story.body.content);
    if (!body) return null;

    const authors = (story.authors || [])
      .map((a: { name?: string }) => a.name)
      .filter(Boolean);

    return {
      title: story.headline || story.title,
      subtitle: story.abstract || story.summary,
      author: authors.length > 0 ? authors.join(', ') : undefined,
      date: story.publishedAt || story.updatedAt,
      body,
      images: (story.ledeImageUrl || story.thumbnailImage?.url)
        ? [{ url: story.ledeImageUrl || story.thumbnailImage?.url }]
        : undefined,
    };
  } catch {
    return null;
  }
}

function extractFromHtml(html: string): Partial<Article> | null {
  // Fallback: og:meta + article paragraphs
  const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/);
  const title = ogTitle?.[1]?.replace(/ - Bloomberg$/, '');
  if (!title) return null;

  // Extraer párrafos del artículo
  const paragraphs: string[] = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = pRegex.exec(html)) !== null) {
    const text = m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    if (text.length > 40) paragraphs.push(text);
  }
  if (paragraphs.length < 2) return null;

  const ogDesc = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/);
  const ogImage = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);
  const authorMeta = html.match(/<meta\s+name="author"\s+content="([^"]+)"/);
  const dateMeta = html.match(/<meta\s+property="article:published_time"\s+content="([^"]+)"/);

  return {
    title,
    subtitle: ogDesc?.[1],
    author: authorMeta?.[1],
    date: dateMeta?.[1],
    body: paragraphs.map((p) => `<p>${p}</p>`).join('\n'),
    images: ogImage ? [{ url: ogImage[1] }] : undefined,
  };
}

export async function extract(url: string): Promise<Article> {
  const html = await fetchBypass(url, 'https://www.google.com/');

  // Try __NEXT_DATA__ first (structured data), then HTML fallback
  const data = extractFromNextData(html) || extractFromHtml(html);

  if (!data?.title || !data?.body) {
    throw new Error('No se pudo extraer el contenido de Bloomberg');
  }

  return {
    title: data.title,
    subtitle: data.subtitle,
    author: data.author,
    date: data.date,
    body: data.body,
    images: data.images,
    url,
    source: 'bloomberg',
  };
}
