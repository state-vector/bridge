import { useEffect, useId, useRef, useState } from "react";
import { Btn } from "./Btn";
import { TextInput } from "./Inputs";

/** Direct lookup is independent of the board's filters and loaded card list. */
export function CardLookup({ onOpen }: { onOpen: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const errorId = useId();
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const focusLookup = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        const input = formRef.current?.querySelector("input");
        input?.focus();
        input?.select();
      }
    };
    window.addEventListener("keydown", focusLookup);
    return () => window.removeEventListener("keydown", focusLookup);
  }, []);

  return (
    <form ref={formRef} className="k-card-lookup" role="search" aria-label="Card lookup" onSubmit={(event) => {
      event.preventDefault();
      const match = /^(?:BR\s*[#-]?\s*|#\s*)?(\d+)$/i.exec(query.trim());
      if (!match) {
        setError("Enter a card number, e.g. BR#6690.");
        return;
      }
      setError("");
      onOpen(`BR#${match[1]}`);
    }}>
      <div className="k-card-lookup-controls">
        <TextInput
          aria-label="Card number"
          aria-keyshortcuts="Meta+K Control+K"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          placeholder="Go to BR#…"
          title="Open a card by number (⌘K / Ctrl+K)"
          autoComplete="off"
          value={query}
          onChange={(event) => { setQuery(event.target.value); setError(""); }}
          onKeyDown={(event) => { if (event.key === "Escape") { setQuery(""); setError(""); } }}
        />
        <Btn size="sm" type="submit" aria-label="Open card">Go</Btn>
      </div>
      {error && <span id={errorId} className="k-card-lookup-error" role="alert">{error}</span>}
    </form>
  );
}
