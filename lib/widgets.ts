export type WidgetKind =
  | "model-usage"
  | "gpu-compute"
  | "api-credit"
  | "deployment-status"
  | "agent-health"
  | "revenue";

export type WidgetConfig = {
  id: string;
  kind: WidgetKind;
  title: string;
  value: string;
  detail: string;
  trend: string;
  status: "ok" | "warn" | "critical";
};

export const defaultWidgets: WidgetConfig[] = [
  {
    id: "w-model-usage",
    kind: "model-usage",
    title: "AI Model Usage",
    value: "14.2M tokens",
    detail: "OpenAI + Azure + ZEN Arena",
    trend: "+8.3%",
    status: "ok"
  },
  {
    id: "w-gpu-compute",
    kind: "gpu-compute",
    title: "GPU / Compute",
    value: "83.7%",
    detail: "HF Spaces + GCP + Azure",
    trend: "+4 nodes",
    status: "warn"
  },
  {
    id: "w-api-credit",
    kind: "api-credit",
    title: "API Credit Burn",
    value: "$18,920",
    detail: "MTD across providers",
    trend: "-2.1%",
    status: "ok"
  },
  {
    id: "w-deploy",
    kind: "deployment-status",
    title: "Deployment Status",
    value: "47/50 healthy",
    detail: "Vercel + GitHub Actions",
    trend: "3 degraded",
    status: "warn"
  },
  {
    id: "w-agent-health",
    kind: "agent-health",
    title: "Agent Health",
    value: "96.1%",
    detail: "Heartbeat and task SLA",
    trend: "2 alerts",
    status: "critical"
  },
  {
    id: "w-revenue",
    kind: "revenue",
    title: "Revenue Streams",
    value: "$248,300",
    detail: "Stripe + on-chain ledger",
    trend: "+11.4%",
    status: "ok"
  }
];
