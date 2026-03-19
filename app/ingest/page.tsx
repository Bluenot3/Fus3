import type { Metadata } from "next";
import { KnowledgeIngestShell } from "@/components/knowledge-ingest-shell";

export const metadata: Metadata = {
  title: "Knowledge Ingest",
  description: "Convert files, folders, and remote links into structured Markdown outputs"
};

export default function IngestPage() {
  return <KnowledgeIngestShell />;
}
