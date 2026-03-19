"use client";

import { Globe, Mail, Phone, RefreshCcw, Users } from "lucide-react";
import { useEffect, useState } from "react";

type WixContactSummary = {
  id: string;
  fullName: string;
  primaryEmail: string | null;
  primaryPhone: string | null;
  createdDate: string | null;
  lastActivityDate: string | null;
};

type WixSiteSummary = {
  id: string;
  displayName: string;
  status?: string;
  createdDate?: string;
};

type WixOverview = {
  accountId: string | null;
  siteId: string;
  siteName: string;
  businessName: string | null;
  siteDescription: string | null;
  logoUrl: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  timezone: string | null;
  locale: string | null;
  language: string | null;
  currency: string | null;
  urls: string[];
  recentContacts: WixContactSummary[];
  availableSites: WixSiteSummary[];
};

type WixState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; overview: WixOverview };

function formatDate(value: string | null): string {
  if (!value) {
    return "Unknown";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

export function WixCommandCenter() {
  const [state, setState] = useState<WixState>({ status: "loading" });
  const [isRefreshing, setIsRefreshing] = useState(false);

  const load = async () => {
    setIsRefreshing(true);

    try {
      const response = await fetch("/api/wix/overview", { cache: "no-store" });
      const payload = (await response.json()) as { ok: boolean; overview?: WixOverview; error?: string };

      if (!response.ok || !payload.ok || !payload.overview) {
        throw new Error(payload.error || "Failed to load Wix overview.");
      }

      setState({ status: "ready", overview: payload.overview });
    } catch (error) {
      setState({
        status: "error",
        error: error instanceof Error ? error.message : "Failed to load Wix overview."
      });
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(255,193,92,0.18),_transparent_28%),radial-gradient(circle_at_bottom_right,_rgba(0,174,255,0.18),_transparent_24%),linear-gradient(180deg,_#f7f0e4_0%,_#efe6d7_100%)] px-4 py-8 text-stone-900 md:px-8">
      <section className="mx-auto flex w-full max-w-7xl flex-col gap-5">
        <header className="rounded-[30px] border border-stone-300/80 bg-white/85 p-6 shadow-[0_20px_80px_rgba(78,51,20,0.14)] backdrop-blur md:p-8">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.32em] text-amber-700">Phone + Laptop Command Center</p>
              <h1 className="mt-3 font-serif text-4xl leading-tight text-stone-950 md:text-5xl">Wix operations at a glance.</h1>
              <p className="mt-4 text-sm leading-6 text-stone-600 md:text-base">
                See the live site context your command center can act on: business profile, public URLs, and recent leads pulled server-side from Wix.
              </p>
            </div>

            <button
              type="button"
              onClick={() => void load()}
              disabled={isRefreshing}
              className="inline-flex items-center gap-2 self-start rounded-full bg-stone-950 px-5 py-3 text-sm font-medium text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCcw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
              Refresh Wix snapshot
            </button>
          </div>
        </header>

        {state.status === "loading" && (
          <section className="rounded-[28px] border border-stone-300/70 bg-white/75 p-6 text-sm text-stone-600 shadow-[0_18px_60px_rgba(78,51,20,0.08)]">
            Loading Wix data...
          </section>
        )}

        {state.status === "error" && (
          <section className="rounded-[28px] border border-red-200 bg-red-50 p-6 text-sm text-red-800 shadow-[0_18px_60px_rgba(120,20,20,0.08)]">
            <p className="font-semibold">Wix isn't configured yet.</p>
            <p className="mt-2 leading-6">{state.error}</p>
            <p className="mt-3 leading-6">
              Add `WIX_API_KEY` and either `WIX_SITE_ID` or `WIX_ACCOUNT_ID` to `.env.local`, then reload this page.
            </p>
          </section>
        )}

        {state.status === "ready" && (
          <>
            <section className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
              <article className="rounded-[28px] border border-stone-300/80 bg-white/85 p-6 shadow-[0_18px_70px_rgba(78,51,20,0.1)]">
                <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.24em] text-sky-700">Live site</p>
                    <h2 className="mt-3 text-3xl font-semibold text-stone-950">{state.overview.siteName}</h2>
                    {state.overview.businessName && (
                      <p className="mt-2 text-sm text-stone-600">{state.overview.businessName}</p>
                    )}
                    {state.overview.siteDescription && (
                      <p className="mt-4 max-w-2xl text-sm leading-6 text-stone-600">{state.overview.siteDescription}</p>
                    )}
                  </div>

                  {state.overview.logoUrl && (
                    <img
                      src={state.overview.logoUrl}
                      alt={state.overview.siteName}
                      className="h-20 w-20 rounded-3xl border border-stone-200 object-cover shadow-sm"
                    />
                  )}
                </div>

                <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <DetailCard label="Site ID" value={state.overview.siteId} />
                  <DetailCard label="Account ID" value={state.overview.accountId || "Not set"} />
                  <DetailCard label="Timezone" value={state.overview.timezone || "Unknown"} />
                  <DetailCard label="Locale" value={state.overview.locale || "Unknown"} />
                </div>

                <div className="mt-6 grid gap-3 sm:grid-cols-2">
                  <InfoRow icon={<Mail className="h-4 w-4" />} label="Email" value={state.overview.email || "Not available"} />
                  <InfoRow icon={<Phone className="h-4 w-4" />} label="Phone" value={state.overview.phone || "Not available"} />
                  <InfoRow icon={<Globe className="h-4 w-4" />} label="Currency" value={state.overview.currency || "Unknown"} />
                  <InfoRow icon={<Users className="h-4 w-4" />} label="Language" value={state.overview.language || "Unknown"} />
                </div>

                {state.overview.address && (
                  <div className="mt-6 rounded-[24px] border border-stone-200 bg-stone-50 px-4 py-4 text-sm leading-6 text-stone-700">
                    <span className="font-semibold text-stone-900">Business address:</span> {state.overview.address}
                  </div>
                )}
              </article>

              <article className="rounded-[28px] border border-stone-300/80 bg-[#171411] p-6 text-stone-50 shadow-[0_18px_70px_rgba(28,25,23,0.2)]">
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-300">Public entry points</p>
                <div className="mt-4 space-y-3">
                  {state.overview.urls.length ? (
                    state.overview.urls.map((url) => (
                      <a
                        key={url}
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="block rounded-[22px] border border-stone-700 bg-stone-900/70 px-4 py-3 text-sm text-stone-200 transition hover:border-sky-400 hover:text-white"
                      >
                        {url}
                      </a>
                    ))
                  ) : (
                    <p className="rounded-[22px] border border-stone-700 bg-stone-900/70 px-4 py-4 text-sm text-stone-400">
                      No public site URLs were returned by the current Wix permissions.
                    </p>
                  )}
                </div>

                {state.overview.availableSites.length > 1 && (
                  <div className="mt-6">
                    <p className="text-xs font-semibold uppercase tracking-[0.24em] text-stone-400">Other sites on this account</p>
                    <div className="mt-3 space-y-2">
                      {state.overview.availableSites.map((site) => (
                        <div key={site.id} className="rounded-[20px] border border-stone-800 bg-stone-900/50 px-4 py-3 text-sm">
                          <p className="font-medium text-stone-100">{site.displayName}</p>
                          <p className="mt-1 text-xs uppercase tracking-[0.16em] text-stone-500">
                            {site.status || "Unknown"} - {site.id}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </article>
            </section>

            <section className="rounded-[28px] border border-stone-300/80 bg-white/85 p-6 shadow-[0_18px_70px_rgba(78,51,20,0.1)]">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-700">Recent contacts</p>
                  <h2 className="mt-2 text-2xl font-semibold text-stone-950">Newest leads and people</h2>
                </div>
                <p className="text-sm text-stone-500">{state.overview.recentContacts.length} loaded</p>
              </div>

              <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {state.overview.recentContacts.length ? (
                  state.overview.recentContacts.map((contact) => (
                    <article key={contact.id} className="rounded-[24px] border border-stone-200 bg-stone-50 px-4 py-4">
                      <p className="text-base font-semibold text-stone-950">{contact.fullName}</p>
                      <p className="mt-2 text-sm text-stone-600">{contact.primaryEmail || "No email on file"}</p>
                      <p className="mt-1 text-sm text-stone-600">{contact.primaryPhone || "No phone on file"}</p>
                      <p className="mt-4 text-xs uppercase tracking-[0.16em] text-stone-500">
                        Added {formatDate(contact.createdDate)}
                      </p>
                    </article>
                  ))
                ) : (
                  <p className="rounded-[24px] border border-stone-200 bg-stone-50 px-4 py-5 text-sm text-stone-500">
                    No contacts were returned, or this key does not have CRM contact access.
                  </p>
                )}
              </div>
            </section>
          </>
        )}
      </section>
    </main>
  );
}

function DetailCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[24px] border border-stone-200 bg-stone-50 px-4 py-4">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">{label}</p>
      <p className="mt-2 break-all text-sm font-medium text-stone-900">{value}</p>
    </div>
  );
}

function InfoRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 rounded-[24px] border border-stone-200 bg-stone-50 px-4 py-4">
      <div className="rounded-2xl bg-stone-900 p-2 text-amber-300">{icon}</div>
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">{label}</p>
        <p className="mt-1 text-sm text-stone-700">{value}</p>
      </div>
    </div>
  );
}
