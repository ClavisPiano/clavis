import { z } from "zod";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { AccountError } from "./errors";

/*
 * Client for the T4.2 auth endpoints. JSON in and out, cookie via `credentials: "include"`.
 * The browser adds the Origin header itself on same-origin POSTs, which the Worker checks.
 *
 * Error mapping: network failure -> `network`; 401 -> `unauthorized` (login and recovery map it to
 * `rejected`, because there a 401 means a bad credential, not an expired session); 409 ->
 * `alreadyRegistered`; other 4xx -> `rejected`; 5xx and malformed bodies -> `server`.
 */

export interface MeResponse {
  userId: string;
  passkeys: number;
  recoveryCodesLeft: number;
}

export interface OptionsResponse<O> {
  challengeId: string;
  options: O;
}

const Me = z.object({
  userId: z.string(),
  passkeys: z.number().int().nonnegative(),
  recoveryCodesLeft: z.number().int().nonnegative(),
});
const Options = z.object({ challengeId: z.string(), options: z.looseObject({}) });
const Registered = z.object({ userId: z.string(), recoveryCodes: z.array(z.string()) });
const LoggedIn = z.object({ userId: z.string() });
const Recovered = z.object({ userId: z.string(), recoveryCodesLeft: z.number().int() });
const PasskeyAdded = z.object({ userId: z.string(), passkeys: z.number().int() });

export interface AuthApi {
  me(): Promise<MeResponse>;
  registerOptions(): Promise<OptionsResponse<PublicKeyCredentialCreationOptionsJSON>>;
  registerVerify(
    challengeId: string,
    response: unknown,
  ): Promise<{ userId: string; recoveryCodes: string[] }>;
  loginOptions(): Promise<OptionsResponse<PublicKeyCredentialRequestOptionsJSON>>;
  loginVerify(challengeId: string, response: unknown): Promise<{ userId: string }>;
  recovery(code: string): Promise<{ userId: string; recoveryCodesLeft: number }>;
  passkeyOptions(): Promise<OptionsResponse<PublicKeyCredentialCreationOptionsJSON>>;
  passkeyVerify(
    challengeId: string,
    response: unknown,
  ): Promise<{ userId: string; passkeys: number }>;
  logout(): Promise<void>;
}

export function createAuthApi(
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
  base = "/api",
): AuthApi {
  async function call<S extends z.ZodType>(
    method: "GET" | "POST",
    path: string,
    schema: S,
    opts: { body?: unknown; unauthorizedKind?: "unauthorized" | "rejected" } = {},
  ): Promise<z.output<S>> {
    const init: RequestInit = { method, credentials: "include" };
    if (method === "POST") {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(opts.body ?? {});
    }
    let res: Response;
    try {
      res = await fetchFn(`${base}${path}`, init);
    } catch (cause) {
      throw new AccountError("network", "request failed", undefined, { cause });
    }
    if (res.status === 401) {
      throw new AccountError(opts.unauthorizedKind ?? "unauthorized", "unauthorized", 401);
    }
    if (res.status === 409) throw new AccountError("alreadyRegistered", "conflict", 409);
    if (res.status >= 400 && res.status < 500) {
      throw new AccountError("rejected", `request rejected (${String(res.status)})`, res.status);
    }
    if (!res.ok) {
      throw new AccountError("server", `server error (${String(res.status)})`, res.status);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new AccountError("server", "response was not JSON", res.status);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new AccountError("server", "unexpected response", res.status);
    return parsed.data;
  }

  const options = async <O>(path: string): Promise<OptionsResponse<O>> => {
    const r = await call("POST", path, Options);
    return { challengeId: r.challengeId, options: r.options as O };
  };

  return {
    me: () => call("GET", "/me", Me),
    registerOptions: () => options("/auth/register/options"),
    registerVerify: (challengeId, response) =>
      call("POST", "/auth/register/verify", Registered, { body: { challengeId, response } }),
    loginOptions: () => options("/auth/login/options"),
    loginVerify: (challengeId, response) =>
      call("POST", "/auth/login/verify", LoggedIn, {
        body: { challengeId, response },
        unauthorizedKind: "rejected",
      }),
    recovery: (code) =>
      call("POST", "/auth/recovery", Recovered, {
        body: { code },
        unauthorizedKind: "rejected",
      }),
    passkeyOptions: () => options("/auth/passkeys/options"),
    passkeyVerify: (challengeId, response) =>
      call("POST", "/auth/passkeys/verify", PasskeyAdded, { body: { challengeId, response } }),
    async logout() {
      await call("POST", "/auth/logout", z.object({ ok: z.boolean() }));
    },
  };
}
