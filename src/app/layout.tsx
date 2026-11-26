import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { headers } from "next/headers";
import "@/styles/globals.css";
import "@/styles/components.css";
import { Navbar } from "@/components/layout/Navbar";
import { ToastProvider } from "@/components/ui/Toast";
import { NONCE_HEADER } from "@/lib/csp";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: { default: "STELLAR — On-Chain Rotating Savings on Stellar", template: "%s | STELLAR" },
  description:
    "Join or create trustless savings circles (Ajo/Esusu) powered by Stellar Soroban smart contracts and USDC.",
  keywords: ["ajo", "esusu", "savings", "stellar", "soroban", "usdc", "nigeria", "defi"],
  openGraph: {
    title: "STELLAR — On-Chain Rotating Savings",
    description: "Trustless Ajo/Esusu savings circles on Stellar.",
    url: "https://stellar.app",
    siteName: "STELLAR",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "STELLAR",
    description: "Trustless rotating savings on Stellar.",
  },
  // Allow mobile browsers to resize the viewport when the software keyboard opens.
  // This is the primary mechanism that ensures the bottom tab bar slides out of view
  // when an input field has focus and the keyboard is visible.
  viewport: {
    width: "device-width",
    initialScale: 1,
    interactiveWidget: "resizes-visual",
  },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The middleware generates a fresh nonce for every request and forwards it here
  // via the x-nonce response header so we can embed it in the HTML.  Any <script>
  // tag that carries this nonce is permitted by the CSP; all other inline scripts
  // are blocked.
  const headerStore = await headers();
  const nonce = headerStore.get(NONCE_HEADER) ?? "";

  return (
    <html lang="en" className={inter.variable}>
      <body>
        <ToastProvider nonce={nonce}>
          <Navbar nonce={nonce} />
          <main>{children}</main>
        </ToastProvider>
      </body>
    </html>
  );
}
