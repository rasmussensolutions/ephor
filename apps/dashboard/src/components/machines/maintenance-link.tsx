export function MaintenanceLink({ id }: { id: string }) {
  return (
    <a
      href={`/machines/${encodeURIComponent(id)}#maintenance`}
      className="text-sm underline underline-offset-4"
    >
      Manage Ephor on this machine
    </a>
  );
}
