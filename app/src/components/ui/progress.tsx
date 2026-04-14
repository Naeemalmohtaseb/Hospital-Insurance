import { cn } from "../../lib/utils";

type ProgressProps = {
  value: number;
  className?: string;
};

export function Progress({ value, className }: ProgressProps) {
  const safeValue = Math.max(0, Math.min(100, value));

  return (
    <div className={cn("h-2 w-full overflow-hidden rounded-md bg-neutral-200", className)}>
      <div className="h-full rounded-md bg-primary" style={{ width: `${safeValue}%` }} />
    </div>
  );
}
