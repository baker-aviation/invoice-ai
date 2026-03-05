"use client";

import Image from "next/image";

export type TopbarProps = {
  title?: string;
};

export function Topbar({ title }: TopbarProps) {
  return (
    <div className="flex items-center justify-between px-6 py-4 border-b bg-white">
      <div className="flex items-center gap-3">
        <Image src="/logo2.png" alt="Baker Aviation" width={160} height={50} priority />
        {title ? <span className="text-lg font-semibold">{title}</span> : null}
      </div>
    </div>
  );
}

// ✅ This line makes BOTH of these work:
//   import Topbar from "@/components/Topbar"
//   import { Topbar } from "@/components/Topbar"
export default Topbar;