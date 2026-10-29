import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delay = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function looksLikeQuestion(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (/[?？]$/.test(text)) return true;
  if (/^(为什么|怎么|如何|多少|哪些|是否|能不能|谁|哪家|what|why|how|who|which|is|does|can)\b/i.test(text)) {
    return true;
  }
  return text.length > 18 && /[吗呢吧]$/.test(text);
}
