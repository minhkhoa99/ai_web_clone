"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Button } from "./Button";
import { Icon, type IconName } from "./Icon";
import { IconButton } from "./IconButton";

type NavLink = { href: string; label: string; icon: IconName; active: boolean };

// Only real routes (spec parity §2.1): no Engines/Telemetry/Docs/version chips/bell/avatar.
export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const projectId = /^\/p\/([^/]+)/.exec(path)?.[1];
  const general: NavLink[] = [
    { href: "/", label: "Lịch sử", icon: "history", active: path === "/" },
    { href: "/new", label: "Clone mới", icon: "add", active: path.startsWith("/new") },
    { href: "/settings/ai", label: "Cài đặt AI", icon: "settings", active: path.startsWith("/settings/ai") },
  ];
  const base = projectId ? `/p/${projectId}` : "";
  const project: NavLink[] = projectId
    ? [
        { href: base, label: "Tiến độ", icon: "timeline", active: path === base },
        { href: `${base}/sitemap`, label: "Sitemap", icon: "account_tree", active: path === `${base}/sitemap` },
        { href: `${base}/preview`, label: "Preview", icon: "difference", active: path === `${base}/preview` },
        { href: `${base}/editor`, label: "Editor", icon: "edit", active: path === `${base}/editor` },
        { href: `${base}/code`, label: "Code", icon: "code", active: path === `${base}/code` },
      ]
    : [];
  return (
    <>
      <header className="shell-header" data-ui="ui_shell_header">
        <Link href="/" className="shell-brand">
          <Icon name="code" size={20} />
          AI Web Clone
        </Link>
        <div className="shell-header-actions">
          <Button variant="primary" icon="add" href="/new" data-ui="ui_shell_new_clone_cta">
            Clone mới
          </Button>
          <IconButton icon="settings" label="Cài đặt AI" href="/settings/ai" current={path.startsWith("/settings/ai")} data-ui="ui_shell_settings_link" />
        </div>
      </header>
      <aside className="shell-sidebar">
        <NavGroup title="Chung" links={general} ui="ui_shell_sidebar_nav" />
        {projectId && <NavGroup title="Dự án" links={project} ui="ui_shell_project_nav" />}
      </aside>
      <main className="shell-main">{children}</main>
    </>
  );
}

function NavGroup({ title, links, ui }: { title: string; links: NavLink[]; ui: string }) {
  return (
    <nav aria-label={title} data-ui={ui}>
      <p className="nav-group">{title}</p>
      <ul>
        {links.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="nav-item" aria-current={l.active ? "page" : undefined} aria-label={l.label} title={l.label}>
              <Icon name={l.icon} />
              <span className="nav-label">{l.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
