import type { Metadata } from "next";
import "./globals.css";
import "leaflet/dist/leaflet.css";
import { AppShellWrapper } from "@/components/AppShellWrapper";
import { DevBanner } from "@/components/DevBanner";

export const metadata: Metadata = {
  title: "Baker Database",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppShellWrapper>{children}</AppShellWrapper>
        <DevBanner />
      </body>
    </html>
  );
}