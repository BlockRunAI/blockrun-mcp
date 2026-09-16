// src/utils/model-cache.ts
import type { ImageModel, Model } from "@blockrun/llm";

export type ModelEntry = Model | ImageModel;
export type ModelCache = {
  models: ModelEntry[] | null;
  /** Which rail+chain the cached list came from — see loadModels. */
  key?: string;
  /** In-flight fetch, so concurrent callers share one request. */
  inflight?: Promise<ModelEntry[]>;
};

type ModelLister = {
  listModels: () => Promise<Model[]>;
  listAllModels?: () => Promise<ModelEntry[]>;
};

const CACHE_TTL_MS = 5 * 60 * 1000;

// Lazily populate the shared model cache and schedule its expiry. The timer is
// unref'd so it never keeps the stdio process alive after work is done. Both the
// models tool and the models resource call through here so the fetch + TTL logic
// lives in one place.
export async function loadModels(
  llm: ModelLister,
  cache: ModelCache,
  /**
   * Which catalogue this list belongs to. The two gateways do NOT serve the
   * same one (measured 2026-09-09: 78 chat models on Base, 83 on Solana), and
   * the account rail is a third. Without a key, `blockrun_wallet action:"chain"`
   * left the previous chain's catalogue in place for the rest of the 5-minute
   * TTL, so blockrun_models answered for a gateway the user had just left.
   * Callers pass the active rail+chain; a changed key re-fetches.
   */
  key = "default",
): Promise<ModelEntry[]> {
  // Treat an empty array as "not loaded" too: `![]` is false, so a transient
  // empty upstream result would otherwise be pinned as a valid cache for the
  // whole TTL ("Models (0):") and never re-fetched even after recovery.
  const stale = cache.models === null || cache.models.length === 0 || cache.key !== key;
  if (!stale) return cache.models as ModelEntry[];

  // Share one request between concurrent callers (the tool and the resource can
  // both be answering at once). Keyed with the fetch so a chain switch mid-flight
  // does not adopt the wrong catalogue.
  if (!cache.inflight || cache.key !== key) {
    cache.key = key;
    cache.inflight = (llm.listAllModels ? llm.listAllModels() : llm.listModels())
      .then((models) => {
        // Only publish if nobody switched rails while we were waiting.
        if (cache.key === key) {
          cache.models = models;
          setTimeout(() => { if (cache.key === key) cache.models = null; }, CACHE_TTL_MS).unref();
        }
        return models;
      })
      .finally(() => { if (cache.key === key) cache.inflight = undefined; });
  }
  return cache.inflight;
}

/** The catalogue key for the active rail+chain. */
export function modelCacheKey(mode: string, chain: string): string {
  return mode === "api-key" ? "account" : `wallet:${chain}`;
}
