import { useQuery } from "@tanstack/react-query";
import { request } from "@/lib/auth";
import { apiKey, queryClient } from "@/lib/query";

/** Route loaders and live views share one cache; focus refresh retains the last report. */
export function useApiQuery<T>(
  path: string,
  initialData: T,
  interval = 15_000,
) {
  const query = useQuery({
    queryKey: apiKey(path),
    queryFn: ({ signal }) => request<T>(path, undefined, signal),
    initialData,
    initialDataUpdatedAt: () =>
      queryClient().getQueryState(apiKey(path))?.dataUpdatedAt ?? Date.now(),
    refetchInterval: interval,
    refetchIntervalInBackground: false,
  });
  return { ...query, data: query.data ?? initialData };
}
