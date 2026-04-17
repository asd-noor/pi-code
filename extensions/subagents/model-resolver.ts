/**
 * model-resolver.ts — Fuzzy model resolution from a short name or full id.
 *
 * Priority: exact "provider/modelId" match → fuzzy substring/part match.
 * Returns the Model instance on success, or an error string on failure.
 */

export interface ModelEntry {
  id: string;
  name: string;
  provider: string;
}

export interface ModelRegistry {
  find(provider: string, modelId: string): any;
  getAll(): any[];
  getAvailable?(): any[];
}

/**
 * Resolve a model string (exact or fuzzy) to a Model instance.
 * Only considers models that have auth configured (available).
 */
export function resolveModel(
  input: string,
  registry: ModelRegistry,
): any | string {
  const available = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];

  // 1. Exact "provider/modelId" match
  const slash = input.indexOf("/");
  if (slash !== -1) {
    const provider = input.slice(0, slash);
    const modelId = input.slice(slash + 1);
    const found = registry.find(provider, modelId);
    if (found) return found;
  }

  // 2. Fuzzy match: score each available model
  const query = input.toLowerCase();
  let bestMatch: ModelEntry | undefined;
  let bestScore = 0;

  for (const m of available) {
    const id = m.id.toLowerCase();
    const name = m.name.toLowerCase();
    const full = `${m.provider}/${m.id}`.toLowerCase();

    let score = 0;
    if (id === query || full === query) {
      score = 100;
    } else if (id.includes(query) || full.includes(query)) {
      score = 60 + (query.length / id.length) * 30;
    } else if (name.includes(query)) {
      score = 40 + (query.length / name.length) * 20;
    } else if (
      query.split(/[\s\-/]+/).every(
        (part) => id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part),
      )
    ) {
      score = 20;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = m;
    }
  }

  if (bestMatch && bestScore >= 20) {
    const found = registry.find(bestMatch.provider, bestMatch.id);
    if (found) return found;
  }

  // 3. Not found — list available models
  const list = available
    .map((m) => `  ${m.provider}/${m.id}`)
    .sort()
    .join("\n");
  return `Model not found: "${input}".\n\nAvailable models:\n${list}`;
}

/** Extract a short display label from a model id string. */
export function modelLabel(modelId: string): string {
  const name = modelId.includes("/") ? modelId.split("/").pop()! : modelId;
  return name.replace(/-\d{8}$/, ""); // strip date suffix
}
