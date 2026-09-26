import Link from "next/link";
import type { ReactNode } from "react";

export type Crumb = { label: string; href?: string };

// "Lịch sử / <host> / <screen>" for every /p/[id] screen (spec §3.4–3.8; no "Task #", no "Pipelines").
export const projectCrumbs = (url: string, id: string, screen: string): Crumb[] => [
  { label: "Lịch sử", href: "/" },
  { label: new URL(url).host, href: `/p/${id}` },
  { label: screen },
];

type Props = { crumbs: Crumb[]; title: ReactNode; subtitle?: ReactNode; meta?: ReactNode; actions?: ReactNode; "data-ui"?: string };

export function PageHeader({ crumbs, title, subtitle, meta, actions, ...ui }: Props) {
  return (
    <div className="page-header" data-ui={ui["data-ui"]}>
      <div className="page-header-main">
        {/* the shell-level part of every page header (spec §2.1 ui_shell_page_header): the breadcrumb */}
        <nav aria-label="Breadcrumb" className="crumbs" data-ui="ui_shell_page_header">
          <ol>
            {crumbs.map((c, i) => (
              <li key={i}>
                {i === crumbs.length - 1 ? <span aria-current="page">{c.label}</span> : c.href ? <Link href={c.href}>{c.label}</Link> : <span>{c.label}</span>}
              </li>
            ))}
          </ol>
        </nav>
        <div className="page-title">
          <h1 className="t-headline-lg">{title}</h1>
          {meta}
        </div>
        {subtitle && <p className="t-body-lg page-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
