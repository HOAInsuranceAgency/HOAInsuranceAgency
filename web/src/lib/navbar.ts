/** Accessible disclosure navigation; hidden mobile links are also inert. */
export function initializeNavbar(navbar: HTMLElement): () => void {
  const links = navbar.querySelector<HTMLElement>("#navbar-links");
  const hamburger = navbar.querySelector<HTMLButtonElement>("#navbar-hamburger");
  const doc = navbar.ownerDocument;
  const view = doc.defaultView;
  if (!links || !hamburger || !view) return () => {};

  const mobile = view.matchMedia("(max-width: 768px)");
  const bars = hamburger.querySelectorAll(".hamburger-bar");
  const groups = Array.from(navbar.querySelectorAll<HTMLElement>(".navbar-group"))
    .flatMap((element) => {
      const toggle = element.querySelector<HTMLButtonElement>(".navbar-group__toggle");
      const menu = element.querySelector<HTMLElement>(".navbar-group__menu");
      return toggle && menu ? [{ element, toggle, menu }] : [];
    });
  let open = false;

  const setGroupOpen = (group: typeof groups[number], expanded: boolean) => {
    group.toggle.setAttribute("aria-expanded", String(expanded));
    group.menu.hidden = !expanded;
  };
  const closeGroups = () => groups.forEach((group) => setGroupOpen(group, false));
  const setOpen = (expanded: boolean) => {
    open = expanded && mobile.matches;
    links.classList.toggle("navbar-links--open", open);
    navbar.classList.toggle("navbar--open", open);
    bars.forEach((bar) => bar.classList.toggle("hamburger-bar--open", open));
    hamburger.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    hamburger.setAttribute("aria-expanded", String(open));
    links.inert = mobile.matches && !open;
    if (!open) closeGroups();
  };
  const onToggle = () => setOpen(!open);
  const onLinksClick = (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest("a")) setOpen(false);
  };
  const onOutsideClick = (event: MouseEvent) => {
    if (event.target instanceof Node && !navbar.contains(event.target)) setOpen(false);
  };
  const onFocus = (event: FocusEvent) => {
    groups.forEach((group) => {
      if (event.target instanceof Node && !group.element.contains(event.target)) {
        setGroupOpen(group, false);
      }
    });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    const expanded = groups.find((group) => !group.menu.hidden);
    if (expanded) {
      event.preventDefault();
      setGroupOpen(expanded, false);
      expanded.toggle.focus();
    } else if (open) {
      event.preventDefault();
      setOpen(false);
      hamburger.focus();
    }
  };
  const onBreakpoint = () => {
    const focusInLinks = links.contains(doc.activeElement);
    setOpen(false);
    if (mobile.matches && focusInLinks) hamburger.focus();
  };
  const onScroll = () => {
    navbar.classList.toggle("navbar--scrolled", view.scrollY > 60 || navbar.dataset.solid === "true");
  };
  const groupListeners = groups.map((group) => {
    const onClick = () => {
      const expanded = group.menu.hidden;
      closeGroups();
      setGroupOpen(group, expanded);
    };
    group.toggle.addEventListener("click", onClick);
    return () => group.toggle.removeEventListener("click", onClick);
  });

  setOpen(false);
  onScroll();
  hamburger.addEventListener("click", onToggle);
  links.addEventListener("click", onLinksClick);
  doc.addEventListener("click", onOutsideClick);
  doc.addEventListener("focusin", onFocus);
  doc.addEventListener("keydown", onKeyDown);
  mobile.addEventListener("change", onBreakpoint);
  view.addEventListener("scroll", onScroll, { passive: true });

  return () => {
    groupListeners.forEach((remove) => remove());
    hamburger.removeEventListener("click", onToggle);
    links.removeEventListener("click", onLinksClick);
    doc.removeEventListener("click", onOutsideClick);
    doc.removeEventListener("focusin", onFocus);
    doc.removeEventListener("keydown", onKeyDown);
    mobile.removeEventListener("change", onBreakpoint);
    view.removeEventListener("scroll", onScroll);
  };
}
