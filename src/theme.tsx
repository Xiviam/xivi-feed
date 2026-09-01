import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export const THEME_MODES = ["light", "dark", "system"] as const;

export type ThemeMode = (typeof THEME_MODES)[number];
export type ResolvedTheme = Exclude<ThemeMode, "system">;

type ThemeContextValue = {
  theme: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemeMode) => void;
};

type ThemeProviderProps = {
  children: ReactNode;
  defaultTheme?: ThemeMode;
  storageKey?: string;
};

const DEFAULT_STORAGE_KEY = "xivi-theme";
const DARK_MODE_QUERY = "(prefers-color-scheme: dark)";

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isThemeMode(value: string | null): value is ThemeMode {
  return THEME_MODES.some((theme) => theme === value);
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }

  return window.matchMedia(DARK_MODE_QUERY).matches ? "dark" : "light";
}

function getStoredTheme(storageKey: string, fallback: ThemeMode): ThemeMode {
  if (typeof window === "undefined") return fallback;

  try {
    const storedTheme = window.localStorage.getItem(storageKey);
    return isThemeMode(storedTheme) ? storedTheme : fallback;
  } catch {
    // Browsers can deny storage access (for example, in a restricted iframe).
    return fallback;
  }
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = DEFAULT_STORAGE_KEY,
}: ThemeProviderProps) {
  // Always start from the same value on the server and during hydration.
  const [theme, setThemeState] = useState<ThemeMode>(defaultTheme);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>("light");
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    setThemeState(getStoredTheme(storageKey, defaultTheme));
    setIsHydrated(true);
  }, [defaultTheme, storageKey]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

    const mediaQuery = window.matchMedia(DARK_MODE_QUERY);
    const updateSystemTheme = (event: MediaQueryListEvent | MediaQueryList) => {
      setSystemTheme(event.matches ? "dark" : "light");
    };

    updateSystemTheme(mediaQuery);
    mediaQuery.addEventListener("change", updateSystemTheme);
    return () => mediaQuery.removeEventListener("change", updateSystemTheme);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const syncThemeAcrossTabs = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      setThemeState(isThemeMode(event.newValue) ? event.newValue : defaultTheme);
    };

    window.addEventListener("storage", syncThemeAcrossTabs);
    return () => window.removeEventListener("storage", syncThemeAcrossTabs);
  }, [defaultTheme, storageKey]);

  const resolvedTheme = theme === "system" ? systemTheme : theme;

  useEffect(() => {
    if (!isHydrated || typeof document === "undefined") return;

    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.style.colorScheme = resolvedTheme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", resolvedTheme === "dark" ? "#111315" : "#f7f4ee");
  }, [isHydrated, resolvedTheme]);

  const setTheme = useCallback(
    (nextTheme: ThemeMode) => {
      setThemeState(nextTheme);

      if (typeof window === "undefined") return;
      try {
        window.localStorage.setItem(storageKey, nextTheme);
      } catch {
        // The in-memory preference still works when persistence is unavailable.
      }
    },
    [storageKey],
  );

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [resolvedTheme, setTheme, theme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }

  return context;
}
