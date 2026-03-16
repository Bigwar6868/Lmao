"use client";

export function Card({
  title,
  children,
  className = "",
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-[var(--border)] bg-[var(--card)] p-5 ${className}`}
    >
      <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-[var(--muted)]">
        {title}
      </h2>
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  delta,
}: {
  label: string;
  value: string;
  delta?: number;
}) {
  const color =
    delta === undefined
      ? "text-[var(--fg)]"
      : delta >= 0
        ? "text-[var(--green)]"
        : "text-[var(--red)]";

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-[var(--muted)]">{label}</span>
      <span className={`text-lg font-semibold ${color}`}>{value}</span>
    </div>
  );
}
