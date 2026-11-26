"use client";

import { lazy, Suspense } from "react";
import styles from "./CircleChat.module.css";

const CircleChat = lazy(() =>
  import("./CircleChat").then((mod) => ({ default: mod.CircleChat }))
);

interface LazyCircleChatProps {
  circleId: string;
  isActiveMember: boolean;
  currentUserId: string;
}

/** Skeleton shown while the CircleChat chunk is being fetched. */
function ChatSkeleton() {
  return (
    <div className={styles.outerContainer} aria-busy="true" aria-label="Loading circle chat">
      <div className={styles.chatColumn}>
        <div className={styles.loading}>
          <span className={styles.spinner} aria-hidden="true" />
          Loading chat…
        </div>
      </div>
    </div>
  );
}

export function LazyCircleChat({ circleId, isActiveMember, currentUserId }: LazyCircleChatProps) {
  return (
    <Suspense fallback={<ChatSkeleton />}>
      <CircleChat
        circleId={circleId}
        isActiveMember={isActiveMember}
        currentUserId={currentUserId}
      />
    </Suspense>
  );
}
