// Prints a fresh VAPID key pair (base64url) for the practice cue. See docs/deploy.md.
import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = privateKey.export({ format: "jwk" });
const publicKey = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(jwk.x, "base64url"),
  Buffer.from(jwk.y, "base64url"),
]).toString("base64url");

console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
