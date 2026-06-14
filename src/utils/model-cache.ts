// src/utils/model-cache.ts
import type { ImageModel, Model } from "@blockrun/llm";

export type ModelEntry = Model | ImageModel;
export type ModelCache = { models: ModelEntry[] | null };

type ModelLister = {
  listModels: () => Promise<Model[]>;
  listAllModels?: () => Promise<ModelEntry[]>;
};

const CACHE_TTL_MS = 5 * 60 * 1000;

// Lazily populate the shared model cache and schedule its expiry. The timer is
// unref'd so it never keeps the stdio process alive after work is done. Both the
// models tool and the models resource call through here so the fetch + TTL logic
// lives in one place.
export async function loadModels(llm: ModelLister, cache: ModelCache): Promise<ModelEntry[]> {
  if (!cache.models) {
    cache.models = llm.listAllModels
      ? await llm.listAllModels()
      : await llm.listModels();
    setTimeout(() => { cache.models = null; }, CACHE_TTL_MS).unref();
  }
  return cache.models;
}
