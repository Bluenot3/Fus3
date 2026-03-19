import { NextRequest, NextResponse } from "next/server";
import { getSecretsManager } from "@/lib/secrets/manager";

function isAuthorized(request: NextRequest): boolean {
  const bearer = request.headers.get("authorization")?.replace("Bearer ", "") ?? "";
  return Boolean(process.env.ZEN_ADMIN_TOKEN && bearer === process.env.ZEN_ADMIN_TOKEN);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ serviceId: string }> }
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const resolved = await params;
  const keyName = request.nextUrl.searchParams.get("keyName");
  if (!keyName) {
    return NextResponse.json({ error: "keyName query parameter is required" }, { status: 400 });
  }

  const secret = await getSecretsManager().getSecret(resolved.serviceId, keyName);
  if (!secret) {
    return NextResponse.json({ error: "Secret not found" }, { status: 404 });
  }

  return NextResponse.json({
    serviceId: secret.service_id,
    keyName: secret.key_name,
    value: secret.plaintext,
    updatedAt: secret.updated_at
  });
}
