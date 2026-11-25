import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./features.css";
import "./polish.css";
import "./workspace.css";
import "./modern.css";
import "./workflows.css";

export const metadata: Metadata = {
  title: "Finance Atlas",
  description: "A private workspace for your accounts, transactions and savings."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
