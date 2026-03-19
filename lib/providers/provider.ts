export type ServiceCategory =
  | "ai"
  | "infra"
  | "database"
  | "billing"
  | "source-control"
  | "knowledge"
  | "messaging"
  | "analytics"
  | "blockchain"
  | "custom";

export type ServiceDefinition = {
  id: string;
  name: string;
  category: ServiceCategory;
  enabled: boolean;
  docsUrl?: string;
};

export type ProviderMetric = {
  key: string;
  value: number;
  unit: string;
  timestamp: string;
};

export type ProviderHealth = {
  serviceId: string;
  status: "healthy" | "degraded" | "down";
  latencyMs: number;
  lastSync: string;
};

export type ProviderSnapshot = {
  service: ServiceDefinition;
  metrics: ProviderMetric[];
  health: ProviderHealth;
};

export interface ServiceProvider {
  readonly definition: ServiceDefinition;
  collectSnapshot(): Promise<ProviderSnapshot>;
}
