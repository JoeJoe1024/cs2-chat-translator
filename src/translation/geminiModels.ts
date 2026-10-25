import fs from "node:fs/promises";
import path from "node:path";
import { classifyGeminiModel, looksUnsuitable, sortGeminiModels } from "../shared/gemini";
import { httpError } from "./gemini";
import { TranslationError } from "./types";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const PAGE_SIZE = 1000; // the documented maximum
const MAX_PAGES = 5;

export interface GeminiModelInfo {
  /** Model id as used in `models/{id}:generateContent`. */
  id: string;
  displayName: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
}

interface RawModel {
  name?: unknown;
  baseModelId?: unknown;
  displayName?: unknown;
  description?: unknown;
  inputTokenLimit?: unknown;
  outputTokenLimit?: unknown;
  supportedGenerationMethods?: unknown;
}

/**
 * Two separate questions: can the model do text generation here (the API says `generateContent`), and is it a good fit
 * for chat translation (stable Flash / Flash-Lite series, see src/shared/gemini.ts). Both must hold.
 */
export function isTextTranslationModel(m: RawModel): boolean {
  const methods = Array.isArray(m.supportedGenerationMethods) ? (m.supportedGenerationMethods as unknown[]) : [];
  if (!methods.some((x) => typeof x === "string" && x.toLowerCase() === "generatecontent")) return false;
  const id = modelId(m);
  if (!id || !classifyGeminiModel(id)) return false;
  return !looksUnsuitable(typeof m.displayName === "string" ? m.displayName : undefined) && !looksUnsuitable(typeof m.description === "string" ? m.description : undefined);
}

function modelId(m: RawModel): string | null {
  const name = typeof m.name === "string" ? m.name : typeof m.baseModelId === "string" ? m.baseModelId : "";
  const id = name.replace(/^models\//, "");
  return /^[A-Za-z0-9._-]{1,64}$/.test(id) ? id : null;
}

export function toModelInfo(m: RawModel): GeminiModelInfo | null {
  if (!isTextTranslationModel(m)) return null;
  const id = modelId(m)!;
  return {
    id,
    displayName: typeof m.displayName === "string" && m.displayName.trim() ? m.displayName.trim().slice(0, 128) : id,
    ...(typeof m.description === "string" && m.description ? { description: m.description.slice(0, 300) } : {}),
    ...(typeof m.inputTokenLimit === "number" ? { inputTokenLimit: m.inputTokenLimit } : {}),
    ...(typeof m.outputTokenLimit === "number" ? { outputTokenLimit: m.outputTokenLimit } : {}),
  };
}

/** Calls the official `models.list` (all pages). The key travels in a header, never in the URL. */
export async function listGeminiModels(opts: { apiKey: string; fetchImpl?: typeof fetch; signal?: AbortSignal }): Promise<GeminiModelInfo[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const found = new Map<string, GeminiModelInfo>();
  let pageToken = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${ENDPOINT}?${new URLSearchParams({ pageSize: String(PAGE_SIZE), ...(pageToken ? { pageToken } : {}) })}`;
    let res: Response;
    try {
      res = await doFetch(url, { headers: { "x-goog-api-key": opts.apiKey }, ...(opts.signal ? { signal: opts.signal } : {}) });
    } catch (err) {
      throw new TranslationError(opts.signal?.aborted ? "timeout" : "network", (err as Error).message, true);
    }
    if (!res.ok) throw await httpError(res);
    let body: { models?: RawModel[]; nextPageToken?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new TranslationError("invalid", "models.list returned non-JSON");
    }
    for (const raw of body.models ?? []) {
      const info = toModelInfo(raw);
      if (info) found.set(info.id, info);
    }
    if (typeof body.nextPageToken !== "string" || !body.nextPageToken) break;
    pageToken = body.nextPageToken;
  }
  return sortGeminiModels([...found.values()]);
}

export interface ModelCache {
  fetchedAt: number;
  models: GeminiModelInfo[];
}

/** Keeps the last successful list on disk so a failed refresh never empties the dropdown. Contains no secrets. */
export class GeminiModelCache {
  private readonly file: string;
  private current: ModelCache | null = null;

  constructor(dir: string) {
    this.file = path.join(dir, "gemini-models.json");
  }

  async load(): Promise<ModelCache | null> {
    try {
      const v = JSON.parse(await fs.readFile(this.file, "utf8")) as ModelCache;
      if (typeof v.fetchedAt === "number" && Array.isArray(v.models)) this.current = v;
    } catch {
      this.current = null;
    }
    return this.current;
  }

  get(): ModelCache | null {
    return this.current;
  }

  async save(models: GeminiModelInfo[]): Promise<ModelCache> {
    this.current = { fetchedAt: Date.now(), models };
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(this.current), "utf8");
    } catch {
      /* the in-memory copy still works */
    }
    return this.current;
  }
}
