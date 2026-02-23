export function Badge({
  children,
  variant = "default",
}: {
  children: React.ReactNode;
  variant?: "default" | "warning" | "danger" | "success";
}) {
  const cls =
    variant === "danger"
      ? "bg-red-100 text-red-800 border-red-200"
      : variant === "warning"
      ? "bg-yellow-100 text-yellow-800 border-yellow-200"
      : variant === "success"
      ? "bg-green-100 text-green-800 border-green-200"
      : "bg-gray-100 text-gray-800 border-gray-200";

  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {children}
    </span>
  );
}