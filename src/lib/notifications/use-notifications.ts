"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { mergeNotifications } from "./merge";
import {
  effectivePollMs,
  nextHealth,
  type ChannelHealth,
} from "./poll-state";
import {
  mapRawRow,
  type NotificationItem,
  type RawNotificationRow,
} from "./types";

const PAGE_SIZE = 20;
const LIST_CAP = 100;

export interface UseNotificationsOptions {
  userId: string;
  initialItems: NotificationItem[];
  initialUnreadCount: number;
}

export interface UseNotificationsResult {
  items: NotificationItem[];
  unreadCount: number;
  healthy: ChannelHealth;
  loadingMore: boolean;
  hasMore: boolean;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  markRead: (ids: string[]) => Promise<void>;
  markAllRead: () => Promise<void>;
}

/**
 * One channel per authenticated shell (`notif:<uid>`), INSERT-only,
 * recipient-filtered — RLS (not the filter) is the security boundary.
 * Polling is the consistency backbone: postgres_changes has NO replay, so
 * every socket gap heals via the next poll. Hidden tabs disconnect (frees a
 * free-tier connection seat); focus/visibility resume refetches immediately.
 */
export function useNotifications({
  userId,
  initialItems,
  initialUnreadCount,
}: UseNotificationsOptions): UseNotificationsResult {
  const supabase = useMemo(() => createClient(), []);

  const [items, setItems] = useState<NotificationItem[]>(initialItems);
  const [unreadCount, setUnreadCount] = useState(initialUnreadCount);
  // audit-3 H-F3: start UNHEALTHY, not "subscribed". Realtime is only a
  // latency accelerator — on remote deploys the WS never upgrades, so polling
  // is the only delivery path. Assuming health before the channel has actually
  // confirmed would poll at the slow cadence (or, combined with a hidden-tab
  // mount, never at all) and a lecturer could miss `session_flagged`.
  const [healthy, setHealthy] = useState<ChannelHealth>("unhealthy");
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(initialItems.length >= PAGE_SIZE);
  // Visibility is STATE (not just a ref) so the poll effect below re-evaluates
  // when the tab becomes visible. The ref stays for the synchronous readers
  // (ensureSubscribed) that must not wait for a render.
  const [visible, setVisible] = useState(
    typeof document === "undefined" ? true : !document.hidden,
  );

  const itemsRef = useRef(items);
  // Sync after commit (react-compiler forbids ref writes during render).
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const visibleRef = useRef(visible);

  const handleInsert = useCallback((row: RawNotificationRow) => {
    const item = mapRawRow(row);
    if (!item) return;
    // audit-1 P1-14: a realtime reconnect can REPLAY an INSERT the poll
    // already delivered — count the badge only for ids the list has not
    // seen, or every replay double-counts an unread. The next poll's
    // absolute badge recount heals any residual drift.
    const seen = new Set(itemsRef.current.map((n) => n.id));
    setItems((prev) => mergeNotifications(prev, [item], LIST_CAP));
    if (item.readAt == null && !seen.has(item.id)) setUnreadCount((n) => n + 1);
  }, []);

  /** Badge count — index-only scan over the partial unread index. */
  const refreshBadge = useCallback(async () => {
    try {
      const { count } = await supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .is("read_at", null);
      setUnreadCount(count ?? 0);
    } catch {
      // Transport failure (offline / sleeping-tab wake). PostgREST throws on
      // network errors rather than returning {error} — swallow here so the
      // fire-and-forget poll loop never produces an unhandled rejection.
    }
  }, [supabase]);

  const refresh = useCallback(async () => {
    try {
      const [listRes, badge] = await Promise.all([
        supabase
          .from("notifications")
          .select("id, seq, type, payload, read_at, created_at")
          .order("seq", { ascending: false })
          .limit(PAGE_SIZE),
        supabase
          .from("notifications")
          .select("id", { count: "exact", head: true })
          .is("read_at", null),
      ]);
      if (listRes.data) {
        const mapped = listRes.data
          .map((r) => mapRawRow(r as RawNotificationRow))
          .filter((x): x is NotificationItem => x !== null);
        // audit-1 P1-14: MERGE into the current list (incoming rows win on
        // duplicate ids, so read-state stays fresh) — the old replace wiped
        // everything a loadMore had appended, 8s later, every poll.
        setItems((prev) => mergeNotifications(prev, mapped, LIST_CAP));
        setHasMore(mapped.length >= PAGE_SIZE);
      }
      if (typeof badge.count === "number") setUnreadCount(badge.count);
    } catch {
      // Same transport-failure contract as refreshBadge — keep stale state.
    }
  }, [supabase]);

  const loadMore = useCallback(async () => {
    const current = itemsRef.current;
    const cursor = current.at(-1)?.seq;
    if (cursor == null || loadingMore) return;
    setLoadingMore(true);
    try {
      const { data } = await supabase
        .from("notifications")
        .select("id, seq, type, payload, read_at, created_at")
        .lt("seq", cursor)
        .order("seq", { ascending: false })
        .limit(PAGE_SIZE);
      if (data) {
        const mapped = data
          .map((r) => mapRawRow(r as RawNotificationRow))
          .filter((x): x is NotificationItem => x !== null);
        setItems((prev) => mergeNotifications(prev, mapped, Number.MAX_SAFE_INTEGER));
        setHasMore(mapped.length >= PAGE_SIZE);
      }
    } catch {
      // Keep the list as-is; the user can retry the load-more control.
    } finally {
      setLoadingMore(false);
    }
  }, [supabase, loadingMore]);

  const markRead = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      const now = new Date().toISOString();
      const target = new Set(ids);
      const snapshot = itemsRef.current;
      setItems((prev) =>
        prev.map((n) =>
          target.has(n.id) && n.readAt == null ? { ...n, readAt: now } : n,
        ),
      );
      setUnreadCount((n) =>
        Math.max(
          0,
          n -
            snapshot.filter((x) => target.has(x.id) && x.readAt == null).length,
        ),
      );
      try {
        const { error } = await supabase.rpc("mark_notifications_read", {
          p_ids: ids,
        });
        if (error) {
          setItems(snapshot);
          void refreshBadge();
        }
      } catch {
        // audit-1 P1-14: PostgREST THROWS on network failure (the
        // refreshBadge comment documents exactly this) — the optimistic
        // mark-read must roll back here as well, not only on {error}.
        setItems(snapshot);
        void refreshBadge();
      }
    },
    [supabase, refreshBadge],
  );

  const markAllRead = useCallback(async () => {
    // Cursor = highest SEEN seq so rows arriving mid-click are not silently
    // marked read before being rendered (RPC contract, PLAN §4.1).
    const cursor = itemsRef.current[0]?.seq;
    if (cursor == null) return;
    const now = new Date().toISOString();
    const snapshot = itemsRef.current;
    setItems((prev) =>
      prev.map((n) => (n.seq <= cursor && n.readAt == null ? { ...n, readAt: now } : n)),
    );
    setUnreadCount((n) =>
      Math.max(
        0,
        n - snapshot.filter((x) => x.seq <= cursor && x.readAt == null).length,
      ),
    );
    try {
      const { error } = await supabase.rpc("mark_notifications_read_before", {
        p_seq: cursor,
      });
      if (error) {
        setItems(snapshot);
        void refreshBadge();
      }
    } catch {
      // Same throw-path rollback as markRead (audit-1 P1-14).
      setItems(snapshot);
      void refreshBadge();
    }
  }, [supabase, refreshBadge]);

  const teardown = useCallback(() => {
    const ch = channelRef.current;
    channelRef.current = null;
    if (ch) void supabase.removeChannel(ch);
  }, [supabase]);

  const ensureSubscribed = useCallback(() => {
    if (channelRef.current || !visibleRef.current) return;
    const channel = supabase
      .channel(`notif:${userId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `recipient_id=eq.${userId}`,
        },
        (msg) => handleInsert((msg as unknown as { new: RawNotificationRow }).new),
      )
      .subscribe((status) => {
        // Functional updates: the callback can fire long after this closure
        // was created, so it must transition from the CURRENT health, never a
        // value captured at subscribe time (audit-3 H-F3).
        if (status === "SUBSCRIBED") {
          setHealthy((current) => nextHealth(current, "subscribed"));
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setHealthy((current) => nextHealth(current, "channel_error"));
        } else if (status === "CLOSED") {
          setHealthy((current) => nextHealth(current, "channel_closed"));
        }
      });
    channelRef.current = channel;
  }, [supabase, userId, handleInsert]);

  // Mount: subscribe + lifecycle listeners. StrictMode-safe: cleanup tears
  // the channel down fully so the remount converges to one live subscription.
  useEffect(() => {
    ensureSubscribed();

    const onVisibility = () => {
      const nextVisible = !document.hidden;
      visibleRef.current = nextVisible;
      // audit-3 H-F3: this state flip is what re-runs the poll effect below.
      // The old handler was one-shot: it refreshed + resubscribed, but the
      // poll effect (deps [healthy, refresh]) never re-ran, so a hook that
      // MOUNTED while hidden never scheduled the loop at all — and a tab
      // resume could not start it either.
      setVisible(nextVisible);
      if (nextVisible) {
        // Returning from a hidden gap: the channel was torn down, so the
        // previous health is stale. Downgrade to the fast cadence until
        // SUBSCRIBED re-confirms (realtime has no replay; polling heals).
        setHealthy((current) => nextHealth(current, "resumed"));
        void refresh();
        ensureSubscribed();
      } else {
        teardown();
      }
    };
    const onFocus = () => {
      if (!document.hidden) void refresh();
    };
    const { data: authSub } = supabase.auth.onAuthStateChange((event) => {
      // A slept tab can attempt a channel join with an expired JWT; after a
      // refresh, resubscribe with the fresh token. Polling covers the gap.
      if (event === "TOKEN_REFRESHED" && !document.hidden) {
        teardown();
        ensureSubscribed();
      }
    });

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      authSub.subscription.unsubscribe();
      teardown();
    };
  }, [supabase, userId, ensureSubscribed, teardown, refresh]);

  // Poll cadence follows channel health AND visibility. Self-rescheduling
  // timeout so the cadence (incl. the E2E test seam) is re-read every tick,
  // not frozen at effect creation.
  //
  // audit-3 H-F3: the effect must be scheduled whenever the tab is visible —
  // including on the FIRST visibilitychange after a hidden mount. Keying the
  // early return on `visible` state (not the ref) is what makes the resume
  // re-run the effect and start the loop.
  useEffect(() => {
    if (!visible) return;
    let timer: ReturnType<typeof setTimeout>;
    const loop = () => {
      timer = setTimeout(() => {
        void refresh();
        loop();
      }, effectivePollMs(healthy));
    };
    loop();
    return () => clearTimeout(timer);
  }, [healthy, refresh, visible]);

  return {
    items,
    unreadCount,
    healthy,
    loadingMore,
    hasMore,
    refresh,
    loadMore,
    markRead,
    markAllRead,
  };
}
