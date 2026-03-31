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

export async function extract(url: string): Promise<Article> {
  // Bloomberg uses Cloudflare — requires TLS impersonation
  const html = await fetchBypass(url, 'https://www.google.com/');

  // Bloomberg stores article data in __NEXT_DATA__
  const nextDataMatch = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );

  if (!nextDataMatch) {
    throw new Error('No se encontró __NEXT_DATA__ en Bloomberg');
  }

  const nextData = JSON.parse(nextDataMatch[1]);
  const story = nextData?.props?.pageProps?.story;

  if (!story) {
    throw new Error('No se encontró story en Bloomberg __NEXT_DATA__');
  }

  const title = story.headline || story.title;
  if (!title) {
    throw new Error('No se pudo extraer el título de Bloomberg');
  }

  // Extract body from structured content
  let body = '';
  if (story.body?.content) {
    body = extractText(story.body.content);
  }

  if (!body) {
    throw new Error('No se pudo extraer el contenido de Bloomberg');
  }

  // Extract author(s)
  const authors = (story.authors || [])
    .map((a: { name?: string }) => a.name)
    .filter(Boolean);

  // Extract image
  const imageUrl =
    story.ledeImageUrl ||
    story.thumbnailImage?.url ||
    story.socialImage?.url;

  return {
    title,
    subtitle: story.abstract || story.summary,
    author: authors.length > 0 ? authors.join(', ') : undefined,
    date: story.publishedAt || story.updatedAt,
    body,
    images: imageUrl ? [{ url: imageUrl }] : undefined,
    url,
    source: 'bloomberg',
  };
}
