/** Key helpers for tests. workers-types types WebCrypto loosely, so the casts live here once. */
export interface TestKeyPair {
  /** Uncompressed 65 byte public point. */
  publicRaw: Uint8Array;
  privateJwk: JsonWebKey;
}

export async function ecKeyPair(name: "ECDH" | "ECDSA"): Promise<TestKeyPair> {
  const usages: string[] = name === "ECDH" ? ["deriveBits"] : ["sign", "verify"];
  const pair = (await crypto.subtle.generateKey(
    { name, namedCurve: "P-256" },
    true,
    usages,
  )) as CryptoKeyPair;
  return {
    publicRaw: new Uint8Array(
      (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
    ),
    privateJwk: (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey,
  };
}
