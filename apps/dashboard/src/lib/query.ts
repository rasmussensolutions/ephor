import { QueryClient } from "@tanstack/react-query";

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        gcTime: 5 * 60_000,
        retry: false,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },
    },
  });
}
let browserClient: QueryClient | undefined;
export function queryClient() {
  // The authenticated app is client rendered. Never share user data during SSR.
  if (typeof window === "undefined") return createQueryClient();
  browserClient ??= createQueryClient();
  return browserClient;
}
export const apiKey = (path: string) => ["api", path] as const;
