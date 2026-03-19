const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

export type OllamaModel = {
  name: string;
  model: string;
  modifiedAt: string | null;
  size: number | null;
  parameterSize: string | null;
  family: string | null;
};

export function getOllamaBaseUrl(override?: string | null): string {
  return (override?.trim() || process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "");
}

export async function listOllamaModels(override?: string | null): Promise<OllamaModel[]> {
  const baseUrl = getOllamaBaseUrl(override);
  const response = await fetch(`${baseUrl}/api/tags`, {
    method: "GET",
    cache: "no-store"
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama request failed (${response.status}): ${body || response.statusText}`);
  }

  const payload = (await response.json()) as {
    models?: Array<{
      name?: string;
      model?: string;
      modified_at?: string;
      size?: number;
      details?: { parameter_size?: string; family?: string };
    }>;
  };

  return (payload.models ?? []).map((entry) => ({
    name: entry.name || entry.model || "unknown",
    model: entry.model || entry.name || "unknown",
    modifiedAt: entry.modified_at ?? null,
    size: typeof entry.size === "number" ? entry.size : null,
    parameterSize: entry.details?.parameter_size ?? null,
    family: entry.details?.family ?? null
  }));
}
