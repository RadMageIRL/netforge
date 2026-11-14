/**
 * Tool search. Every word of the query must match the tool somewhere (name, keywords, category or
 * summary). Matches in the name rank above keyword matches, which rank above category and summary
 * matches; ties keep catalog order, with built tools ahead of planned ones.
 */
import type { ToolMeta } from './registry';

export interface SearchableTool {
  readonly tool: ToolMeta;
  readonly categoryName: string;
}

export function normalizeQuery(query: string): string[] {
  return query.toLowerCase().split(/[ \t]+/).map(t => t.trim()).filter(Boolean);
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Score for one query term, or 0 when the term matches nothing. */
function termScore(term: string, entry: SearchableTool): number {
  const name = entry.tool.name.toLowerCase();
  if (words(name).some(w => w === term)) return 100;
  if (words(name).some(w => w.startsWith(term))) return 80;
  if (name.includes(term)) return 60;
  const keywords = entry.tool.keywords.map(k => k.toLowerCase());
  if (keywords.some(k => k === term)) return 50;
  if (keywords.some(k => k.startsWith(term) || words(k).some(w => w.startsWith(term)))) return 40;
  if (words(entry.categoryName).some(w => w.startsWith(term))) return 20;
  if (term.length >= 3 && entry.tool.summary.toLowerCase().includes(term)) return 10;
  return 0;
}

export function searchTools(entries: readonly SearchableTool[], query: string): ToolMeta[] {
  const terms = normalizeQuery(query);
  if (terms.length === 0) return entries.map(e => e.tool);
  const scored: { tool: ToolMeta; score: number; order: number }[] = [];
  entries.forEach((entry, order) => {
    let score = 0;
    for (const term of terms) {
      const s = termScore(term, entry);
      if (s === 0) return;
      score += s;
    }
    if (entry.tool.status === 'available') score += 1;
    scored.push({ tool: entry.tool, score, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.map(s => s.tool);
}
