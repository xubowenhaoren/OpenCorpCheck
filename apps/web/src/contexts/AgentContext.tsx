import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface AgentCompanyContext {
  ref: string;
  name: string;
  ticker?: string;
}

interface AgentContextValue {
  open: boolean;
  company: AgentCompanyContext | null;
  initialQuestion: string | null;
  openAgent: (
    company?: AgentCompanyContext | null,
    question?: string,
  ) => void;
  closeAgent: () => void;
  consumeInitialQuestion: () => void;
}

const AgentContext = createContext<AgentContextValue | null>(null);

export function AgentProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [company, setCompany] = useState<AgentCompanyContext | null>(null);
  const [initialQuestion, setInitialQuestion] = useState<string | null>(null);

  useEffect(() => {
    document.body.classList.toggle("ask-open", open);
    return () => document.body.classList.remove("ask-open");
  }, [open]);

  const openAgent = useCallback(
    (nextCompany: AgentCompanyContext | null = null, question?: string) => {
      setCompany(nextCompany);
      setInitialQuestion(question?.trim() ? question : null);
      setOpen(true);
    },
    [],
  );

  const closeAgent = useCallback(() => {
    setOpen(false);
    setInitialQuestion(null);
  }, []);

  const consumeInitialQuestion = useCallback(() => {
    setInitialQuestion(null);
  }, []);

  const value = useMemo(
    () => ({
      open,
      company,
      initialQuestion,
      openAgent,
      closeAgent,
      consumeInitialQuestion,
    }),
    [open, company, initialQuestion, openAgent, closeAgent, consumeInitialQuestion],
  );

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

export function useAgent(): AgentContextValue {
  const context = useContext(AgentContext);
  if (!context) throw new Error("useAgent must be used inside AgentProvider");
  return context;
}
