"use client";

import dynamic from "next/dynamic";

const VanPositioningClient = dynamic(() => import("./VanPositioningClient"), { ssr: false });

export default function VanPositioningWrapper(props: React.ComponentProps<typeof VanPositioningClient>) {
  return <VanPositioningClient {...props} />;
}
