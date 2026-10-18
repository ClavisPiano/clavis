// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";
import AboutPage from "../../routes/settings/about/+page.svelte";
import { CLAVIS_LICENCES, THIRD_PARTY } from "./about";

afterEach(() => {
  cleanup();
});

describe("licences and source code page", () => {
  it("links to the source repository and both Clavis licence files", () => {
    render(AboutPage);
    expect(screen.getByTestId("source-link").getAttribute("href")).toBe(
      "https://github.com/ClavisPiano/clavis",
    );
    expect(screen.getByTestId("licence-file-code").getAttribute("href")).toBe(
      "https://github.com/ClavisPiano/clavis/blob/main/LICENSE",
    );
    expect(screen.getByTestId("licence-file-content").getAttribute("href")).toBe(
      "https://github.com/ClavisPiano/clavis/blob/main/LICENSE-CONTENT",
    );
    expect(screen.getByTestId("copyright").textContent).toContain("Nicholas James Hobbs");
  });

  it("opens every external link in a new tab without leaking the opener", () => {
    const { container } = render(AboutPage);
    const external = [...container.querySelectorAll<HTMLAnchorElement>('a[href^="https://"]')];
    // The repository, two links per Clavis licence, the Verovio source callout, and each entry's
    // source link.
    const expected =
      1 + CLAVIS_LICENCES.length * 2 + 1 + THIRD_PARTY.filter((e) => e.source).length;
    expect(external).toHaveLength(expected);
    for (const a of external) {
      expect(a.getAttribute("target"), a.href).toBe("_blank");
      expect(a.getAttribute("rel"), a.href).toBe("noopener noreferrer");
    }
  });

  it("lists every library with its licence and every asset", () => {
    render(AboutPage);
    for (const entry of THIRD_PARTY) {
      const row = screen.getByTestId(`${entry.kind === "library" ? "lib" : "asset"}-${entry.id}`);
      expect(within(row).getByText(entry.license)).toBeTruthy();
    }
    const dexie = screen.getByTestId("lib-dexie");
    expect(dexie.textContent).toContain("4.4.6");
    expect(within(dexie).getByText("Source").getAttribute("href")).toBe(
      "https://github.com/dexie/Dexie.js",
    );
  });

  it("calls out the LGPL obligation for Verovio with a source link at the shipped version", () => {
    render(AboutPage);
    const notice = screen.getByTestId("lgpl-notice");
    expect(notice.textContent).toContain("Lesser General Public");
    expect(notice.textContent).toContain("replace it with your own build");
    expect(screen.getByTestId("lgpl-source").getAttribute("href")).toBe(
      "https://github.com/rism-digital/verovio/tree/version-6.3.0",
    );
  });

  it("loads the full licence texts only when the section is opened", async () => {
    render(AboutPage);
    expect(screen.queryByTestId("notices-text")).toBeNull();
    const details = screen.getByTestId<HTMLDetailsElement>("notices");
    details.open = true;
    await fireEvent(details, new Event("toggle"));
    const text = await waitFor(() => screen.getByTestId("notices-text"));
    expect(text.textContent).toContain("GNU LESSER GENERAL PUBLIC LICENSE");
    expect(text.textContent).toContain("verovio 6.3.0, LGPL-3.0-or-later");
  });
});
