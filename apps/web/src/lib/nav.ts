export interface NavItem {
  readonly href: "/" | "/progress" | "/settings";
  readonly label: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Home" },
  { href: "/progress", label: "Progress" },
  { href: "/settings", label: "Settings" },
];

/** True when `pathname` is the nav item's route (exact for "/", prefix otherwise). */
export function isActive(item: NavItem, pathname: string): boolean {
  if (item.href === "/") return pathname === "/";
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
