"use client";

import { useMemo, useRef, useState, type DragEvent } from "react";
import { Download, FileArchive, FileText, Link2, LoaderCircle, ScanSearch, ShieldAlert, Upload } from "lucide-react";

type JobRecord = {
  source: string;
  markdownPath?: string;
  sourceUrl?: string;
  status: "processed" | "skipped" | "failed";
  extractor: string;
  sizeBytes: number;
  error?: string;
};

type JobResult = {
  jobId: string;
  createdAt: string;
  inputCount: number;
  processedCount: number;
  failedCount: number;
  outputDirectory: string;
  zipPath: string;
  zipUrl: string;
  manifestPath: string;
  summaryPath: string;
  records: JobRecord[];
};

const tips = [
  "Paste public Google Drive file or folder links, one per line.",
  "Paste a local Windows file path for very large PST files so the app can process them directly from disk.",
  "Drop screenshots, PDFs, Office docs, spreadsheets, ZIP archives, PST mailboxes, and text exports together.",
  "Each run is saved locally with Markdown outputs, companion exports, a manifest, and a zip export."
];

export function KnowledgeIngestShell() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [urls, setUrls] = useState("");
  const [paths, setPaths] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JobResult | null>(null);

  const stats = useMemo(
    () => ({
      urlCount: urls.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).length,
      pathCount: paths.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).length,
      uploadCount: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0)
    }),
    [files, paths, urls]
  );

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const dropped = Array.from(event.dataTransfer.files || []);
    if (dropped.length) {
      setFiles((current) => dedupeFiles([...current, ...dropped]));
    }
  };

  const runIngestion = async () => {
    setIsRunning(true);
    setError(null);

    try {
      const formData = new FormData();
      for (const file of files) {
        formData.append("files", file);
      }
      formData.append("urls", urls);
      formData.append("paths", paths);

      const response = await fetch("/api/ingest", { method: "POST", body: formData });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Ingestion failed.");
      }
      setResult(payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Ingestion failed.");
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(255,190,92,0.16),_transparent_30%),radial-gradient(circle_at_bottom_right,_rgba(88,186,255,0.18),_transparent_28%),linear-gradient(180deg,_#faf5ea_0%,_#f4efe5_100%)] px-4 py-8 text-stone-900 md:px-8">
      <section className="mx-auto grid w-full max-w-7xl gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="rounded-[28px] border border-stone-300/70 bg-white/80 p-6 shadow-[0_18px_80px_rgba(79,55,24,0.12)] backdrop-blur md:p-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-2xl">
              <p className="text-xs font-semibold uppercase tracking-[0.32em] text-amber-700">Workplace Evidence Markdown Lab</p>
              <h1 className="mt-3 font-serif text-4xl leading-tight text-stone-950 md:text-5xl">
                Turn raw evidence into organized Markdown your AI stack can actually use.
              </h1>
              <p className="mt-4 max-w-xl text-sm leading-6 text-stone-600 md:text-base">
                Drop files, paste public Google Drive links, and generate a structured Markdown export for screenshots,
                PDFs, spreadsheets, emails, HTML pages, and mixed archives.
              </p>
            </div>

            <div className="rounded-3xl border border-stone-200 bg-stone-950 px-5 py-4 text-stone-50 shadow-[0_12px_40px_rgba(28,25,23,0.24)]">
              <p className="text-xs uppercase tracking-[0.24em] text-amber-300">This run</p>
              <div className="mt-3 space-y-3 text-sm">
                <Stat label="Uploads" value={String(stats.uploadCount)} />
                <Stat label="URLs" value={String(stats.urlCount)} />
                <Stat label="Local paths" value={String(stats.pathCount)} />
                <Stat label="Payload" value={formatBytes(stats.totalBytes)} />
              </div>
            </div>
          </div>

          <div
            onDrop={onDrop}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            className={`mt-8 rounded-[28px] border-2 border-dashed p-6 transition md:p-8 ${
              isDragging
                ? "border-sky-500 bg-sky-50 shadow-[inset_0_0_0_1px_rgba(14,165,233,0.28)]"
                : "border-stone-300 bg-stone-50/80"
            }`}
          >
            <div className="flex flex-col items-start gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="flex items-center gap-3">
                  <div className="rounded-2xl bg-stone-950 p-3 text-amber-300">
                    <Upload className="h-5 w-5" />
                  </div>
                  <div>
                    <h2 className="text-xl font-semibold text-stone-950">Drop evidence here</h2>
                    <p className="text-sm text-stone-600">Files stay local to this app and are written into a timestamped job folder.</p>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-2 text-xs text-stone-600">
                  {["PDF", "DOCX", "PNG/JPG", "CSV/XLSX", "ZIP", "HTML", "TXT", "EML", "PST"].map((tag) => (
                    <span key={tag} className="rounded-full border border-stone-300 bg-white px-3 py-1">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>

              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="rounded-full bg-stone-950 px-5 py-3 text-sm font-medium text-white transition hover:bg-stone-800"
              >
                Choose files
              </button>
            </div>

            <input
              ref={inputRef}
              type="file"
              multiple
              onChange={(event) => setFiles((current) => dedupeFiles([...current, ...Array.from(event.target.files || [])]))}
              className="hidden"
            />

            <div className="mt-6 rounded-3xl border border-stone-200 bg-white p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium text-stone-800">
                <FileArchive className="h-4 w-4 text-amber-700" />
                Selected files
              </div>
              <div className="max-h-56 space-y-2 overflow-auto pr-1 text-sm text-stone-600">
                {files.length ? (
                  files.map((file) => (
                    <div key={`${file.name}-${file.size}-${file.lastModified}`} className="flex items-center justify-between rounded-2xl bg-stone-50 px-3 py-2">
                      <span className="truncate pr-4">{file.name}</span>
                      <span className="shrink-0 text-xs text-stone-500">{formatBytes(file.size)}</span>
                    </div>
                  ))
                ) : (
                  <p className="rounded-2xl bg-stone-50 px-3 py-4 text-stone-500">No files selected yet.</p>
                )}
              </div>
            </div>
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_1fr]">
            <div className="rounded-[28px] border border-stone-300 bg-[#fffaf2] p-5">
              <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.2em] text-amber-800">
                <Link2 className="h-4 w-4" />
                Remote sources
              </div>
              <textarea
                value={urls}
                onChange={(event) => setUrls(event.target.value)}
                placeholder={"https://drive.google.com/drive/folders/...\nhttps://drive.google.com/file/d/...\nhttps://example.com/report.pdf"}
                className="mt-3 min-h-56 w-full resize-y rounded-3xl border border-stone-300 bg-white px-4 py-4 text-sm leading-6 text-stone-800 outline-none transition placeholder:text-stone-400 focus:border-sky-500"
              />
            </div>

            <div className="rounded-[28px] border border-stone-300 bg-white p-5">
              <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.2em] text-sky-800">
                <FileArchive className="h-4 w-4" />
                Local paths for large files
              </div>
              <textarea
                value={paths}
                onChange={(event) => setPaths(event.target.value)}
                placeholder={"C:\\Users\\AlexT\\Documents\\mailbox.pst\nC:\\Users\\AlexT\\Documents\\evidence-folder"}
                className="mt-3 min-h-56 w-full resize-y rounded-3xl border border-stone-300 bg-stone-50 px-4 py-4 text-sm leading-6 text-stone-800 outline-none transition placeholder:text-stone-400 focus:border-sky-500"
              />
              <p className="mt-3 text-sm leading-6 text-stone-600">
                Use this for very large PST files or folders you do not want to upload through the browser first.
              </p>
            </div>
          </div>

          <div className="mt-4 rounded-[28px] border border-stone-300 bg-stone-950 p-5 text-stone-50">
              <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.2em] text-amber-300">
                <ScanSearch className="h-4 w-4" />
                Pipeline notes
              </div>
              <div className="mt-4 space-y-3 text-sm leading-6 text-stone-300">
                {tips.map((tip) => (
                  <p key={tip}>{tip}</p>
                ))}
              </div>
              <button
                type="button"
                disabled={isRunning}
                onClick={runIngestion}
                className="mt-6 inline-flex items-center gap-2 rounded-full bg-amber-300 px-5 py-3 text-sm font-semibold text-stone-950 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isRunning ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                {isRunning ? "Building Markdown..." : "Run ingestion"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setFiles([]);
                  setUrls("");
                  setPaths("");
                  setResult(null);
                  setError(null);
                }}
                className="mt-3 block text-sm text-stone-400 underline-offset-4 hover:text-white hover:underline"
              >
                Reset batch
              </button>
            </div>

          {error && (
            <div className="mt-6 flex items-start gap-3 rounded-[24px] border border-red-200 bg-red-50 px-4 py-4 text-sm text-red-800">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <p>{error}</p>
            </div>
          )}
        </div>

        <aside className="space-y-6">
          <div className="rounded-[28px] border border-stone-300/70 bg-white/82 p-6 shadow-[0_18px_70px_rgba(79,55,24,0.1)]">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-sky-700">Output shape</p>
            <div className="mt-4 space-y-4 text-sm leading-6 text-stone-600">
              <p>Every run creates a local job folder with raw copies, converted Markdown, a manifest JSON file, and a zip export.</p>
              <p>Markdown is organized by original path when available, so a large evidence set stays navigable instead of collapsing into one blob.</p>
              <p>Images use OCR, ZIP files are unpacked recursively, and spreadsheets are flattened into Markdown tables for downstream AI analysis.</p>
            </div>
          </div>

          <div className="rounded-[28px] border border-stone-300/70 bg-[#1c1917] p-6 text-stone-50 shadow-[0_18px_70px_rgba(28,25,23,0.24)]">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-300">Latest run</p>
            {result ? (
              <div className="mt-4 space-y-4">
                <div className="grid grid-cols-3 gap-3 text-center text-sm">
                  <PanelStat label="Inputs" value={String(result.inputCount)} />
                  <PanelStat label="Done" value={String(result.processedCount)} />
                  <PanelStat label="Failed" value={String(result.failedCount)} />
                </div>
                <div className="rounded-3xl border border-stone-700 bg-stone-900/60 p-4 text-sm text-stone-300">
                  <p><span className="text-stone-500">Job ID:</span> {result.jobId}</p>
                  <p className="mt-2 break-all"><span className="text-stone-500">Markdown:</span> {result.outputDirectory}</p>
                  <p className="mt-2 break-all"><span className="text-stone-500">Manifest:</span> {result.manifestPath}</p>
                </div>
                <a
                  href={result.zipUrl}
                  className="inline-flex items-center gap-2 rounded-full bg-sky-400 px-5 py-3 text-sm font-semibold text-stone-950 transition hover:bg-sky-300"
                >
                  <Download className="h-4 w-4" />
                  Download Markdown zip
                </a>
                <div className="max-h-[28rem] space-y-2 overflow-auto pr-1">
                  {result.records.slice(0, 40).map((record) => (
                    <div key={`${record.source}-${record.extractor}-${record.status}`} className="rounded-3xl border border-stone-700 bg-stone-900/60 p-3 text-sm">
                      <div className="flex items-start justify-between gap-3">
                        <p className="break-all font-medium text-stone-100">{record.source}</p>
                        <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] ${
                          record.status === "processed" ? "bg-emerald-500/20 text-emerald-300" : "bg-red-500/20 text-red-300"
                        }`}>
                          {record.status}
                        </span>
                      </div>
                      <p className="mt-2 text-xs uppercase tracking-[0.18em] text-stone-500">{record.extractor}</p>
                      {record.error && <p className="mt-2 text-sm text-red-300">{record.error}</p>}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="mt-4 text-sm leading-6 text-stone-400">Run a batch to see output locations and a preview of processed files.</p>
            )}
          </div>
        </aside>
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-stone-400">{label}</span>
      <span className="font-semibold text-white">{value}</span>
    </div>
  );
}

function PanelStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-3xl border border-stone-700 bg-stone-900/60 px-3 py-4">
      <p className="text-xs uppercase tracking-[0.18em] text-stone-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-white">{value}</p>
    </div>
  );
}

function dedupeFiles(files: File[]): File[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function formatBytes(value: number): string {
  if (!value) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}
