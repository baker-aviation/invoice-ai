"use client";

/**
 * Sticky banner shown only in development to make it obvious
 * you're not looking at production.
 */
export function DevBanner() {
  if (process.env.NODE_ENV !== "development") return null;

  const isReadOnly = process.env.NEXT_PUBLIC_DEV_READ_ONLY === "true";

  return (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        background: isReadOnly ? "#b91c1c" : "#d97706",
        color: "white",
        textAlign: "center",
        padding: "4px 8px",
        fontSize: "12px",
        fontWeight: 600,
        letterSpacing: "0.05em",
        pointerEvents: "none",
      }}
    >
      {isReadOnly
        ? "DEV — READ-ONLY MODE (writes blocked)"
        : "DEV — CONNECTED TO PRODUCTION DATA"}
    </div>
  );
}
