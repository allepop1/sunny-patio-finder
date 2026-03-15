import { Search, MapPin } from "lucide-react";
import { useState } from "react";

interface SearchBarProps {
  onSearch: (query: string) => void;
  onLocateMe: () => void;
  isLocating?: boolean;
}

export function SearchBar({ onSearch, onLocateMe, isLocating }: SearchBarProps) {
  const [query, setQuery] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) onSearch(query.trim());
  };

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2 w-full">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Sök restaurang eller adress..."
          className="w-full rounded-lg border border-border bg-card py-2.5 pl-10 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/50 font-body"
        />
      </div>
      <button
        type="button"
        onClick={onLocateMe}
        disabled={isLocating}
        className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
      >
        <MapPin className="h-4 w-4" />
        <span className="hidden sm:inline">{isLocating ? "Söker..." : "Min plats"}</span>
      </button>
    </form>
  );
}
