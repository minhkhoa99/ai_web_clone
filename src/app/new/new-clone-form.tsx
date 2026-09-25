"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { ProjectConfig } from "@/core/jobs-base";
import { api, errorText } from "@/app/_ui/api";
import { Badge } from "@/app/_ui/Badge";
import { Banner } from "@/app/_ui/Banner";
import { Button } from "@/app/_ui/Button";
import { Card } from "@/app/_ui/Card";
import { Disclosure } from "@/app/_ui/Disclosure";
import { Field } from "@/app/_ui/Field";
import { Icon, type IconName } from "@/app/_ui/Icon";
import { IconButton } from "@/app/_ui/IconButton";
import { PasswordInput } from "@/app/_ui/PasswordInput";
import { SegmentedControl } from "@/app/_ui/SegmentedControl";
import { fmtInt } from "@/app/_ui/format";

type Mode = "single" | "crawl";
type AuthMode = ProjectConfig["auth"]["mode"];
type Initial = { url: string; mode: Mode; config: ProjectConfig };

const AUTH_MODES: [AuthMode, string][] = [
  ["none", "Không"],
  ["manual", "Thủ công (tự đăng nhập trong cửa sổ Chrome)"],
  ["auto", "Tự động (tài khoản)"],
];
const SP2_OUTPUTS = ["React", "Next.js", "Vue", "WordPress"];
const QA_MARKS: [number, string][] = [
  [70, "70% (thoáng)"],
  [85, "85% (cân bằng)"],
  [95, "95% (chặt)"],
  [100, "100% (khớp pixel)"],
];

