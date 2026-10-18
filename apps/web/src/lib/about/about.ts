import { z } from "zod";
import thirdPartyJson from "./third-party.json";

export const REPO_URL = "https://github.com/ClavisPiano/clavis";
export const COPYRIGHT = "Copyright (c) 2026 Nicholas James Hobbs";

/** The project's own licences. The files are in the repository root. */
export const CLAVIS_LICENCES = [
  {
    id: "code",
    label: "Code",
    name: "PolyForm Noncommercial License 1.0.0",
    summary: "Free to use, study and change for any noncommercial purpose.",
    url: "https://polyformproject.org/licenses/noncommercial/1.0.0",
    fileUrl: `${REPO_URL}/blob/main/LICENSE`,
  },
  {
    id: "content",
    label: "Learning content",
    name: "CC BY-NC 4.0",
    summary:
      "The skill graph, concept cards, tips and piece library. Share with credit, not for sale.",
    url: "https://creativecommons.org/licenses/by-nc/4.0/",
    fileUrl: `${REPO_URL}/blob/main/LICENSE-CONTENT`,
  },
] as const;

const ThirdPartySchema = z.array(
  z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    kind: z.enum(["library", "asset"]),
    license: z.string().min(1),
    use: z.string().min(1),
    homepage: z.url().nullable(),
    source: z.url().nullable(),
    packages: z.array(z.object({ name: z.string().min(1), version: z.string().min(1) })),
    extraTexts: z.array(z.string()).optional(),
    fallback: z
      .object({
        text: z.string().optional(),
        file: z.string().optional(),
        mit: z.string().optional(),
      })
      .optional(),
  }),
);

export type ThirdPartyEntry = z.infer<typeof ThirdPartySchema>[number];

export const THIRD_PARTY: readonly ThirdPartyEntry[] = ThirdPartySchema.parse(thirdPartyJson);

/** Libraries and assets only differ in how the About screen groups them. */
export const THIRD_PARTY_LIBRARIES = THIRD_PARTY.filter((e) => e.kind === "library");
export const THIRD_PARTY_ASSETS = THIRD_PARTY.filter((e) => e.kind === "asset");

/** The version to show: the single package's version, or none for a family of packages. */
export function displayVersion(entry: ThirdPartyEntry): string | undefined {
  return entry.packages.length === 1 ? entry.packages[0]?.version : undefined;
}

/** LGPL obligations attach to this component (the notation engraver), so the screen calls it out. */
export function isLgpl(entry: ThirdPartyEntry): boolean {
  return entry.license.startsWith("LGPL");
}

/** The full licence texts, loaded when the learner asks for them so the screen opens fast. */
export async function loadNotices(): Promise<string> {
  const mod = await import("./third-party-notices.txt?raw");
  return mod.default;
}
