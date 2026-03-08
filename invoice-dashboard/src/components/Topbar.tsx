export type TopbarProps = {
  title?: string;
};

export function Topbar({ title }: TopbarProps) {
  if (!title) return null;
  return (
    <div className="px-6 py-4 border-b bg-white">
      <h1 className="text-lg font-semibold text-gray-900">{title}</h1>
    </div>
  );
}

// ✅ This line makes BOTH of these work:
//   import Topbar from "@/components/Topbar"
//   import { Topbar } from "@/components/Topbar"
export default Topbar;