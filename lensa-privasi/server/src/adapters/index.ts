import type { ModelAdapter } from '../adapter.ts';
import type { ModelId } from '../domain.ts';

// Tasks 6-8 each register their model here.
export async function loadAdapters(): Promise<Partial<Record<ModelId, ModelAdapter>>> {
  return {};
}
