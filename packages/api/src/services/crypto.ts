// Domain-separated AES-GCM with per-record associated data. Portable to Workers.
const encoder = new TextEncoder();
function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}
function decode(value: string) {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
export class ServiceSecrets {
  private key: Promise<CryptoKey>;
  constructor(secret: string) {
    this.key = crypto.subtle
      .digest("SHA-256", encoder.encode(`ephor:service-secrets:v1:${secret}`))
      .then((raw) =>
        crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
          "encrypt",
          "decrypt",
        ]),
      );
  }
  async seal(id: string, value: unknown) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(id) },
      await this.key,
      encoder.encode(JSON.stringify(value)),
    );
    return `v1.${encode(iv)}.${encode(new Uint8Array(bytes))}`;
  }
  async open<T>(id: string, value: string): Promise<T> {
    const [version, iv, encrypted] = value.split(".");
    if (version !== "v1" || !iv || !encrypted)
      throw new Error("Invalid encrypted service record");
    const bytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(iv), additionalData: encoder.encode(id) },
      await this.key,
      decode(encrypted),
    );
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }
}
