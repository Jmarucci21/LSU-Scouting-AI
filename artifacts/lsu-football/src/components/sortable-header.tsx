import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";

// Clickable table header that drives asc/desc sorting. Shared across the Stats
// Explorer, Player Explorer, and team roster so the sort interaction is
// identical everywhere.
export function SortableHeader({
  label,
  active,
  order,
  onClick,
  align = "left",
}: {
  label: string;
  active: boolean;
  order: "asc" | "desc";
  onClick: () => void;
  align?: "left" | "right";
}) {
  return (
    <th className={`p-4 font-semibold ${align === "right" ? "text-right" : ""}`}>
      <button
        type="button"
        onClick={onClick}
        aria-sort={active ? (order === "asc" ? "ascending" : "descending") : "none"}
        className={`inline-flex items-center gap-1 uppercase tracking-wider transition-colors hover:text-foreground ${
          align === "right" ? "flex-row-reverse" : ""
        } ${active ? "text-foreground" : ""}`}
      >
        {label}
        {active ? (
          order === "asc" ? (
            <ChevronUp className="w-3.5 h-3.5" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" />
          )
        ) : (
          <ChevronsUpDown className="w-3.5 h-3.5 opacity-50" />
        )}
      </button>
    </th>
  );
}
