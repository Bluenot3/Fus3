import { createSupabaseAdmin } from "@/lib/supabase/server";
import { decryptSecret, encryptSecret } from "@/lib/secrets/crypto";

export type SecretRecord = {
  service_id: string;
  key_name: string;
  encrypted_value: string;
  updated_at: string;
};

export class SecretsManager {
  async upsertSecret(serviceId: string, keyName: string, plaintext: string) {
    const db = createSupabaseAdmin();
    const encrypted = encryptSecret(plaintext);

    const { error } = await db.from("service_secrets").upsert({
      service_id: serviceId,
      key_name: keyName,
      encrypted_value: encrypted,
      updated_at: new Date().toISOString()
    });

    if (error) {
      throw new Error(`Failed to upsert secret for ${serviceId}/${keyName}: ${error.message}`);
    }
  }

  async getSecret(serviceId: string, keyName: string) {
    const db = createSupabaseAdmin();
    const { data, error } = await db
      .from("service_secrets")
      .select("service_id,key_name,encrypted_value,updated_at")
      .eq("service_id", serviceId)
      .eq("key_name", keyName)
      .single<SecretRecord>();

    if (error || !data) {
      return null;
    }

    return {
      ...data,
      plaintext: decryptSecret(data.encrypted_value)
    };
  }

  async listSecretMetadata() {
    const db = createSupabaseAdmin();
    const { data, error } = await db
      .from("service_secrets")
      .select("service_id,key_name,updated_at")
      .order("updated_at", { ascending: false })
      .limit(200);

    if (error) {
      throw new Error(`Failed to list secret metadata: ${error.message}`);
    }

    return data ?? [];
  }
}

export function getSecretsManager() {
  return new SecretsManager();
}
