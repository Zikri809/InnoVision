"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import {
  TriangleAlert,
  Archive,
  Award,
  Bell,
  CameraOff,
  CheckCheck,
  CircleCheck,
  FileText,
  Lock,
  LockOpen,
  Radio,
  LogOut,
  RefreshCw,
  UserPlus,
  UserSearch,
  Video,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { copyFor } from "@/lib/notifications/copy";
import { resolveNotificationLink } from "@/lib/notifications/link";
import { useNotifications } from "@/lib/notifications/use-notifications";
import { EmptyState } from "@/components/ui/empty-state";
import { NotificationBellRingingIllustration } from "@/components/illustrations/notification-bell-ringing";
import {
  DIGEST_TYPES,
  PINNED_TYPES,
  type NotificationItem,
  type NotificationType,
} from "@/lib/notifications/types";

const TYPE_ICONS: Record<NotificationType, React.ComponentType<{ className?: string }>> = {
  quiz_live: Radio,
  results_revealed: Award,
  session_reset: RefreshCw,
  removed_from_class: LogOut,
  class_archived: Archive,
  student_joined: UserPlus,
  session_submitted: CircleCheck,
  session_flagged: TriangleAlert,
  quiz_completed_all: CheckCheck,
  incident_clip_recorded: Video,
  face_unavailable_reported: CameraOff,
  face_enrollment_held: UserSearch,
  quiz_closed: Lock,
  session_unlocked: LockOpen,
};

/** Assessments get the exam-paper icon; practice keeps the live dot. */
function iconFor(type: NotificationType, payload: Record<string, unknown>) {
  if (type === "quiz_live" && payload.mode === "assessment") return FileText;
  return TYPE_ICONS[type];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function bodyParams(
  payload: Record<string, unknown>,
  nameFallback: string,
): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  const quizTitle = str(payload.quiz_title);
  const classTitle = str(payload.class_title);
  // profiles.full_name is nullable/blank-able — a missing name must still
  // satisfy the ICU placeholder or next-intl throws MISSING_VALUE.
  params.studentName = str(payload.student_name) ?? nameFallback;
  if (quizTitle) params.quizTitle = quizTitle;
  if (classTitle) params.className = classTitle;
  return params;
}

