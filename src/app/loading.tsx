export default function Loading() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center p-8">
      <div className="flex items-center gap-3">
        <div className="size-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <span className="font-heading text-base font-semibold text-muted-foreground">
          Loading InnoVision…
        </span>
      </div>
    </div>
  );
}
