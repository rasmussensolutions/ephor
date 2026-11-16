export const themeStorageKey = "ephor-theme";

export const themeScript = `try {
  if (localStorage.getItem(${JSON.stringify(themeStorageKey)}) === "dark") {
    document.documentElement.classList.add("dark");
  }
} catch {}`;