function relativeTime(iso: string, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const diffMs = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diffMs);
  if (abs < 60_000) return rtf.format(-Math.round(diffMs / 1000), "second");
  if (abs < 3_600_000) return rtf.format(-Math.round(diffMs / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(-Math.round(diffMs / 3_600_000), "hour");
  if (abs < 604_800_000) return rtf.format(-Math.round(diffMs / 86_400_000), "day");
  if (abs < 2_592_000_000) return rtf.format(-Math.round(diffMs / 604_800_000), "week");
  return rtf.format(-Math.round(diffMs / 2_592_000_000), "month");
}

interface DigestGroup {
  type: NotificationType;
  count: number;
  newest: NotificationItem;
}

interface Entry {
  key: string;
  item?: NotificationItem;
  group?: DigestGroup;
}

function splitEntries(items: NotificationItem[]): {
  pinned: NotificationItem[];
  recent: Entry[];
} {
  const pinned = items.filter((n) => n.readAt == null && PINNED_TYPES.has(n.type));
  const pinnedIds = new Set(pinned.map((n) => n.id));
  const recent: Entry[] = [];
  const groups = new Map<string, DigestGroup>();
  for (const n of items) {
    if (pinnedIds.has(n.id)) continue;
    if (n.readAt == null && DIGEST_TYPES.has(n.type)) {
      const entity = str(n.payload.class_id) ?? str(n.payload.quiz_id) ?? n.id;
      const gk = `${n.type}:${entity}`;
      const existing = groups.get(gk);
      if (existing) {
        existing.count += 1;
      } else {
        const group: DigestGroup = { type: n.type, count: 1, newest: n };
        groups.set(gk, group);
        recent.push({ key: gk, group });
      }
    } else {
      recent.push({ key: n.id, item: n });
    }
  }
  return { pinned, recent };
}

export function NotificationBell({
  userId,
  role,
  initialItems,
  initialCount,
}: {
  userId: string;
  role: "lecturer" | "student";
  initialItems: NotificationItem[];
  initialCount: number;
}) {
  const t = useTranslations("notifications");
  const tc = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const supabase = React.useMemo(() => createClient(), []);

  const {
    items,
    unreadCount,
    loadingMore,
    hasMore,
    loadMore,
    markRead,
    markAllRead,
  } = useNotifications({ userId, initialItems, initialUnreadCount: initialCount });

  const [open, setOpen] = React.useState(false);
  const [confirmClear, setConfirmClear] = React.useState(false);
  const [announce, setAnnounce] = React.useState("");
  const prevUnread = React.useRef(initialCount);

  // Polish round (W3 A2): derive the surface from the same media query the
  // modal hoist uses, read in the render pass. The old `useState(true)` +
  // effect correction painted the desktop popover on every mobile first
  // render — a real flicker on each load.
  const isDesktop = useMediaQuery("(min-width: 640px)");

  // aria-live announces poll/realtime deltas only, suppressed while open.
  React.useEffect(() => {
    const delta = unreadCount - prevUnread.current;
    prevUnread.current = unreadCount;
    if (delta > 0 && !open) setAnnounce(t("a11y.newCount", { count: delta }));
  }, [unreadCount, open, t]);

  const { pinned, recent } = React.useMemo(() => splitEntries(items), [items]);

  const homeHref = role === "lecturer" ? "/lecturer/classes" : "/student/classes";

  async function openItem(item: NotificationItem) {
    // Optimistic close BEFORE navigation (plan W1 sheet-close-on-navigate):
    // the sheet must never hang open over the destination.
    setOpen(false);
    const link = resolveNotificationLink(item.type, item.payload);
    let href = link.href;

    if (link.resolveSessionQuizId) {
      const { data } = await supabase
        .from("quiz_sessions")
        .select("id")
        .eq("quiz_id", link.resolveSessionQuizId)
        .eq("status", "completed")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data?.id) href = `/play/${data.id}`;
    } else if (link.probe) {
      const { data } = await supabase
        .from(link.probe.table)
        .select("id")
        .eq("id", link.probe.id)
        .maybeSingle();
      if (!data) {
        // Dead target (deleted quiz): stop drawing attention, land somewhere safe.
        void markRead([item.id]);
        router.push(homeHref);
        return;
      }
    }

    void markRead([item.id]);
    router.push(href);
  }

  async function onMarkAll() {
    if (unreadCount > 20) {
      setConfirmClear(true);
      return;
    }
    await markAllRead();
  }

  const badgeDisplay =
    unreadCount > 99 ? "99+" : unreadCount > 0 ? String(unreadCount) : null;
  const badgeLabel =
    unreadCount > 0 ? t("bell.labelUnread", { count: unreadCount }) : t("bell.label");

  function renderRow(entry: Entry) {
    const item = entry.item ?? entry.group!.newest;
    const Icon = iconFor(item.type, item.payload);
    const copy = copyFor(item.type, item.payload);
    const unread = item.readAt == null;
    const count = entry.group?.count ?? 1;

    const title =
      entry.group && count > 1
        ? t(`digest.${entry.group.type}`, {
            count,
            ...bodyParams(item.payload, t("fallback.studentName")),
          })
        : t(copy.titleKey);

    return (
      <li key={entry.key} className="min-w-0">
        <button
          type="button"
          onClick={() => void openItem(item)}
          className="flex w-full items-start gap-2.5 p-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Icon
            className={cn(
              "mt-0.5 h-5 w-5 shrink-0",
              unread ? "text-primary/70" : "text-muted-foreground/60",
            )}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm font-bold text-foreground",
                  !unread && "font-semibold text-muted-foreground",
                )}
              >
                {title}
              </span>
              {unread && (
                <span
                  className="h-2 w-2 shrink-0 rounded-full bg-primary"
                  aria-hidden="true"
                />
              )}
              <span className="shrink-0 text-[11px] font-semibold text-muted-foreground/75">
                {relativeTime(item.createdAt, locale)}
              </span>
            </span>
            <span className="mt-0.5 line-clamp-2 text-xs font-semibold text-muted-foreground leading-relaxed">
              {t(copy.bodyKey, bodyParams(item.payload, t("fallback.studentName")))}
            </span>
          </span>
        </button>
      </li>
    );
  }

  function renderBody() {
    if (items.length === 0) {
      return (
        <EmptyState
          illustration={NotificationBellRingingIllustration}
          title={t("panel.emptyTitle")}
          subtitle={t("panel.emptyBody")}
          iconClassName="h-12 w-auto"
          className="py-8"
        />
      );
    }
    return (
      <>
        {pinned.length > 0 && (
          <section aria-label={t("panel.pinnedLabel")} className="mb-2">
            <p className="px-2 pt-1 pb-1 text-xs font-bold tracking-wide text-amber-700 uppercase dark:text-amber-400">
              {t("panel.pinnedLabel")}
            </p>
            <ul className="divide-y divide-border">
              {pinned.map((n) => renderRow({ key: n.id, item: n }))}
            </ul>
          </section>
        )}
        {recent.length > 0 && <ul className="divide-y divide-border">{recent.map(renderRow)}</ul>}
        {hasMore && (
          <div className="pt-2 pb-1 text-center">
            <Button
              variant="ghost"
              size="sm"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? tc("loading") : t("panel.loadMore")}
            </Button>
          </div>
        )}
      </>
    );
  }

  const listScroll = "min-h-0 flex-1 overflow-y-auto pr-1";

  return (
    <>
      {isDesktop ? (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="relative h-11 w-11 rounded-[14px]"
                aria-label={badgeLabel}
              />
            }
          >
            <Bell className="h-5 w-5" aria-hidden="true" />
            {badgeDisplay && (
              <span
                aria-hidden="true"
                className="absolute -top-1 -right-1 grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-[11px] font-bold leading-none text-primary-foreground"
              >
                {badgeDisplay}
              </span>
            )}
          </PopoverTrigger>
          <PopoverContent className="w-[380px] max-w-[calc(100vw-1.5rem)]">
            <div className="flex items-center gap-2 pb-3">
              <span className="font-heading text-lg font-bold">
                {t("panel.title")}
              </span>
              {unreadCount > 0 && (
                <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-extrabold text-primary">
                  {unreadCount}
                </span>
              )}
              <Button
                variant="ghost"
                size="xs"
                className="ml-auto font-bold text-primary"
                onClick={() => void onMarkAll()}
                disabled={unreadCount === 0}
              >
                {t("panel.markAllRead")}
              </Button>
            </div>
            <div className={listScroll}>{renderBody()}</div>
          </PopoverContent>
        </Popover>
      ) : (
        <>
          <Button
            variant="ghost"
            size="icon"
            className="relative h-11 w-11 rounded-[14px]"
            aria-label={badgeLabel}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen(true)}
          >
            <Bell className="h-5 w-5" aria-hidden="true" />
            {badgeDisplay && (
              <span
                aria-hidden="true"
                className="absolute -top-1 -right-1 grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-[11px] font-bold leading-none text-primary-foreground"
              >
                {badgeDisplay}
              </span>
            )}
          </Button>
          <Drawer open={open} onOpenChange={setOpen} handleOnly>
            <DrawerContent innerClassName="p-3 pb-6 flex flex-col max-h-[85dvh]">
              <DrawerHeader className="flex-row items-center gap-2 px-1 pt-1 pb-2 text-left">
                <DrawerTitle className="font-heading text-lg font-bold">{t("panel.title")}</DrawerTitle>
                {unreadCount > 0 && (
                  <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-extrabold text-primary">
                    {unreadCount}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="xs"
                  className="ml-auto font-bold text-primary"
                  onClick={() => void onMarkAll()}
                  disabled={unreadCount === 0}
                >
                  {t("panel.markAllRead")}
                </Button>
                <DrawerDescription className="sr-only">
                  {t("panel.sheetDescription")}
                </DrawerDescription>
              </DrawerHeader>
              <div className={listScroll}>{renderBody()}</div>
            </DrawerContent>
          </Drawer>
        </>
      )}

      <Dialog open={confirmClear} onOpenChange={setConfirmClear}>
        <DialogContent showCloseButton={false} className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle>{t("panel.clearConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("panel.clearConfirmBody", { count: unreadCount })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmClear(false)}>
              {tc("cancel")}
            </Button>
            <Button onClick={() => void markAllRead()}>
              {t("panel.markAllRead")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div aria-live="polite" className="sr-only">
        {announce}
      </div>
    </>
  );
}
