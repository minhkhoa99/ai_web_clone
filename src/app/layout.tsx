import type { ReactNode } from "react";

export const metadata = { title: "AI Web Clone" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
