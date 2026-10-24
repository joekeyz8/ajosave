import type { Metadata } from "next";
import { CreateCircleWizard } from "@/components/circle/CreateCircleWizard";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Create a Circle" };

export default function CreateCirclePage() {
  return (
    <div className={styles.page}>
      <div className={`container container--sm ${styles.inner}`}>
        <CreateCircleWizard />
      </div>
    </div>
  );
}
