import { Search, MapPin, Loader2 } from "lucide-react";
import { useState } from "react";

interface SearchBarProps {
  onSearch: (query: string) => void;
  onLocateMe: () => void;
  isLocating?: boolean;
  isSearching?: boolean;
}

export function SearchBar({ onSearch, onLocateMe, isLocating, isSearching }: SearchBarProps) {
  const [query, setQuery] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim() && !isSearching) onSearch(query.trim());
  };

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2 w-full">
      <div className="relative flex-1">
        {isSearching ? (
          <Loader2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin" />
        ) : (
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        )}
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Sök restaurang eller adress..."
          disabled={isSearching}
          className="w-full rounded-lg border border-border bg-card py-3 pl-10 pr-4 text-base text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/50 font-body disabled:opacity-60"
        />
      </div>
      <button
        type="button"
        onClick={onLocateMe}
        disabled={isLocating}
        className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 active:bg-primary/80 disabled:opacity-50 shrink-0"
      >
        <MapPin className="h-4 w-4 shrink-0" />
        <span>{isLocating ? "Söker..." : "Min plats"}</span>
      </button>
    </form>
  );
}
