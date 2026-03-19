import { NextRequest, NextResponse } from "next/server";
import { getSecretsManager } from "@/lib/secrets/manager";

function isAuthorized(request: NextRequest): boolean {
  const bearer = request.headers.get("authorization")?.replace("Bearer ", "") ?? "";
  return Boolean(process.env.ZEN_ADMIN_TOKEN && bearer === process.env.ZEN_ADMIN_TOKEN);
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const secrets = await getSecretsManager().listSecretMetadata();
  return NextResponse.json({ count: secrets.length, secrets });
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = (await request.json()) as { serviceId?: string; keyName?: string; value?: string };
  if (!payload.serviceId || !payload.keyName || !payload.value) {
    return NextResponse.json({ error: "serviceId, keyName, and value are required" }, { status: 400 });
  }

  await getSecretsManager().upsertSecret(payload.serviceId, payload.keyName, payload.value);
  return NextResponse.json({ ok: true, serviceId: payload.serviceId, keyName: payload.keyName });
}
