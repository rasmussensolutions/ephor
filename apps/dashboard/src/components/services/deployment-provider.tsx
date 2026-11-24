import {
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import type { DeploymentMode } from "@/lib/deployment-sources";

export interface DeploymentOptions {
  source?: DeploymentMode;
  machineId?: string;
  projectId?: string;
}
const loadDeploymentDialog = () => import("./deployment-dialog");
const DeploymentDialog = lazy(loadDeploymentDialog);

export function prefetchDeployment(options: DeploymentOptions = {}) {
  void loadDeploymentDialog()
    .then(({ prefetchDeploymentData }) => prefetchDeploymentData(options))
    .catch(() => {
      // Opening the dialog retries loading and reports errors in context.
    });
}
const Context = createContext<((options?: DeploymentOptions) => void) | null>(
  null,
);

export function useDeploymentDialog() {
  const open = useContext(Context);
  if (!open) throw new Error("DeploymentProvider is missing");
  return open;
}

export function DeploymentProvider({ children }: { children: ReactNode }) {
  const sequence = useRef(0);
  const [request, setRequest] = useState<{
    id: number;
    options: DeploymentOptions;
    trigger: HTMLElement | null;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const openDeployment = useCallback((options: DeploymentOptions = {}) => {
    setRequest({
      id: ++sequence.current,
      options,
      trigger:
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null,
    });
    setOpen(true);
  }, []);
  return (
    <Context.Provider value={openDeployment}>
      {children}
      {request && (
        <Suspense
          fallback={
            <span role="status" className="sr-only">
              Opening deployment…
            </span>
          }
        >
          <DeploymentDialog
            key={request.id}
            options={request.options}
            open={open}
            onClose={() => setOpen(false)}
            onClosed={() =>
              setRequest((current) =>
                current?.id === request.id ? null : current,
              )
            }
            trigger={request.trigger}
          />
        </Suspense>
      )}
    </Context.Provider>
  );
}
