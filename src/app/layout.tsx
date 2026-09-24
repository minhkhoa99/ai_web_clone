import type { ReactNode } from "react";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { Shell } from "./_ui/Shell";
import "./globals.css";

// Self-hosted at build time by next/font: no runtime font CDN.
const head = Space_Grotesk({ subsets: ["latin", "vietnamese"], variable: "--font-head" });
const body = Inter({ subsets: ["latin", "vietnamese"], variable: "--font-body" });
const mono = JetBrains_Mono({ subsets: ["latin", "vietnamese"], variable: "--font-mono" });

export const metadata = { title: "AI Web Clone" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi" className={`${head.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
