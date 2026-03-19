import { buildBuiltinProviders } from "@/lib/providers/builtin";
import type { ProviderSnapshot, ServiceProvider } from "@/lib/providers/provider";

export class ProviderRegistry {
  private readonly providers = new Map<string, ServiceProvider>();

  register(provider: ServiceProvider) {
    this.providers.set(provider.definition.id, provider);
  }

  listProviders() {
    return Array.from(this.providers.values());
  }

  async collectAll(): Promise<ProviderSnapshot[]> {
    return Promise.all(this.listProviders().map((provider) => provider.collectSnapshot()));
  }
}

export const registry = new ProviderRegistry();

for (const provider of buildBuiltinProviders()) {
  registry.register(provider);
}
