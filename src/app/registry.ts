/**
 * Tool registration. A tool is metadata (shown in navigation and search) plus, once built, a
 * loader for its module. Modules load on first use, so adding tools does not grow the startup
 * bundle, and the shell never needs to change when a tool is added.
 */
import type { Prefs } from './prefs';
import type { ShareOffer } from './share';

export interface Category {
  readonly id: string;
  readonly name: string;
}

export interface ToolServices {
  readonly prefs: Prefs;
  /** Copies text and confirms it to the user; `what` names the copied thing ("network address"). */
  copy(text: string, what: string): Promise<boolean>;
  /** Saves text as a file in the user's downloads. */
  download(filename: string, text: string, mime: string): void;
  /** Reads a message to screen reader users without moving focus. */
  announce(message: string): void;
}

/**
 * A tool's settings links (see share.ts). Only tools whose settings are harmless have one; the
 * others share their route and nothing else.
 */
export interface ToolShare {
  /** What a settings link would carry now: validated settings and a line for each, or why there is none. */
  offer(): ShareOffer;
  /**
   * Applies settings read from a link. Every value is checked before anything changes: on false the
   * tool is left exactly as it was. Applying never runs, generates or downloads anything.
   */
  apply(params: ReadonlyMap<string, string>): boolean;
}

export interface ToolInstance {
  /** Called each time the tool's view is shown again. */
  activate?(): void;
  readonly share?: ToolShare;
}

export interface ToolModule {
  mount(host: HTMLElement, services: ToolServices, meta: ToolMeta, categoryName: string): ToolInstance | void;
}

interface ToolBase {
  /** URL slug and storage-safe id: lowercase letters, digits and hyphens. */
  readonly id: string;
  readonly name: string;
  readonly category: string;
  /** One sentence for navigation, search and the home page. */
  readonly summary: string;
  readonly keywords: readonly string[];
}

export interface AvailableTool extends ToolBase {
  readonly status: 'available';
  readonly load: () => Promise<ToolModule>;
}

export interface PlannedTool extends ToolBase {
  readonly status: 'planned';
}

export type ToolMeta = AvailableTool | PlannedTool;

const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Ids the router uses for its own pages. */
const RESERVED_IDS = new Set(['about', 'home']);

export class ToolRegistry {
  private readonly categories: Category[] = [];
  private readonly tools: ToolMeta[] = [];
  private readonly byId = new Map<string, ToolMeta>();

  addCategory(category: Category): this {
    if (!ID_PATTERN.test(category.id)) throw new Error(`Invalid category id "${category.id}"`);
    if (this.categories.some(c => c.id === category.id)) throw new Error(`Duplicate category "${category.id}"`);
    if (category.name.trim() === '') throw new Error(`Category "${category.id}" needs a name`);
    this.categories.push(category);
    return this;
  }

  add(tool: ToolMeta): this {
    if (!ID_PATTERN.test(tool.id) || tool.id.length > 64) throw new Error(`Invalid tool id "${tool.id}"`);
    if (RESERVED_IDS.has(tool.id)) throw new Error(`Tool id "${tool.id}" is reserved`);
    if (this.byId.has(tool.id)) throw new Error(`Duplicate tool id "${tool.id}"`);
    if (!this.categories.some(c => c.id === tool.category)) throw new Error(`Tool "${tool.id}" has unknown category "${tool.category}"`);
    if (tool.name.trim() === '' || tool.summary.trim() === '') throw new Error(`Tool "${tool.id}" needs a name and a summary`);
    if (tool.status === 'available' && typeof tool.load !== 'function') throw new Error(`Available tool "${tool.id}" needs a loader`);
    this.tools.push(tool);
    this.byId.set(tool.id, tool);
    return this;
  }

  get(id: string): ToolMeta | undefined {
    return this.byId.get(id);
  }

  list(): readonly ToolMeta[] {
    return this.tools;
  }

  listCategories(): readonly Category[] {
    return this.categories;
  }

  inCategory(categoryId: string): readonly ToolMeta[] {
    return this.tools.filter(t => t.category === categoryId);
  }

  categoryName(categoryId: string): string {
    return this.categories.find(c => c.id === categoryId)?.name ?? categoryId;
  }
}
