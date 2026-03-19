type WixSiteSummary = {
  id: string;
  displayName: string;
  status?: string;
  createdDate?: string;
};

type WixContactSummary = {
  id: string;
  fullName: string;
  primaryEmail: string | null;
  primaryPhone: string | null;
  createdDate: string | null;
  lastActivityDate: string | null;
};

export type WixOverview = {
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

type SiteResolution = {
  siteId: string;
  availableSites: WixSiteSummary[];
};

const WIX_API_BASE = "https://www.wixapis.com";
const DEFAULT_SITE_LIST_LIMIT = 10;

export class WixConfigurationError extends Error {}

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new WixConfigurationError(`Missing required Wix configuration: ${name}`);
  }
  return value;
}

function getOptionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function buildHeaders(input: { apiKey: string; siteId?: string | null; accountId?: string | null }) {
  const headers = new Headers({
    Authorization: input.apiKey,
    "Content-Type": "application/json"
  });

  if (input.siteId) {
    headers.set("wix-site-id", input.siteId);
  }

  if (input.accountId) {
    headers.set("wix-account-id", input.accountId);
  }

  return headers;
}

async function wixFetch<T>(
  path: string,
  init: RequestInit & { siteId?: string | null; accountId?: string | null } = {}
): Promise<T> {
  const apiKey = getRequiredEnv("WIX_API_KEY");
  const response = await fetch(`${WIX_API_BASE}${path}`, {
    ...init,
    headers: buildHeaders({
      apiKey,
      siteId: init.siteId ?? null,
      accountId: init.accountId ?? null
    }),
    cache: "no-store"
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Wix request failed (${response.status}) for ${path}: ${body || response.statusText}`);
  }

  return response.json() as Promise<T>;
}

async function resolveSite(): Promise<SiteResolution> {
  const siteId = getOptionalEnv("WIX_SITE_ID");
  const accountId = getOptionalEnv("WIX_ACCOUNT_ID");

  if (siteId) {
    return { siteId, availableSites: [] };
  }

  if (!accountId) {
    throw new WixConfigurationError("Set WIX_SITE_ID or WIX_ACCOUNT_ID to load Wix data.");
  }

  const payload = await wixFetch<{ sites?: Array<Record<string, unknown>> }>("/sites/v1/sites/query", {
    method: "POST",
    accountId,
    body: JSON.stringify({
      query: {
        paging: {
          limit: DEFAULT_SITE_LIST_LIMIT,
          offset: 0
        }
      }
    })
  });

  const sites = (payload.sites ?? []).map((site) => ({
    id: String(site.id ?? ""),
    displayName: String(site.displayName ?? site.name ?? "Untitled site"),
    status: typeof site.status === "string" ? site.status : undefined,
    createdDate: typeof site.createdDate === "string" ? site.createdDate : undefined
  })).filter((site) => site.id);

  const preferred = sites.find((site) => site.status?.toLowerCase() === "published") ?? sites[0];

  if (!preferred) {
    throw new Error("No Wix sites were returned for this account.");
  }

  return {
    siteId: preferred.id,
    availableSites: sites
  };
}

function flattenAddress(value: Record<string, unknown> | undefined): string | null {
  if (!value) {
    return null;
  }

  const parts = [
    value.addressLine1,
    value.addressLine2,
    value.city,
    value.subdivision,
    value.postalCode,
    value.countryFullname ?? value.country
  ]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim());

  return parts.length ? parts.join(", ") : null;
}

function coerceStringList(values: unknown[]): string[] {
  return values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
}

function pickSiteUrls(payload: Record<string, unknown>): string[] {
  const directLists = [
    payload.urls,
    payload.siteUrls,
    payload.domains
  ].filter(Array.isArray) as unknown[][];

  const urls = new Set<string>();

  for (const list of directLists) {
    for (const item of list) {
      if (typeof item === "string") {
        urls.add(item);
        continue;
      }

      if (item && typeof item === "object") {
        for (const field of ["url", "domainName", "primaryUrl", "fullUrl"] as const) {
          const value = (item as Record<string, unknown>)[field];
          if (typeof value === "string" && value.trim()) {
            urls.add(value.trim());
          }
        }
      }
    }
  }

  return Array.from(urls);
}

function mapContacts(payload: Record<string, unknown>): WixContactSummary[] {
  const contacts = Array.isArray(payload.contacts) ? payload.contacts : [];

  return contacts.map((contact) => {
    const record = (contact ?? {}) as Record<string, unknown>;
    const info = (record.info ?? {}) as Record<string, unknown>;
    const emails = Array.isArray(info.emails) ? info.emails : [];
    const phones = Array.isArray(info.phones) ? info.phones : [];

    const primaryEmail =
      emails.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).primary === true) ??
      emails[0];
    const primaryPhone =
      phones.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).primary === true) ??
      phones[0];

    return {
      id: String(record.id ?? ""),
      fullName: String(info.name ?? record.primaryInfo ?? "Unnamed contact"),
      primaryEmail:
        primaryEmail && typeof primaryEmail === "object" && typeof (primaryEmail as Record<string, unknown>).email === "string"
          ? String((primaryEmail as Record<string, unknown>).email)
          : null,
      primaryPhone:
        primaryPhone && typeof primaryPhone === "object" && typeof (primaryPhone as Record<string, unknown>).phone === "string"
          ? String((primaryPhone as Record<string, unknown>).phone)
          : null,
      createdDate: typeof record.createdDate === "string" ? record.createdDate : null,
      lastActivityDate: typeof record.revision === "number" ? null : typeof record.lastActivityDate === "string" ? record.lastActivityDate : null
    };
  }).filter((contact) => contact.id);
}

export async function getWixOverview(): Promise<WixOverview> {
  const accountId = getOptionalEnv("WIX_ACCOUNT_ID");
  const { siteId, availableSites } = await resolveSite();

  const [propertiesPayload, urlsPayload, contactsPayload] = await Promise.all([
    wixFetch<Record<string, unknown>>("/site-properties/v4/properties", {
      method: "GET",
      siteId,
      accountId
    }),
    wixFetch<Record<string, unknown>>("/site-properties/v4/site-urls", {
      method: "GET",
      siteId,
      accountId
    }).catch(() => ({})),
    wixFetch<Record<string, unknown>>("/contacts/v4/contacts/query", {
      method: "POST",
      siteId,
      accountId,
      body: JSON.stringify({
        query: {
          sort: [{ fieldName: "createdDate", order: "DESC" }],
          paging: { limit: 5, offset: 0 }
        }
      })
    }).catch(() => ({ contacts: [] }))
  ]);

  const properties = (propertiesPayload.properties ?? propertiesPayload) as Record<string, unknown>;
  const businessProfile = (properties.businessProfile ?? {}) as Record<string, unknown>;
  const businessContact = (properties.businessContact ?? {}) as Record<string, unknown>;
  const businessSchedule = (properties.businessSchedule ?? {}) as Record<string, unknown>;
  const region = (properties.region ?? {}) as Record<string, unknown>;
  const urls = Array.from(new Set([
    ...pickSiteUrls(urlsPayload),
    ...coerceStringList([
      businessProfile.logo?.toString?.(),
      businessProfile.siteUrl?.toString?.()
    ])
  ])).filter((value) => value.startsWith("http"));

  return {
    accountId,
    siteId,
    siteName:
      (typeof businessProfile.siteDisplayName === "string" && businessProfile.siteDisplayName) ||
      (typeof properties.siteDisplayName === "string" && properties.siteDisplayName) ||
      availableSites.find((site) => site.id === siteId)?.displayName ||
      "Wix site",
    businessName:
      typeof businessProfile.businessName === "string"
        ? businessProfile.businessName
        : typeof properties.businessName === "string"
          ? properties.businessName
          : null,
    siteDescription:
      typeof businessProfile.description === "string"
        ? businessProfile.description
        : typeof properties.description === "string"
          ? properties.description
          : null,
    logoUrl:
      typeof businessProfile.logo === "string"
        ? businessProfile.logo
        : typeof businessProfile.logoUrl === "string"
          ? businessProfile.logoUrl
          : null,
    email:
      typeof businessContact.email === "string"
        ? businessContact.email
        : typeof properties.email === "string"
          ? properties.email
          : null,
    phone:
      typeof businessContact.phone === "string"
        ? businessContact.phone
        : typeof properties.phone === "string"
          ? properties.phone
          : null,
    address:
      flattenAddress(businessContact.address as Record<string, unknown> | undefined) ??
      flattenAddress(properties.address as Record<string, unknown> | undefined),
    timezone:
      typeof region.timeZone === "string"
        ? region.timeZone
        : typeof businessSchedule.timeZone === "string"
          ? businessSchedule.timeZone
          : null,
    locale: typeof region.locale === "string" ? region.locale : null,
    language: typeof region.language === "string" ? region.language : null,
    currency: typeof region.currency === "string" ? region.currency : null,
    urls,
    recentContacts: mapContacts(contactsPayload),
    availableSites
  };
}
