import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { SourceSheet } from "../components/SourceSheet";

export interface SourceSheetData {
  url: string;
  title?: string;
  quote?: string;
  trustTier?: string;
  date?: string;
}

interface SourceContextValue {
  openSource: (source: SourceSheetData) => void;
  closeSource: () => void;
}

const SourceContext = createContext<SourceContextValue | null>(null);

export function SourceProvider({ children }: { children: ReactNode }) {
  const [source, setSource] = useState<SourceSheetData | null>(null);

  useEffect(() => {
    document.body.classList.toggle("overlay-open", Boolean(source));
    return () => document.body.classList.remove("overlay-open");
  }, [source]);

  const openSource = useCallback((next: SourceSheetData) => setSource(next), []);
  const closeSource = useCallback(() => setSource(null), []);

  const value = useMemo(
    () => ({ openSource, closeSource }),
    [openSource, closeSource],
  );

  return (
    <SourceContext.Provider value={value}>
      {children}
      <SourceSheet source={source} onClose={closeSource} />
    </SourceContext.Provider>
  );
}

export function useSource(): SourceContextValue {
  const context = useContext(SourceContext);
  if (!context) throw new Error("useSource must be used inside SourceProvider");
  return context;
}