function Section({ icon, title, hint, ui, children }: { icon: IconName; title: string; hint?: ReactNode; ui?: string; children: ReactNode }) {
  return (
    <section className="new-section" data-ui={ui}>
      <div className="new-section-head">
        <Icon name={icon} size={16} />
        <h2 className="t-label-md">{title}</h2>
        {hint && <span className="new-section-hint t-label-sm">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

export function NewCloneForm({ initial }: { initial?: Initial }) {
  const router = useRouter();
  const cfg = initial?.config;
  const [url, setUrl] = useState(initial?.url ?? "");
  const [copyState, setCopyState] = useState<"idle" | "ok" | "err">("idle");
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  const [mode, setMode] = useState<Mode>(initial?.mode ?? "single");
  const [maxPages, setMaxPages] = useState(cfg?.maxPages ?? 20);
  const [depth, setDepth] = useState(cfg?.depth ?? 2);
  const [concurrency, setConcurrency] = useState(cfg?.concurrency ?? 3);
  const [delayMs, setDelayMs] = useState(cfg?.delayMs ?? 500);
  const [selectors, setSelectors] = useState({ user: cfg?.auth.selectors?.user ?? "", pass: cfg?.auth.selectors?.pass ?? "", submit: cfg?.auth.selectors?.submit ?? "" });
  const [authMode, setAuthMode] = useState<AuthMode>(cfg?.auth.mode ?? "none");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [remember, setRemember] = useState(false);
  const [threshold, setThreshold] = useState(Math.round((cfg?.threshold ?? 0.95) * 100));
  const [tokenBudget, setTokenBudget] = useState(cfg ? String(cfg.tokenBudget) : ""); // digits only; "" = server default
  const [budgetFocus, setBudgetFocus] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [loginFirst, setLoginFirst] = useState(false); // manual auth: log in in the window, then crawl

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg("");
    try {
      await fn();
    } catch (err) {
      setMsg(errorText(err));
      setBusy(false);
    }
  };

  const crawl = async (id: string) => {
    await api(`/api/projects/${id}/crawl`, { method: "POST" });
    router.push(`/p/${id}/sitemap`);
  };

  const copyUrl = () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
    const arm = (state: "ok" | "err") => {
      setCopyState(state);
      copyTimer.current = setTimeout(() => setCopyState("idle"), 2000);
    };
    void navigator.clipboard.writeText(url).then(
      () => arm("ok"),
      () => arm("err"),
    );
  };

  // Create, then crawl the sitemap for the page picker (manual auth: after the user logged in in the window).
  // A failed crawl leaves the draft project, linked in the error.
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    try {
      // only the selectors the user filled in; none -> the login form is found heuristically
      const filled = Object.fromEntries(Object.entries(selectors).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));
      const config = {
        maxPages,
        depth,
        concurrency,
        delayMs,
        threshold: threshold / 100,
        ...(tokenBudget ? { tokenBudget: Number(tokenBudget) } : {}),
        auth: { mode: authMode, ...(authMode === "auto" && Object.keys(filled).length > 0 ? { selectors: filled } : {}) },
      };
      const credentials = authMode === "auto" ? { credentials: { user, pass, remember } } : {};
      const { id } = await api<{ id: string }>("/api/projects", { body: { url, mode, config, ...credentials } });
      setCreated(id);
      if (authMode === "manual") {
        setLoginFirst(true);
        setBusy(false);
        return;
      }
      await crawl(id);
    } catch (err) {
      setMsg(errorText(err));
      setBusy(false);
    }
  };

  const num = (value: number, set: (n: number) => void, min: number, max: number, step = 1) => (
    <input type="number" className="num-center" min={min} max={max} step={step} required value={value} onChange={(e) => set(e.target.valueAsNumber)} />
  );

  const clampedThreshold = Math.min(100, Math.max(70, threshold));
  const activeMark = QA_MARKS.reduce((acc, [v]) => (v <= clampedThreshold ? v : acc), 70);

  return (
    <form className="new-card" data-ui="ui_new_clone_card" onSubmit={(e) => void submit(e)}>
      <div className="new-card-head" data-ui="ui_new_clone_page_header">
        <h1 className="t-headline-lg">Cấu hình clone mới</h1>
        <p className="t-body-lg page-subtitle">Nhập URL, chọn chế độ, cách đăng nhập, ngưỡng QA và ngân sách token.</p>
      </div>
      <div className="new-divider" />

      <Section icon="language" title="URL trang web" hint="HTTP/HTTPS" ui="ui_new_clone_url_input">
        <span className="url-input">
          <Icon name="language" />
          <input required type="url" className="mono" aria-label="URL trang web" placeholder="https://example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
          <IconButton
            icon="content_copy"
            label={copyState === "ok" ? "Đã sao chép" : copyState === "err" ? "Lỗi sao chép" : "Sao chép URL"}
            disabled={!url}
            onClick={copyUrl}
          />
        </span>
      </Section>

      <div className="new-section">
        <h2 id="new-clone-mode-label" className="new-toggle-label t-label-md">
          Chế độ clone
        </h2>
        <SegmentedControl<Mode>
          data-ui="ui_new_clone_mode_toggle"
          label="Chế độ clone"
          aria-labelledby="new-clone-mode-label"
          full
          value={mode}
          onChange={setMode}
          options={[
            { value: "single", label: "1 trang đầy đủ", icon: "description" },
            { value: "crawl", label: "Crawl nhiều trang", icon: "account_tree" },
          ]}
        />
      </div>
      {mode === "crawl" && (
        <Card variant="section" icon="account_tree" title="GIỚI HẠN CRAWL" data-ui="ui_new_clone_crawl_limits">
          <div className="limits-grid">
            <Field label="Số trang tối đa" suffix="trang">
              {num(maxPages, setMaxPages, 1, 100)}
            </Field>
            <Field label="Độ sâu" suffix="cấp">
              {num(depth, setDepth, 0, 5)}
            </Field>
            <Field label="Trang chụp song song" suffix="trang">
              {num(concurrency, setConcurrency, 1, 5)}
            </Field>
            <Field label="Delay giữa request" suffix="ms">
              {num(delayMs, setDelayMs, 0, 10_000, 100)}
            </Field>
          </div>
        </Card>
      )}

      <Section icon="lock" title="Đăng nhập" ui="ui_new_clone_auth_select">
        <select aria-label="Cách đăng nhập" className="full" value={authMode} onChange={(e) => setAuthMode(e.target.value as AuthMode)}>
          {AUTH_MODES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        {authMode === "auto" && (
          <div className="sub-box">
            <div className="creds-box" data-ui="ui_new_clone_auth_credentials">
              <div className="creds-grid-2">
                <Field label="Tài khoản">
                  <input required autoComplete="off" value={user} onChange={(e) => setUser(e.target.value)} />
                </Field>
                <PasswordInput label="Mật khẩu" required value={pass} onChange={(e) => setPass(e.target.value)} />
              </div>
              <label className="check">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                Ghi nhớ (mã hóa trên máy này)
              </label>
            </div>
            <div className="new-divider" />
            <Disclosure summary="Selector form đăng nhập (tùy chọn)" data-ui="ui_new_clone_auth_selectors">
              <div className="creds-grid">
                {(["user", "pass", "submit"] as const).map((k) => (
                  <Field key={k} label={`Selector ${k === "user" ? "ô tài khoản" : k === "pass" ? "ô mật khẩu" : "nút gửi"}`}>
                    <input className="mono" maxLength={500} placeholder="CSS selector" value={selectors[k]} onChange={(e) => setSelectors({ ...selectors, [k]: e.target.value })} />
                  </Field>
                ))}
              </div>
            </Disclosure>
          </div>
        )}
      </Section>

      <Section icon="difference" title="Ngưỡng QA" hint={`${threshold}%`} ui="ui_new_clone_qa_threshold">
        <div className="sub-box">
          <input type="range" className="qa-slider" aria-label="Ngưỡng QA" min={70} max={100} step={1} value={clampedThreshold} onChange={(e) => setThreshold(e.target.valueAsNumber)} />
          <div className="qa-marks t-label-sm">
            {QA_MARKS.map(([v, label]) => {
              const [pct, ...rest] = label.split(" ");
              return (
                <span key={v} className={v === activeMark ? "is-active" : undefined}>
                  {pct}
                  {/* hidden below ~640px so the row stays on one line without truncating the % value itself */}
                  <span className="mark-detail"> {rest.join(" ")}</span>
                </span>
              );
            })}
          </div>
        </div>
        {/* D9: the number keeps every threshold the schema allows (0..100), the slider covers 70..100 */}
        <Field label="Chính xác (%)" suffix="%" className="qa-exact">
          <input
            type="number"
            min={0}
            max={100}
            required
            value={threshold}
            onChange={(e) => {
              const v = e.target.valueAsNumber;
              if (!Number.isNaN(v)) setThreshold(v); // an emptied box keeps the previous value, never NaN
            }}
          />
        </Field>
      </Section>

      <Section icon="generating_tokens" title="Ngân sách token" ui="ui_new_clone_token_budget">
        <span className="field-control has-suffix">
          <input
            type="text"
            inputMode="numeric"
            aria-label="Ngân sách token"
            className="mono"
            placeholder="2.000.000 (mặc định)"
            value={budgetFocus || !tokenBudget ? tokenBudget : fmtInt(Number(tokenBudget))}
            onFocus={() => setBudgetFocus(true)}
            onBlur={() => setBudgetFocus(false)}
            onChange={(e) => setTokenBudget(e.target.value.replace(/\D/g, "").replace(/^0+/, "").slice(0, 12))} // strips leading zeros: the smallest value a user can enter is 1
          />
          <span className="field-suffix t-label-sm" aria-hidden="true">
            token
          </span>
        </span>
        <p className="t-body-sm text-3">Dùng cho đặt tên section và vòng sửa QA. Hết ngân sách → dừng các bước AI, dự án vẫn hoàn thành.</p>
      </Section>

      <Section icon="output" title="Định dạng output" ui="ui_new_clone_output_format">
        <div role="radiogroup" aria-label="Định dạng output" className="output-grid">
          <div role="radio" aria-checked="true" tabIndex={0} className="output-card is-on">
            <span className="output-card-top">
              <span className="mono">
                <Icon name="check_circle" size={16} />
                HTML
              </span>
              <Badge>Đang dùng</Badge>
            </span>
            <span className="t-body-sm text-2">HTML/CSS tĩnh</span>
          </div>
          {SP2_OUTPUTS.map((o) => (
            <div key={o} role="radio" aria-checked="false" aria-disabled="true" className="output-card">
              <span className="output-card-top">
                <span className="mono">{o}</span>
                <Badge>SP2</Badge>
              </span>
            </div>
          ))}
        </div>
      </Section>

      {msg && (
        <Banner tone="danger" icon="error" data-ui="ui_new_clone_error">
          {msg}
          {created && (
            <>
              {" — "}
              <Link href={`/p/${created}/sitemap`}>mở sitemap của dự án đã tạo</Link>
            </>
          )}
        </Banner>
      )}
      {loginFirst && created ? (
        <div role="group" aria-label="Đăng nhập trước khi quét" data-ui="ui_new_clone_manual_login">
          <Banner
            tone="info"
            icon="lock"
            actions={
              <>
                <Button icon="open_in_new" disabled={busy} onClick={() => void run(() => api(`/api/projects/${created}/auth/open`, { method: "POST" }).then(() => setBusy(false)))}>
                  Mở cửa sổ đăng nhập
                </Button>
                <Button variant="primary" icon="radar" disabled={busy} onClick={() => void run(() => crawl(created))}>
                  Quét trang
                </Button>
              </>
            }
          >
            Mở cửa sổ Chrome, đăng nhập (tự xử lý CAPTCHA nếu có), rồi bấm Quét trang — cửa sổ sẽ được đóng trước khi quét.
          </Banner>
        </div>
      ) : (
        <div className="new-actions">
          <Button href="/" data-ui="ui_new_clone_cancel">
            Hủy
          </Button>
          <Button type="submit" variant="primary" size="lg" icon="radar" iconEnd="arrow_forward" disabled={busy} data-ui="ui_new_clone_preview_sitemap">
            {busy ? "Đang quét…" : "Quét trang"}
          </Button>
        </div>
      )}
    </form>
  );
}
