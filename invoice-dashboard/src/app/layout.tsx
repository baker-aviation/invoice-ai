import type { Metadata } from "next";
import "./globals.css";
import "leaflet/dist/leaflet.css";
import { AppShellWrapper } from "@/components/AppShellWrapper";
import { DevBanner } from "@/components/DevBanner";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

export const metadata: Metadata = {
  title: "Baker Database",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cn("font-sans", geist.variable)}>
      <body>
        <AppShellWrapper>{children}</AppShellWrapper>
        <DevBanner />
      </body>
    </html>
  );
}