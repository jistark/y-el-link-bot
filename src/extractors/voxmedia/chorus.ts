/**
 * Chorus extractor — Vox Media's flagship CMS, used by theverge.com, vox.com,
 * eater.com, polygon.com, sbnation.com, thedodo.com, thrillist.com,
 * popsugar.com.
 *
 * Strategy: read JSON-LD `articleBody`. Chorus consistently emits the full
 * article body as plain text in the JSON-LD block, so we don't need to
 * touch the rendered DOM (which would force us to handle ads, embeds,
 * pull-quotes, related-article cards, etc. — all already filtered out of
 * articleBody by the CMS).
 *
 * Replaces the previous standalone theverge.ts.
 */

import type { Article } from '../../types.js';
import {
  type JsonLdArticle,
  findArticleNode,
  extractImage,
} from '../helpers/json-ld.js';
import { articleBodyToHtml, authorsFromJsonLd } from './shared.js';

function findArticleWithBody(html: string): JsonLdArticle | null {
  const matches = html.matchAll(
    /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g,
  );
  let firstArticle: JsonLdArticle | null = null;
  for (const m of matches) {
    try {
      const found = findArticleNode(JSON.parse(m[1]));
      if (!found) continue;
      if (found.articleBody) return found; // prefer the one with body
      if (!firstArticle) firstArticle = found; // fallback to any article
    } catch {
      // malformed JSON — skip
    }
  }
  return firstArticle;
}

export function parseChorusArticle(html: string): Partial<Article> | null {
  const article = findArticleWithBody(html);
  if (!article?.articleBody) return null;
  if (!article.headline && !article.name) return null;

  const body = articleBodyToHtml(article.articleBody);
  if (!body) return null;

  const cover = extractImage(article.image);

  return {
    title: article.headline || article.name,
    subtitle: article.description,
    author: authorsFromJsonLd(article.author),
    date: article.datePublished,
    body,
    images: cover ? [{ url: cover }] : undefined,
  };
}
