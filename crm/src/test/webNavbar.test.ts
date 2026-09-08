import { readFileSync } from "node:fs";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeNavbar } from "../../../web/src/lib/navbar";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("responsive disclosure navigation", () => {
  let media: EventTarget & { matches: boolean };
  let navbar: HTMLElement;
  let links: HTMLElement;
  let hamburger: HTMLButtonElement;
  let toggle: HTMLButtonElement;
  let menu: HTMLElement;
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    media = Object.assign(new EventTarget(), { matches: false });
    vi.stubGlobal("matchMedia", vi.fn(() => media));
    document.body.innerHTML = `<nav id="navbar">
      <a href="/">Home</a>
      <div id="navbar-links">
        <div class="navbar-group">
          <button type="button" class="navbar-group__toggle" aria-expanded="false" aria-controls="coverage">Coverage</button>
          <div id="coverage" class="navbar-group__menu" hidden>
            <a href="/what-we-do/">HOA</a><a href="/condo-insurance/">Condo</a>
          </div>
        </div>
        <a href="/contact/" id="contact-link">Contact</a>
      </div>
      <button type="button" id="navbar-hamburger" aria-controls="navbar-links" aria-expanded="false">
        <span class="hamburger-bar"></span>
      </button>
    </nav><button id="outside">Outside</button>`;
    navbar = document.querySelector("nav")!;
    links = document.getElementById("navbar-links")!;
    hamburger = document.getElementById("navbar-hamburger") as HTMLButtonElement;
    toggle = document.querySelector(".navbar-group__toggle")!;
    menu = document.querySelector(".navbar-group__menu")!;
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders genuine disclosure controls and no CSS override of hidden submenu visibility", () => {
    const source = read("../../../web/src/components/Navbar.astro");
    expect(source).toContain('aria-controls={`navbar-submenu-${i}`}');
    expect(source).toContain('id={`navbar-submenu-${i}`} hidden');
    expect(source).toContain('aria-controls="navbar-links"');
    expect(source).not.toContain("aria-haspopup");
    expect(source).not.toMatch(/\.navbar-group(?::hover|:focus-within)/);
    expect(source).not.toMatch(/\.navbar-group__menu\s*\{[^}]*visibility:\s*visible/);
  });

  it("opens and closes Coverage on click with matching hidden and expanded states", () => {
    cleanup = initializeNavbar(navbar);
    expect(links.inert).toBe(false);
    expect(menu.hidden).toBe(true);
    toggle.click();
    expect(menu.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    toggle.click();
    expect(menu.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it.each(["{Enter}", " "])("supports native keyboard activation with %s", async (key) => {
    cleanup = initializeNavbar(navbar);
    toggle.focus();
    await userEvent.setup().keyboard(key);
    expect(menu.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("closes Coverage on Escape and restores focus to its button", () => {
    cleanup = initializeNavbar(navbar);
    toggle.click();
    menu.querySelector("a")!.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);
  });

  it("closes Coverage when focus moves to the next navigation item", () => {
    cleanup = initializeNavbar(navbar);
    toggle.click();
    menu.querySelector("a")!.focus();
    document.getElementById("contact-link")!.focus();
    expect(menu.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("makes the closed mobile navigation inert, including all submenu links", () => {
    media.matches = true;
    cleanup = initializeNavbar(navbar);
    expect(links.inert).toBe(true);
    expect(menu.hidden).toBe(true);
    hamburger.click();
    expect(links.inert).toBe(false);
    expect(hamburger.getAttribute("aria-expanded")).toBe("true");
    toggle.click();
    hamburger.click();
    expect(links.inert).toBe(true);
    expect(menu.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(hamburger.getAttribute("aria-label")).toBe("Open menu");
  });

  it("dismisses the mobile submenu and then the navigation on successive Escapes", () => {
    media.matches = true;
    cleanup = initializeNavbar(navbar);
    hamburger.click();
    toggle.click();
    menu.querySelector("a")!.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);
    expect(links.inert).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(links.inert).toBe(true);
    expect(document.activeElement).toBe(hamburger);
  });

  it("dismisses the whole mobile navigation on outside click", () => {
    media.matches = true;
    cleanup = initializeNavbar(navbar);
    hamburger.click();
    toggle.click();
    document.getElementById("outside")!.click();
    expect(links.inert).toBe(true);
    expect(menu.hidden).toBe(true);
    expect(navbar.classList.contains("navbar--open")).toBe(false);
  });

  it("closes after following a navigation link", () => {
    media.matches = true;
    cleanup = initializeNavbar(navbar);
    hamburger.click();
    toggle.click();
    const link = menu.querySelector("a")!;
    link.addEventListener("click", (event) => event.preventDefault());
    link.click();
    expect(links.inert).toBe(true);
    expect(menu.hidden).toBe(true);
  });

  it("resets disclosure state across breakpoints without hiding keyboard focus", () => {
    cleanup = initializeNavbar(navbar);
    toggle.click();
    menu.querySelector("a")!.focus();
    media.matches = true;
    media.dispatchEvent(new Event("change"));
    expect(links.inert).toBe(true);
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(hamburger);
    media.matches = false;
    media.dispatchEvent(new Event("change"));
    expect(links.inert).toBe(false);
    expect(hamburger.getAttribute("aria-expanded")).toBe("false");
  });

  it("preserves solid headers and removes all listeners on cleanup", () => {
    navbar.dataset.solid = "true";
    cleanup = initializeNavbar(navbar);
    expect(navbar.classList.contains("navbar--scrolled")).toBe(true);
    cleanup();
    cleanup = undefined;
    toggle.click();
    expect(menu.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
});
