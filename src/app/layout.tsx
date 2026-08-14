import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GM Intelligence Board",
  description: "Champions Group location-level KPI command center",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
