import { serviceCatalog } from "@/lib/providers/catalog";
import type { ProviderSnapshot, ServiceProvider } from "@/lib/providers/provider";

class SimulatedProvider implements ServiceProvider {
  constructor(public readonly definition = serviceCatalog[0]) {}

  async collectSnapshot(): Promise<ProviderSnapshot> {
    const now = new Date();
    const jitter = Math.floor(Math.random() * 120);
    const errors = Math.floor(Math.random() * 4);

    return {
      service: this.definition,
      metrics: [
        { key: "requests_per_min", value: 400 + jitter, unit: "rpm", timestamp: now.toISOString() },
        { key: "credit_burn", value: 95 + jitter / 10, unit: "usd/day", timestamp: now.toISOString() },
        { key: "token_usage", value: 120_000 + jitter * 150, unit: "tokens", timestamp: now.toISOString() }
      ],
      health: {
        serviceId: this.definition.id,
        status: errors > 2 ? "degraded" : "healthy",
        latencyMs: 65 + jitter,
        lastSync: now.toISOString()
      }
    };
  }
}

export function buildBuiltinProviders(): ServiceProvider[] {
  return serviceCatalog.map((service) => new SimulatedProvider(service));
}
