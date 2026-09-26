"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Icon, type IconName } from "@/app/_ui/Icon";
import { SearchInput } from "@/app/_ui/SearchInput";

type Dir = { name: string; path: string; dirs: Dir[]; files: string[] };

const ICON_OF: Record<string, IconName> = { ".html": "html", ".css": "css", ".js": "javascript", ".json": "data_object" };
const IMAGE = /\.(png|jpe?g|gif|webp|svg|ico|avif|bmp)$/i;
const fileIcon = (f: string): IconName => ICON_OF[f.slice(f.lastIndexOf(".")).toLowerCase()] ?? (IMAGE.test(f) ? "image" : "description");
const ancestors = (f: string) => f.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"));

// out/ as a tree (<= 2000 paths, from the server listing).
function buildDirs(files: string[]): Dir {
  const root: Dir = { name: "out", path: "", dirs: [], files: [] };
  for (const f of files) {
    const parts = f.split("/");
    let d = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let next = d.dirs.find((x) => x.path === path);
      if (!next) {
        next = { name: parts[i]!, path, dirs: [], files: [] };
        d.dirs.push(next);
      }
      d = next;
    }
    d.files.push(f);
  }
  return root;
}

export function FileTree({ files, current }: { files: string[]; current: string }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(() => new Set(["", ...ancestors(current)])); // the branch of the viewed file starts open
  const q = query.trim().toLowerCase();
  const root = buildDirs(q ? files.filter((f) => f.toLowerCase().includes(q)) : files); // name filter, never the content
  const isOpen = (path: string) => q !== "" || open.has(path);
  const toggle = (path: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const dir = (d: Dir, depth: number): ReactNode => (
    <li key={d.path || "/"}>
      <button type="button" className="tree-dir" aria-expanded={isOpen(d.path)} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(d.path)}>
        <Icon name="chevron_right" className={isOpen(d.path) ? "chev-i open" : "chev-i"} />
        <Icon name={isOpen(d.path) ? "folder_open" : "folder"} />
        <span>{d.name}</span>
      </button>
      {isOpen(d.path) && (
        <ul>
          {d.dirs.map((c) => dir(c, depth + 1))}
          {d.files.map((f) => (
            <li key={f}>
              <Link href={`?file=${encodeURIComponent(f)}`} className="tree-file" aria-current={f === current ? "page" : undefined} style={{ paddingLeft: 22 + (depth + 1) * 14 }}>
                <Icon name={fileIcon(f)} />
                <span>{f.slice(f.lastIndexOf("/") + 1)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </li>
  );

  return (
    <nav className="panel file-tree" aria-label="Cây file" data-ui="ui_code_viewer_file_tree">
      <div className="pane-toolbar">
        <SearchInput data-ui="ui_code_viewer_file_search" label="Lọc file" placeholder="Lọc file theo tên…" value={query} onChange={setQuery} />
      </div>
      <ul className="tree-root">{dir(root, 0)}</ul>
    </nav>
  );
}
