# Plugin Architecture

## Contract
Create providers that implement `ServiceProvider` from `lib/providers/provider.ts`.

Required output:
- `service` metadata
- normalized metrics array
- health snapshot

## Example
```ts
import type { ServiceProvider, ProviderSnapshot } from "@/lib/providers/provider";

export class MyProvider implements ServiceProvider {
  readonly definition = {
    id: "my-service",
    name: "My Service",
    category: "custom",
    enabled: true
  } as const;

  async collectSnapshot(): Promise<ProviderSnapshot> {
    return {
      service: this.definition,
      metrics: [
        { key: "requests_per_min", value: 120, unit: "rpm", timestamp: new Date().toISOString() },
        { key: "credit_burn", value: 8, unit: "usd/day", timestamp: new Date().toISOString() },
        { key: "token_usage", value: 10000, unit: "tokens", timestamp: new Date().toISOString() }
      ],
      health: {
        serviceId: this.definition.id,
        status: "healthy",
        latencyMs: 58,
        lastSync: new Date().toISOString()
      }
    };
  }
}
```

## Registering
- Import adapter in `lib/providers/registry.ts` and call `registry.register(new MyProvider())`.

## Best Practices
- Keep API auth server-side.
- Map provider-native names to normalized keys.
- Include provider latency and status to support fleet health KPIs.
