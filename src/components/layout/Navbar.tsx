import Link from "next/link";
import styles from "./Navbar.module.css";

export function Navbar() {
  return (
    <header className={styles.header}>
      <nav className={`container ${styles.nav}`} aria-label="Main navigation">
        <Link href="/" className={styles.logo} aria-label="STELLAR home">
          <span className={styles.logoMark}>S</span>
          <span className={styles.logoText}>STELLAR</span>
        </Link>
        <ul className={styles.links} role="list">
          <li>
            <Link href="/circles" className={styles.link}>
              Browse Circles
            </Link>
          </li>
          <li>
            <Link href="/dashboard" className={styles.link}>
              Dashboard
            </Link>
          </li>
          <li>
            <Link href="/auth/login" className="btn btn--primary btn--sm">
              Sign In
            </Link>
          </li>
        </ul>
      </nav>
    </header>
  );
}
