"use client";
import { useEffect, useState } from "react";

const rtf = new Intl.RelativeTimeFormat("vi", { numeric: "auto" });

// Pure: "12 giây trước", "5 phút trước", "hôm qua" (ICU capitalizes "Hôm qua": lowercased, it follows a prefix).
export function relative(ms: number, now: number): string {
  const s = Math.round((ms - now) / 1000);
  const abs = Math.abs(s);
  const text =
    abs < 60 ? rtf.format(s, "second") : abs < 3600 ? rtf.format(Math.round(s / 60), "minute") : abs < 86_400 ? rtf.format(Math.round(s / 3600), "hour") : rtf.format(Math.round(s / 86_400), "day");
  return text.toLocaleLowerCase("vi");
}

// One interval for every mounted RelTime (not one timer per instance), stopped when none is left.
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
function useTick(): void {
  const [, setN] = useState(0);
  useEffect(() => {
    const tick = () => setN((n) => n + 1);
    subscribers.add(tick);
    timer ??= setInterval(() => subscribers.forEach((f) => f()), 30_000);
    return () => {
      subscribers.delete(tick);
      if (subscribers.size === 0 && timer) {
        clearInterval(timer);
        timer = undefined;
      }
    };
  }, []);
}

// SSR + hydration render the absolute date; after mount the relative one (title keeps the absolute date).
export function RelTime({ at, unit = "s", prefix = "", ...ui }: { at: number; unit?: "s" | "ms"; prefix?: string; "data-ui"?: string }) {
  const ms = unit === "s" ? at * 1000 : at;
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useTick();
  const absolute = new Date(ms).toLocaleString("vi-VN");
  return (
    <time dateTime={new Date(ms).toISOString()} title={absolute} suppressHydrationWarning data-ui={ui["data-ui"]}>
      {prefix}
      {mounted ? relative(ms, Date.now()) : absolute}
    </time>
  );
}
