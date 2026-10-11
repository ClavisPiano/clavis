import { createNotationClient, type NotationClient } from "./client";

let client: NotationClient | undefined;

/** The page-wide notation client. The worker only starts on the first `preload` or `render`. */
export function getNotationClient(): NotationClient {
  client ??= createNotationClient();
  return client;
}
