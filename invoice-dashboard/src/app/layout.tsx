import type { Metadata } from "next";
import "./globals.css";
import "leaflet/dist/leaflet.css";
import { AppShell } from "@/components/AppShell";

export const metadata: Metadata = {
  title: "Baker Database",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}